// The tool loop on the wire: a fake Chat Completions backend and a fake MCP server, driven through
// LlmProvider.query, with every completion request recorded.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { QueryContext } from "../model/provider";
import { LlmProvider } from "./llmProvider";

const MCP_URL = "http://mcp.test/mcp";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Each test gets its own backend, because the provider remembers text-only backends per base URL.
let backends = 0;
const freshBaseUrl = () => `http://llm${++backends}.test/v1`;

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A streamed completion made of the given `choices[0]` chunks. */
function sse(chunks: any[]): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [chunk] })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const text = (content: string) => () => sse([{ delta: { role: "assistant" } }, { delta: { content }, finish_reason: "stop" }]);

/** Native tool calls, each with its arguments split across two chunks. */
const calls = (list: Array<{ id: string; name: string; args: string; extra?: object }>) => () => sse([
    ...list.flatMap((c, index) => [
        { delta: { tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: "" }, ...c.extra }] } },
        { delta: { tool_calls: [{ index, function: { arguments: c.args.slice(0, 4) } }] } },
        { delta: { tool_calls: [{ index, function: { arguments: c.args.slice(4) } }] } },
    ]),
    { delta: {}, finish_reason: "tool_calls" },
]);

const rejected = (message: string) => () => new Response(JSON.stringify({ error: { message } }), { status: 400 });

/** Serves one scripted response per completion request, and a one-tool MCP server. */
function backend(steps: Array<(body: any) => Response>) {
    const requests: any[] = [];
    const toolCalls: any[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (String(url).startsWith(MCP_URL)) {
            if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "Docs Server" } } });
            if (body.method === "tools/list") {
                return json({
                    jsonrpc: "2.0", id: body.id, result: {
                        tools: [{ name: "docs_search", description: "Search the docs", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
                    },
                });
            }
            if (body.method === "tools/call") {
                toolCalls.push(body.params);
                return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `result for ${body.params.arguments.query}` }] } });
            }
            return json({ jsonrpc: "2.0", id: body.id, result: {} });
        }
        requests.push(body);
        const step = steps[requests.length - 1];
        if (!step) throw new Error(`unexpected completion request ${requests.length}`);
        return step(body);
    }) as unknown as typeof fetch;
    return { requests, toolCalls };
}

function contextFor(baseURL: string, toolCalling?: string): QueryContext {
    return { attachments: [], settings: { model: "test-model", data: { baseURL, mcpServers: [MCP_URL], toolCalling } } };
}

async function ask(context: QueryContext, prompt = "docs, what is a sync wave?", provider = new LlmProvider()) {
    let streamed = "";
    const response = await provider.query(context, prompt, (t) => { streamed = t; });
    return { response, streamed };
}

describe("native tool calls", () => {
    it("sends the tools, runs the call and answers its id", async () => {
        const wire = backend([calls([{ id: "call_1", name: "docs_search", args: '{"query":"sync waves"}' }]), text("Sync waves order resources.")]);
        const { response, streamed } = await ask(contextFor(freshBaseUrl()));

        assert.equal(response.success, true, JSON.stringify(response.error));
        assert.equal(streamed, "Sync waves order resources.");
        assert.deepEqual(wire.requests[0].tools.map((t: any) => t.function.name), ["docs_search"]);
        assert.equal(wire.requests[0].tool_choice, undefined);
        assert.doesNotMatch(wire.requests[0].messages[0].content, /Available tools:/);
        assert.deepEqual(wire.toolCalls, [{ name: "docs_search", arguments: { query: "sync waves" } }]);

        const sent = wire.requests[1].messages;
        assert.deepEqual(sent.slice(-2), [
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "docs_search", arguments: '{"query":"sync waves"}' } }] },
            { role: "tool", tool_call_id: "call_1", content: "result for sync waves" },
        ]);
    });

    it("sends each call back with the fields the backend added", async () => {
        const extra = { extra_content: { google: { thought_signature: "sig" } } };
        const wire = backend([calls([{ id: "call_1", name: "docs_search", args: '{"query":"a"}', extra }]), text("ok")]);
        await ask(contextFor(freshBaseUrl()));
        assert.deepEqual(wire.requests[1].messages.at(-2).tool_calls[0].extra_content, extra.extra_content);
    });

    it("answers a call it cannot run, without running it", async () => {
        const wire = backend([
            calls([
                { id: "unknown", name: "nope", args: "{}" },
                { id: "broken", name: "docs_search", args: '{"query":' },
            ]),
            text("ok"),
        ]);
        const { streamed } = await ask(contextFor(freshBaseUrl()));

        assert.deepEqual(wire.toolCalls, []);
        const replies = wire.requests[1].messages.filter((m: any) => m.role === "tool");
        assert.deepEqual(replies.map((m: any) => m.tool_call_id), ["unknown", "broken"]);
        assert.match(replies[0].content, /not available/);
        assert.match(replies[1].content, /not valid JSON/);
        assert.match(streamed, /`nope` could not be run: it is not available/);
    });

    it("forbids calls on the final pass and drops any that still arrive", async () => {
        const call = (q: string) => calls([{ id: `call_${q}`, name: "docs_search", args: `{"query":"${q}"}` }]);
        const wire = backend([call("a"), call("b"), call("c"), call("d")]);
        const { response, streamed } = await ask(contextFor(freshBaseUrl()));

        assert.equal(response.success, true);
        assert.deepEqual(wire.toolCalls.map(c => c.arguments.query), ["a", "b", "c"]);
        assert.deepEqual(wire.requests.map(r => r.tool_choice), [undefined, undefined, undefined, "none"]);
        assert.match(streamed, /couldn't complete that request/);
    });

    it("offers no tools when no server is named", async () => {
        const wire = backend([text("A sync wave orders resources.")]);
        await ask(contextFor(freshBaseUrl()), "what is a sync wave?");
        assert.equal(wire.requests[0].tools, undefined);
    });

    it("never sends tools when the setting asks for text", async () => {
        const wire = backend([text("ok")]);
        await ask(contextFor(freshBaseUrl(), "text"));
        assert.equal(wire.requests[0].tools, undefined);
        assert.match(wire.requests[0].messages[0].content, /Available tools:/);
    });
});

describe("fallback to the text protocol", () => {
    it("retries without tools and remembers the backend", async () => {
        const baseURL = freshBaseUrl();
        const wire = backend([
            rejected('"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set'),
            text('<tool name="docs_search">{"query":"x"}</tool>'),
            text("answer"),
            text("second answer"),
        ]);
        const { response, streamed } = await ask(contextFor(baseURL));

        assert.equal(response.success, true, JSON.stringify(response.error));
        assert.equal(streamed, "answer");
        assert.ok(wire.requests[0].tools);
        assert.equal(wire.requests[1].tools, undefined);
        assert.match(wire.requests[1].messages[0].content, /Available tools:/);
        assert.deepEqual(wire.toolCalls, [{ name: "docs_search", arguments: { query: "x" } }]);

        // A new provider, as after a remount, still skips the failed attempt.
        await ask(contextFor(baseURL));
        assert.equal(wire.requests.length, 4);
        assert.equal(wire.requests[3].tools, undefined);
    });

    it("does not blame the tools for a 400 the retry also gets", async () => {
        const baseURL = freshBaseUrl();
        const wire = backend([rejected("context length exceeded"), rejected("context length exceeded"), text("ok")]);
        const { response } = await ask(contextFor(baseURL));

        assert.equal(response.success, false);
        assert.equal(response.error?.status, 400);
        await ask(contextFor(baseURL));
        assert.ok(wire.requests[2].tools, "the next query tries native calls again");
    });

    it("rewrites the exchange when tools are rejected partway through", async () => {
        const wire = backend([
            calls([{ id: "call_1", name: "docs_search", args: '{"query":"a"}' }]),
            rejected("tool messages are not supported"),
            text("final"),
        ]);
        const { response, streamed } = await ask(contextFor(freshBaseUrl()));

        assert.equal(response.success, true, JSON.stringify(response.error));
        assert.equal(streamed, "final");
        const sent = wire.requests[2];
        assert.equal(sent.tools, undefined);
        assert.ok(sent.messages.every((m: any) => m.role !== "tool" && !m.tool_calls));
        assert.match(sent.messages[0].content, /Available tools:/);
        assert.equal(sent.messages.at(-2).content, '<tool name="docs_search">{"query":"a"}</tool>');
        assert.match(sent.messages.at(-1).content, /^Tool result for docs_search:\nresult for a/);
    });
});
