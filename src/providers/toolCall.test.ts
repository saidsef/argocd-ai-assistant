import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { argsFitSchema, exampleArgs, extractJsonObject, parseToolCall, parseToolCalls, ToolSpec } from "./toolCall";

const SEARCH: ToolSpec = {
    name: "docs_search",
    inputSchema: { properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
};
const FETCH: ToolSpec = {
    name: "docs_fetch",
    inputSchema: { properties: { url: { type: "string" } }, required: ["url"] },
};

describe("parseToolCall - XML form", () => {
    it("parses a tool block with a preamble", () => {
        const call = parseToolCall('Sure, let me look.\n<tool name="docs_search">{"query":"argo"}</tool>', [SEARCH]);
        assert.deepEqual(call, { name: "docs_search", arguments: { query: "argo" } });
    });

    it("ignores a block naming a tool that is not available", () => {
        // This is what stops the prompt's own name="EXACT_TOOL_NAME" template being run, and what
        // stops <tool> syntax quoted inside a normal answer from firing.
        assert.equal(parseToolCall('<tool name="EXACT_TOOL_NAME">{}</tool>', [SEARCH]), null);
        assert.equal(parseToolCall('<tool name="other">{}</tool>', [SEARCH]), null);
        assert.equal(parseToolCall('<tool name="docs_search">{}</tool>', undefined), null);
    });

    it("parses a block wrapped in a model's own tool-call sentinel", () => {
        // A chat template with a native tool-call channel emits the block inside its sentinel
        // tokens. Without this the tool never ran and the raw tag reached the user.
        const call = parseToolCall('<｜｜DSML｜｜tool name="docs_search">\n{"query":"argo"}\n</｜｜DSML｜｜tool>', [SEARCH]);
        assert.deepEqual(call, { name: "docs_search", arguments: { query: "argo" } });
    });

    it("does not treat an ordinary element as the tool tag", () => {
        assert.equal(parseToolCall('<mytool name="docs_search">{"query":"a"}</mytool>', [SEARCH]), null);
    });

    it("falls back to empty arguments when the body is not valid JSON", () => {
        const call = parseToolCall('<tool name="docs_search">not json</tool>', [SEARCH]);
        assert.deepEqual(call, { name: "docs_search", arguments: {} });
    });
});

describe("parseToolCall - bare JSON fallback", () => {
    it("accepts an explicitly named call", () => {
        const call = parseToolCall('{"name":"docs_search","arguments":{"query":"argo"}}', [SEARCH]);
        assert.deepEqual(call, { name: "docs_search", arguments: { query: "argo" } });
    });

    it("accepts the alternate key spellings models emit", () => {
        for (const key of ["args", "input", "parameters"]) {
            const call = parseToolCall(`{"tool":"docs_search","${key}":{"query":"a"}}`, [SEARCH]);
            assert.deepEqual(call, { name: "docs_search", arguments: { query: "a" } });
        }
    });

    it("infers the tool from the argument shape when exactly one fits", () => {
        assert.deepEqual(parseToolCall('{"query":"argo"}', [SEARCH, FETCH]), {
            name: "docs_search",
            arguments: { query: "argo" },
        });
    });

    it("refuses to guess when more than one tool fits", () => {
        const a: ToolSpec = { name: "a", inputSchema: { properties: { q: { type: "string" } }, required: ["q"] } };
        const b: ToolSpec = { name: "b", inputSchema: { properties: { q: { type: "string" } }, required: ["q"] } };
        assert.equal(parseToolCall('{"q":"x"}', [a, b]), null);
    });

    it("ignores incidental JSON followed by prose", () => {
        // A real bare-JSON call ends the turn. Prose after the object means it was an example.
        assert.equal(parseToolCall('{"query":"argo"} - that is the shape you would use.', [SEARCH]), null);
    });

    it("tolerates a trailing code fence", () => {
        assert.deepEqual(parseToolCall('```json\n{"query":"argo"}\n```', [SEARCH]), {
            name: "docs_search",
            arguments: { query: "argo" },
        });
    });

    it("returns null for plain prose", () => {
        assert.equal(parseToolCall("Your Deployment is out of sync.", [SEARCH]), null);
        assert.equal(parseToolCall("", [SEARCH]), null);
    });
});

describe("parseToolCalls - several calls in one reply", () => {
    it("returns every block, in order", () => {
        const text = [
            "I will run both.",
            '<tool name="docs_search">{"query":"a"}</tool>',
            'and then',
            '<tool name="docs_fetch">{"url":"http://x"}</tool>',
        ].join("\n");
        assert.deepEqual(parseToolCalls(text, [SEARCH, FETCH]), [
            { name: "docs_search", arguments: { query: "a" } },
            { name: "docs_fetch", arguments: { url: "http://x" } },
        ]);
    });

    it("keeps the available tools and drops the rest", () => {
        const text = '<tool name="nope">{}</tool><tool name="docs_search">{"query":"a"}</tool>';
        assert.deepEqual(parseToolCalls(text, [SEARCH]), [{ name: "docs_search", arguments: { query: "a" } }]);
    });

    it("collapses an identical repeated call", () => {
        const text = '<tool name="docs_search">{"query":"a"}</tool><tool name="docs_search">{"query":"a"}</tool>';
        assert.equal(parseToolCalls(text, [SEARCH]).length, 1);
    });

    it("keeps the same tool called with different arguments", () => {
        const text = '<tool name="docs_search">{"query":"a"}</tool><tool name="docs_search">{"query":"b"}</tool>';
        assert.deepEqual(parseToolCalls(text, [SEARCH]).map(c => c.arguments.query), ["a", "b"]);
    });

    it("never falls through to the JSON heuristic once a block is present", () => {
        // The block named no available tool. Reading the example object after it as a call would
        // fire a tool the model did not ask for.
        assert.deepEqual(parseToolCalls('<tool name="nope">{"query":"a"}</tool>', [SEARCH]), []);
    });

    it("still recovers a single bare-JSON call when there is no block", () => {
        assert.deepEqual(parseToolCalls('{"query":"argo"}', [SEARCH]), [
            { name: "docs_search", arguments: { query: "argo" } },
        ]);
    });

    it("parseToolCall returns the first of several", () => {
        const text = '<tool name="docs_search">{"query":"a"}</tool><tool name="docs_fetch">{"url":"u"}</tool>';
        assert.deepEqual(parseToolCall(text, [SEARCH, FETCH]), { name: "docs_search", arguments: { query: "a" } });
    });

    it("returns an empty list for prose", () => {
        assert.deepEqual(parseToolCalls("All healthy.", [SEARCH]), []);
    });
});

describe("extractJsonObject", () => {
    it("finds a brace-balanced object amid prose and reports where it ends", () => {
        const found = extractJsonObject('before {"a":{"b":1}} after');
        assert.deepEqual(found?.value, { a: { b: 1 } });
        assert.equal('before {"a":{"b":1}}'.length, found?.end);
    });

    it("ignores braces inside strings, including escaped quotes", () => {
        assert.deepEqual(extractJsonObject('{"a":"}{"}')?.value, { a: "}{" });
        assert.deepEqual(extractJsonObject('{"a":"say \\" }"}')?.value, { a: 'say " }' });
    });

    it("returns null when there is no object or it never closes", () => {
        assert.equal(extractJsonObject("no braces here"), null);
        assert.equal(extractJsonObject('{"a":1'), null);
        assert.equal(extractJsonObject("{not json}"), null);
    });
});

describe("argsFitSchema", () => {
    it("requires every key to be known and every required prop to be present", () => {
        const schema = SEARCH.inputSchema;
        assert.equal(argsFitSchema(["query"], schema), true);
        assert.equal(argsFitSchema(["query", "limit"], schema), true);
        assert.equal(argsFitSchema(["limit"], schema), false, "missing a required prop");
        assert.equal(argsFitSchema(["query", "nope"], schema), false, "unknown prop");
        assert.equal(argsFitSchema([], schema), false);
    });

    it("is false for a schema declaring no properties", () => {
        assert.equal(argsFitSchema(["a"], undefined), false);
        assert.equal(argsFitSchema(["a"], { properties: {} }), false);
    });
});

describe("exampleArgs", () => {
    it("uses the required props, typed by their schema type", () => {
        assert.equal(exampleArgs(SEARCH), '{"query":"value"}');
        assert.equal(
            exampleArgs({ name: "t", inputSchema: { properties: { n: { type: "integer" }, b: { type: "boolean" } }, required: ["n", "b"] } }),
            '{"n":1,"b":true}'
        );
    });

    it("falls back to the first property when nothing is required", () => {
        assert.equal(exampleArgs({ name: "t", inputSchema: { properties: { only: { type: "string" } } } }), '{"only":"value"}');
        assert.equal(exampleArgs({ name: "t" }), "{}");
    });
});
