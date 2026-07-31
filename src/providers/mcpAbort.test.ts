// Regression guard for the two-part bug where pressing Stop during MCP setup poisoned the session.
//
// Part one: connect()/listAllTools() recorded an AbortError as `unreachable: ...` per server, which
// reached both the header badge and - via the MCP roster - the system prompt.
// Part two: once that was fixed, LlmProvider memoised the *rejected* probe promise, so every later
// query rethrew the same AbortError. The transport filters AbortError as an expected cancel, so the
// assistant went silently dead for the rest of the session.
//
// These are driven through the public surface (connect/listAllTools, and query) rather than by
// reaching into private state, so they keep holding if the internals are reorganised.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AssistantSettings, QueryContext } from "../model/provider";
import { LlmProvider } from "./llmProvider";
import { McpClient } from "./mcpClient";

const MCP_URL = "http://mcp.test/mcp";
const LLM_URL = "http://llm.test/v1";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A request that never resolves on its own, and rejects the moment its signal aborts. */
function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
    return new Promise((_resolve, reject) => {
        const fail = () => reject(new DOMException("Aborted", "AbortError"));
        if (!signal) return;
        if (signal.aborted) return fail();
        signal.addEventListener("abort", fail, { once: true });
    });
}

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A minimal OpenAI-compatible SSE completion. */
function sseCompletion(text: string): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Answers a healthy MCP handshake, tool list, and chat completion. */
function healthyResponse(url: string, init: RequestInit): Response {
    if (!url.startsWith(MCP_URL)) return sseCompletion("hello");
    const method = JSON.parse(String(init.body)).method;
    if (method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Docs Server" } } });
    if (method === "tools/list") return json({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "docs_search" }] } });
    return json({ jsonrpc: "2.0", result: {} });
}

describe("McpClient abort handling", () => {
    it("rejects rather than recording a cancel as a per-server failure", async () => {
        globalThis.fetch = ((_url: string, init: RequestInit) => hangUntilAborted(init.signal)) as typeof fetch;

        const client = new McpClient([MCP_URL, "http://other.test/mcp"]);
        const controller = new AbortController();
        const connecting = client.connect(controller.signal);
        controller.abort();

        await assert.rejects(connecting, (err: Error) => err.name === "AbortError");
        // The badge and the MCP roster both read this; a cancel must not invent a diagnosis.
        assert.deepEqual(client.getErrors(), [undefined, undefined]);
    });

    it("still records a genuine per-server failure without rejecting", async () => {
        globalThis.fetch = (async (url: string) =>
            url.startsWith(MCP_URL) ? new Response("nope", { status: 503 }) : json({})) as unknown as typeof fetch;

        const client = new McpClient([MCP_URL]);
        await client.connect();
        assert.match(client.getErrors()[0]!, /unreachable: .*503/);
    });
});

describe("LlmProvider probe cache after a cancelled MCP setup", () => {
    const settings: AssistantSettings = {
        model: "test-model",
        data: { baseURL: LLM_URL, mcpServers: [MCP_URL] },
    };
    const context: QueryContext = { attachments: [], settings };

    it("does not cache the rejected probe, so the next query still works", async () => {
        const provider = new LlmProvider();

        // First query: Stop pressed while the MCP handshake is in flight.
        globalThis.fetch = ((_url: string, init: RequestInit) => hangUntilAborted(init.signal)) as typeof fetch;
        const controller = new AbortController();
        const first = provider.query(context, "hello", () => { }, controller.signal);
        controller.abort();
        await assert.rejects(first, (err: Error) => err.name === "AbortError");

        // Second query: everything healthy. Before the fix this rethrew the memoised AbortError.
        globalThis.fetch = (async (url: string, init: RequestInit) => healthyResponse(url, init)) as unknown as typeof fetch;
        let streamed = "";
        const second = await provider.query(context, "hello again", (text) => { streamed = text; });

        assert.equal(second.success, true, JSON.stringify(second.error));
        assert.equal(streamed, "hello");
        // The re-probe also has to have actually reconnected, not just avoided throwing.
        assert.deepEqual(provider.getMcpStatus([{ url: MCP_URL }]).map((s) => s.connected), [true]);
    });
});
