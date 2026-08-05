import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpServerStatus } from "../model/provider";
import { clean, deriveHandle, hostnameOf, MAX_SERVER_NAME_CHARS, mcpRoster, resolveHandles, serverHandles } from "./mcpPrompt";
import type { McpTool } from "./mcpClient";

describe("mcpRoster", () => {
    const servers = (n: number): McpServerStatus[] =>
        Array.from({ length: n }, (_v, i) => ({
            url: `https://srv${i}.example.com/mcp`,
            name: `srv${i}`,
            handle: `srv${i}`,
            connected: true,
            toolCount: 40,
        }));
    // Enough tool names per server to push a large deployment's list past the roster cap.
    const tools = (n: number): McpTool[] =>
        Array.from({ length: n * 40 }, (_v, i) => ({
            name: `a_long_enough_tool_name_${i}`,
            serverIndex: Math.floor(i / 40),
        }));

    it("carries the complete-set instruction that used to sit in the system prompt", () => {
        // Moved out of DEFAULT_SYSTEM_PROMPT so it is sent only when servers are configured. It has
        // to appear whether or not the user addressed one, since "which servers are available?" is
        // asked from both states.
        for (const addressed of [new Set<number>(), new Set([0])]) {
            const roster = mcpRoster(servers(2), tools(2), addressed);
            assert.match(roster, /This list is complete/);
            assert.match(roster, /never say you have no information about MCP/);
        }
    });

    it("conditions the complete-set instruction on the user asking about MCP", () => {
        // Unconditional, it read as a standing instruction and the model prefaced every answer with
        // the server inventory. Both halves have to be present in both states.
        for (const addressed of [new Set<number>(), new Set([0])]) {
            const roster = mcpRoster(servers(2), tools(2), addressed);
            assert.match(roster, /when the user asks about MCP/);
            assert.match(roster, /do not recite it/);
        }
    });

    it("keeps the guidance when a large deployment truncates the list", () => {
        // The cap used to apply to the list and the guidance together, and capText keeps the start -
        // so a deployment big enough to hit it dropped the instructions that stop the model emitting
        // an uncallable tool block, exactly when the most servers were in play.
        const roster = mcpRoster(servers(12), tools(12), new Set<number>());
        assert.match(roster, /\[truncated: /, "the list is still capped");
        assert.match(roster, /never say you have no information about MCP/);
        assert.match(roster, /no tool can be called in this reply/);
    });

    it("is empty when nothing is configured", () => {
        assert.equal(mcpRoster([], [], new Set<number>()), "");
    });
});

describe("clean", () => {
    it("collapses control characters and newlines, which could restructure the prompt", () => {
        assert.equal(clean("a\nb\tc", 64), "a b c");
        assert.equal(clean("  spaced  ", 64), "spaced");
        assert.equal(clean("a\u0000b", 64), "a b");
    });

    it("strips backticks, which would close the markdown code span in the welcome bubble", () => {
        assert.equal(clean("do`cs", 64), "docs");
    });

    it("keeps underscores, because tool names are matched literally", () => {
        // Mangling docs_fetch_docs would advertise a name parseToolCall can never match.
        assert.equal(clean("docs_fetch_docs", 64), "docs_fetch_docs");
    });

    it("bounds the length and tolerates undefined", () => {
        assert.equal(clean("abcdef", 3), "abc");
        assert.equal(clean(undefined, 10), "");
    });
});

describe("hostnameOf", () => {
    it("extracts the host and never returns credentials or a query token", () => {
        assert.equal(hostnameOf("https://docs.example.com/mcp"), "docs.example.com");
        assert.equal(hostnameOf("https://user:pass@docs.example.com/mcp?token=secret"), "docs.example.com");
    });

    it("handles a scheme-less configuration", () => {
        assert.equal(hostnameOf("docs.example.com/mcp"), "docs.example.com");
    });

    it("strips the port, which the roster reports separately", () => {
        assert.equal(hostnameOf("https://host.example.com:8080/x"), "host.example.com");
    });

    it("never leaks credentials or a query token, even on the hand-rolled fallback path", () => {
        // The whole point of this function: the previous `catch { return url }` handed back exactly
        // the string it exists to avoid. Unparseable input must still lose everything sensitive.
        const out = hostnameOf("not a url://user:pass@host/x?token=secret");
        assert.ok(!out.includes("pass"), out);
        assert.ok(!out.includes("secret"), out);
        assert.ok(!out.includes("?"), out);
    });
});

describe("deriveHandle", () => {
    it("prefers an explicitly configured name", () => {
        assert.equal(deriveHandle("pinned", "Reported Name", "https://docs.example.com"), "pinned");
    });

    it("takes the first distinctive word of the reported name", () => {
        assert.equal(deriveHandle(undefined, "Docs MCP Server", "https://x.example.com"), "docs");
    });

    it("skips filler words that identify no particular server", () => {
        assert.equal(deriveHandle(undefined, "MCP Server Gitlab", "https://x.example.com"), "gitlab");
    });

    it("uses only the hostname's first label, never a later one", () => {
        // Tokenising the whole hostname would turn api.example.com into "example", which names nothing.
        assert.equal(deriveHandle(undefined, undefined, "https://api.example.com"), "api.example.com");
        assert.equal(deriveHandle(undefined, undefined, "https://gitlab.example.com"), "gitlab");
    });

    it("rejects words shorter than the minimum, which would collide with ordinary questions", () => {
        assert.equal(deriveHandle(undefined, "ci", "https://ci.example.com"), "ci.example.com");
    });
});

describe("resolveHandles", () => {
    it("gives distinct handles to distinct servers", () => {
        const handles = resolveHandles([
            { reported: "Docs Server", url: "https://docs.example.com/mcp" },
            { reported: "Gitlab Server", url: "https://gitlab.example.com/mcp" },
        ]);
        assert.deepEqual(handles, ["docs", "gitlab"]);
    });

    it("gives a contested candidate to neither, falling through to a unique rung", () => {
        // Telling the user to type a string that addresses two servers silently merges both tool sets.
        const handles = resolveHandles([
            { reported: "Docs Server", url: "https://a.example.com/mcp" },
            { reported: "Docs Server", url: "https://b.example.com/mcp" },
        ]);
        assert.notEqual(handles[0], handles[1]);
        assert.deepEqual(handles, ["a.example.com", "b.example.com"]);
    });

    it("lets two entries for the same URL share a handle, since they are the same server", () => {
        const handles = resolveHandles([
            { reported: "Docs", url: "https://a.example.com/mcp" },
            { reported: "Docs", url: "https://a.example.com/mcp" },
        ]);
        assert.deepEqual(handles, ["docs", "docs"]);
    });

    it("uses the port to break a same-host collision", () => {
        const handles = resolveHandles([
            { url: "https://host.example.com:8080/mcp" },
            { url: "https://host.example.com:9090/mcp" },
        ]);
        assert.notEqual(handles[0], handles[1]);
    });

    it("never returns an empty handle", () => {
        for (const h of resolveHandles([{ url: "https://a.example.com" }, { url: "https://b.example.com" }])) {
            assert.ok(h.length > 0);
            assert.ok(h.length <= MAX_SERVER_NAME_CHARS);
        }
    });
});

describe("serverHandles", () => {
    it("accepts the handle, the reported name and the hostname forms", () => {
        const handles = serverHandles({ handle: "docs", name: "Docs Server", url: "https://docs.example.com/mcp" });
        assert.ok(handles.includes("docs"));
        assert.ok(handles.includes("Docs Server"));
        assert.ok(handles.includes("docs.example.com"));
    });

    it("drops a first label too short to match reliably", () => {
        // "ci" as a bare word would fire on ordinary Argo CD questions ("the ci pipeline failed").
        const handles = serverHandles({ handle: "ci.example.com", name: "ci.example.com", url: "https://ci.example.com/mcp" });
        assert.ok(!handles.includes("ci"), JSON.stringify(handles));
    });

    it("keeps a first label long enough to be distinctive", () => {
        const handles = serverHandles({ handle: "gitlab", name: "gitlab", url: "https://gitlab.example.com/mcp" });
        assert.ok(handles.includes("gitlab.example.com"), JSON.stringify(handles));
    });

    it("de-duplicates when the handle equals the hostname", () => {
        const handles = serverHandles({ handle: "a.example.com", name: "a.example.com", url: "https://a.example.com" });
        assert.equal(new Set(handles).size, handles.length);
    });
});
