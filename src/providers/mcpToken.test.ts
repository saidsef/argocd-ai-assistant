// The Argo CD token from the token flow reaches only the MCP servers whose entry sets `token: true`.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { McpClient } from "./mcpClient";
import { LlmProvider } from "./llmProvider";

const ARGOCD_URL = "http://argocd-mcp.test/mcp";
const DOCS_URL = "http://docs.test/mcp";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A one-tool MCP server at each URL that records the Authorization header of every request. */
function servers() {
    const seen: Array<{ url: string; method: string; auth?: string }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        seen.push({ url, method: body.method, auth: (init.headers as Record<string, string>)["Authorization"] });
        if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "s" } } });
        if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup" }] } });
        if (body.method === "tools/call") return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } });
        return json({ jsonrpc: "2.0", id: body.id, result: {} });
    }) as unknown as typeof fetch;
    return seen;
}

describe("MCP token opt-in", () => {
    it("sends the token on every request to an opted-in server, and never to the others", async () => {
        const seen = servers();
        const client = new McpClient([{ url: ARGOCD_URL, token: true }, { url: DOCS_URL }]);
        client.setAuthToken("secret");
        await client.connect();
        await client.listAllTools();
        await client.callTool(0, "lookup", {});
        await client.callTool(1, "lookup", {});

        const argocd = seen.filter((r) => r.url === ARGOCD_URL);
        assert.deepEqual(argocd.map((r) => r.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
        assert.ok(argocd.every((r) => r.auth === "Bearer secret"), "the handshake carries the token too");
        assert.ok(seen.filter((r) => r.url === DOCS_URL).every((r) => r.auth === undefined));
    });

    it("rebuilds the connection when a server's opt-in changes", async () => {
        const seen = servers();
        const provider = new LlmProvider();
        await provider.warmUpMcp([{ url: ARGOCD_URL }], "secret");
        assert.ok(seen.every((r) => r.auth === undefined));

        seen.length = 0;
        await provider.warmUpMcp([{ url: ARGOCD_URL, token: true }], "secret");
        assert.equal(seen[0]?.method, "initialize");
        assert.ok(seen.every((r) => r.auth === "Bearer secret"));
    });
});
