import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../model/provider";
import type { McpTool } from "./mcpClient";
import { createToolCallAccumulator, parseArguments, toChatTools, toolCallingSetting, toolsRejected, toTextMessages } from "./nativeTools";

describe("toChatTools", () => {
    it("rewrites names a provider would reject and maps them back", () => {
        const tools: McpTool[] = [
            { name: "docs.search/v2", serverIndex: 0 },
            { name: "x".repeat(80), serverIndex: 0 },
        ];
        const { tools: sent, byName } = toChatTools(tools);
        const names = sent.map(t => t.function.name);
        assert.deepEqual(names, ["docs_search_v2", "x".repeat(64)]);
        assert.equal(byName.get("docs_search_v2"), tools[0]);
        for (const name of names) assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
    });

    it("gives two servers' tools of the same name distinct names", () => {
        const tools: McpTool[] = [{ name: "search", serverIndex: 0 }, { name: "search", serverIndex: 1 }];
        const { tools: sent, byName } = toChatTools(tools);
        assert.deepEqual(sent.map(t => t.function.name), ["search", "search_2"]);
        assert.equal(byName.get("search_2")?.serverIndex, 1);
    });

    it("completes a schema that lacks an object shape", () => {
        const { tools: sent } = toChatTools([
            { name: "a", serverIndex: 0 },
            { name: "b", serverIndex: 0, inputSchema: { properties: { q: { type: "string" } }, required: ["q"] } },
        ]);
        assert.deepEqual(sent[0].function.parameters, { type: "object", properties: {} });
        assert.deepEqual(sent[1].function.parameters, { type: "object", properties: { q: { type: "string" } }, required: ["q"] });
        assert.equal("description" in sent[0].function, false);
    });
});

describe("createToolCallAccumulator", () => {
    it("joins arguments streamed in fragments", () => {
        const acc = createToolCallAccumulator();
        acc.push([{ index: 0, id: "call_1", type: "function", function: { name: "docs_search", arguments: "" } }]);
        acc.push([{ index: 0, function: { arguments: '{"query":' } }]);
        acc.push([{ index: 0, function: { arguments: '"argo"}' } }]);
        assert.deepEqual(acc.calls(), [
            { id: "call_1", type: "function", function: { name: "docs_search", arguments: '{"query":"argo"}' } },
        ]);
    });

    it("keeps fields it does not know, so the call goes back unchanged", () => {
        const acc = createToolCallAccumulator();
        const extra = { google: { thought_signature: "sig" } };
        acc.push([{ index: 0, id: "call_1", type: "function", function: { name: "a", arguments: "{}" }, extra_content: extra }]);
        assert.deepEqual(acc.calls()[0].extra_content, extra);
    });

    it("separates whole calls that arrive without an index", () => {
        const acc = createToolCallAccumulator();
        acc.push([{ id: "a", type: "function", function: { name: "one", arguments: '{"q":1}' } }]);
        acc.push([{ id: "b", type: "function", function: { name: "two", arguments: '{"q":2}' } }]);
        assert.deepEqual(acc.calls().map(c => [c.id, c.function.name, c.function.arguments]), [
            ["a", "one", '{"q":1}'],
            ["b", "two", '{"q":2}'],
        ]);
    });

    it("starts a new call when an index is reused with a new id", () => {
        const acc = createToolCallAccumulator();
        acc.push([{ index: 0, id: "a", function: { name: "one", arguments: "{}" } }]);
        acc.push([{ index: 0, id: "b", function: { name: "two", arguments: "{}" } }]);
        assert.deepEqual(acc.calls().map(c => c.id), ["a", "b"]);
    });

    it("fills in an id, a type and empty arguments", () => {
        const acc = createToolCallAccumulator();
        acc.push([{ index: 0, function: { name: "a" } }]);
        const [call] = acc.calls();
        assert.ok(call.id);
        assert.equal(call.type, "function");
        assert.equal(call.function.arguments, "{}");
    });

    it("ignores a chunk with no tool calls", () => {
        const acc = createToolCallAccumulator();
        acc.push(undefined);
        acc.push(null);
        assert.deepEqual(acc.calls(), []);
    });
});

describe("parseArguments", () => {
    it("reads an object, and treats empty arguments as none", () => {
        assert.deepEqual(parseArguments('{"query":"argo"}'), { value: { query: "argo" } });
        assert.deepEqual(parseArguments(""), { value: {} });
        assert.deepEqual(parseArguments("{}"), { value: {} });
    });

    it("refuses anything that is not a JSON object", () => {
        assert.match(parseArguments('{"query":').error!, /not valid JSON/);
        assert.match(parseArguments("[1]").error!, /not a JSON object/);
    });
});

describe("toolsRejected / toolCallingSetting", () => {
    it("blames the tools only for a 400 or 422", () => {
        assert.equal(toolsRejected(400), true);
        assert.equal(toolsRejected(422), true);
        for (const status of [401, 403, 404, 429, 500, undefined]) assert.equal(toolsRejected(status), false);
    });

    it("reads anything but native or text as auto", () => {
        assert.equal(toolCallingSetting("native"), "native");
        assert.equal(toolCallingSetting("text"), "text");
        for (const value of [undefined, "", "Native", 1]) assert.equal(toolCallingSetting(value), "auto");
    });
});

describe("toTextMessages", () => {
    it("rewrites an exchange as tool blocks and one results note", () => {
        const tool: McpTool = { name: "docs.search", serverIndex: 0 };
        const byName = new Map([["docs_search", tool]]);
        const messages: ChatMessage[] = [
            { role: "user", content: "docs, what is a sync wave?" },
            {
                role: "assistant", content: null, tool_calls: [
                    { id: "c1", type: "function", function: { name: "docs_search", arguments: '{"query":"a"}' } },
                    { id: "c2", type: "function", function: { name: "docs_search", arguments: '{"query":"b"}' } },
                ],
            },
            { role: "tool", tool_call_id: "c1", content: "first" },
            { role: "tool", tool_call_id: "c2", content: "second" },
        ];
        const out = toTextMessages(messages, byName);
        assert.equal(out.length, 3);
        assert.deepEqual(out[0], messages[0]);
        assert.equal(out[1].content, '<tool name="docs.search">{"query":"a"}</tool>\n<tool name="docs.search">{"query":"b"}</tool>');
        assert.equal(out[2].role, "user");
        assert.match(out[2].content!, /^Tool result for docs\.search:\nfirst\n\nTool result for docs\.search:\nsecond\n\nAnswer the original question from these results/);
    });
});
