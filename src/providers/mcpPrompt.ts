// Everything MCP contributes to the system prompt.
//
// Two distinct blocks, and the difference matters:
//
//  - the *roster* lists every configured server for reference. It is present whenever MCP is
//    configured, so the assistant can answer "which servers are available?" instead of saying its
//    context contains no information about MCP. Nothing in it is callable.
//  - the *tool block* lists the tools of the server(s) the user actually named, with schemas and
//    the calling syntax. Only these can be invoked, and only on this turn.
//
// Kept pure and separate from LlmProvider so the wording - which is the entire mechanism here - can
// be exercised directly.

import { McpServerStatus, mcpState } from "../model/provider";
import { capText, MAX_MCP_ROSTER_CHARS } from "../util/context";
import { McpTool } from "./mcpClient";
import { exampleArgs } from "./toolCall";

// Tool names beyond this are summarised as a count. The count still answers "how many tools does X
// have?"; listing 200 names on every request would not answer anything the count does not.
const MAX_ROSTER_TOOL_NAMES = 20;

// Server names and tool names arrive from a remote `initialize` / `tools/list` response, and the
// roster puts them in the *system* message of every request - the highest-trust position in the
// prompt, and one the user has not opted into per-server the way the tool block requires. Strip
// anything that could restructure the prompt (newlines, control characters) and bound the length.
export const MAX_SERVER_NAME_CHARS = 64;
const MAX_ERROR_CHARS = 200;

export function clean(value: string | undefined, max: number): string {
    return (value ?? "")
        // Control characters and newlines are the injection risk: they would let a remote-supplied
        // name restructure the prompt it is embedded in. Backticks are stripped because a handle is
        // rendered as a markdown code span in the welcome bubble and would otherwise close it.
        //
        // Nothing else is removed. Underscores in particular must survive: tool names here are the
        // exact strings the model is told to call and parseToolCall matches on, so mangling
        // `docs_fetch_docs` into `docsfetchdocs` would advertise a name that can never work.
        .replace(/[\p{C}\s]+/gu, " ")
        .replace(/`/g, "")
        .trim()
        .slice(0, max);
}

/**
 * The host of a configured server URL. Never the URL itself, which may carry `user:pass@` or a
 * query token and is shown to the user and sent to the model.
 *
 * Falls back through a scheme-less retry (`docs.example.com/mcp` is a plausible thing to configure)
 * and then a hand-rolled host extraction, because the previous `catch { return url }` handed back
 * the very string this function exists to avoid.
 */
export function hostnameOf(url: string): string {
    for (const candidate of [url, `https://${url}`]) {
        try {
            const host = new URL(candidate).hostname;
            if (host) return host;
        } catch { /* try the next form */ }
    }
    return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0].split("@").pop() ?? "";
}

/** As hostnameOf, but keeping a non-default port - the tiebreak when two servers share a host. */
function hostPortOf(url: string): string {
    try {
        const u = new URL(url);
        return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
        return hostnameOf(url);
    }
}

// Words that identify no particular server. Dropped while deriving a handle so `docs-mcp-server`
// becomes `docs` rather than `docs-mcp-server`, and so a bare `api.example.com` yields nothing
// distinctive and falls back to its hostname instead of turning "api" into an invocation.
const FILLER = new Set([
    "mcp", "server", "servers", "service", "services", "svc", "api", "apis",
    "tool", "tools", "www", "http", "https", "local", "internal", "cluster", "default",
]);

// A handle has to survive containsWord as a whole word, and short words collide with ordinary Argo
// CD questions ("the api server is failing").
const MIN_HANDLE_CHARS = 4;

/**
 * The short name a user types to address a server.
 *
 * An explicitly configured name wins outright. Otherwise the first distinctive word of the
 * server-reported name, else of the hostname's *first label only* - tokenising the whole hostname
 * would turn `api.example.com` into "example", which names nothing. When nothing distinctive
 * survives, the hostname itself is the handle.
 */
export function deriveHandle(configured: string | undefined, reported: string | undefined, url: string): string {
    const explicit = clean(configured, MAX_SERVER_NAME_CHARS);
    if (explicit) return explicit;

    const host = hostnameOf(url);
    for (const source of [clean(reported, MAX_SERVER_NAME_CHARS), host.split(".")[0]]) {
        const word = source
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .find(t => t.length >= MIN_HANDLE_CHARS && !FILLER.has(t));
        if (word) return word;
    }
    return clean(host, MAX_SERVER_NAME_CHARS);
}

/**
 * Handles for a whole set of servers, guaranteed distinct.
 *
 * Uniqueness cannot be decided per server, so it is decided here: a candidate two servers both want
 * is given to neither, and each falls back to its first unique rung. Telling the user to type
 * something that addresses two servers at once is worse than telling them to type a hostname - it
 * silently merges both tool sets, and a tool name present on both routes to whichever was configured
 * first. Servers configured with the *same* URL are genuinely the same server, so they are allowed
 * to share a handle rather than being given an invented suffix.
 */
export function resolveHandles(servers: Array<{ configured?: string; reported?: string; url: string }>): string[] {
    const rungs = servers.map(s => [
        deriveHandle(s.configured, s.reported, s.url),
        clean(hostnameOf(s.url), MAX_SERVER_NAME_CHARS),
        clean(hostPortOf(s.url), MAX_SERVER_NAME_CHARS),
        clean(s.url, MAX_SERVER_NAME_CHARS),
    ].filter(Boolean));

    const claims = new Map<string, Set<number>>();
    rungs.forEach((candidates, i) => {
        for (const c of candidates) {
            if (!claims.has(c)) claims.set(c, new Set());
            claims.get(c)!.add(i);
        }
    });
    // Two entries for one URL produce identical rungs; that is not a real collision.
    const sameUrlGroups = new Map<string, number>();
    servers.forEach(s => sameUrlGroups.set(s.url, (sameUrlGroups.get(s.url) ?? 0) + 1));
    const unique = (candidate: string, i: number) => {
        const holders = claims.get(candidate)!;
        if (holders.size === 1) return true;
        return [...holders].every(j => servers[j].url === servers[i].url);
    };

    // The positional last resort exists only so `handle` is never empty - every rung would have to
    // be blank, which parseMcpServers already prevents by dropping empty URLs.
    return rungs.map((candidates, i) => candidates.find(c => unique(c, i)) ?? candidates[0] ?? `server-${i + 1}`);
}

/**
 * Everything that addresses a server in a message: its resolved handle, its reported name, its
 * hostname and the hostname's first label.
 *
 * The handle is what the assistant advertises; the rest are kept so the hostname and reported-name
 * forms documented before it existed keep working. A candidate under 2 characters is dropped - too
 * short to match a word reliably - and a *first label* under MIN_HANDLE_CHARS is dropped for the
 * same reason `api.example.com` derives no handle.
 */
export function serverHandles(status: Pick<McpServerStatus, "handle" | "name" | "url">): string[] {
    const host = hostnameOf(status.url);
    const label = host.split(".")[0];
    const candidates = [
        status.handle,
        status.name,
        host,
        hostPortOf(status.url),
        label !== host && label.length >= MIN_HANDLE_CHARS ? label : undefined,
    ];
    return [...new Set(candidates.filter((h): h is string => !!h && h.length >= 2))];
}

/**
 * The reference list of configured MCP servers, appended to the system prompt whenever any are
 * configured - addressed or not.
 *
 * `addressed` holds the server indices whose tools are callable this turn; their tool names are
 * omitted here because the tool block below repeats them in full with schemas, and two lists of the
 * same names invites the model to treat the wrong one as authoritative.
 */
export function mcpRoster(servers: McpServerStatus[], tools: McpTool[], addressed: Set<number>): string {
    if (servers.length === 0) return "";

    const lines = servers.map((s, i) => {
        // The handle leads the line, because it is the string the user types and the string the
        // assistant must quote back at them. The reported name and host follow only when they add
        // something, so a server whose handle was shortened (or pushed to its hostname by a
        // collision) is still identifiable.
        const name = clean(s.name, MAX_SERVER_NAME_CHARS);
        const host = clean(hostnameOf(s.url), MAX_SERVER_NAME_CHARS);
        const shownName = name === s.handle ? "" : name;
        const shownHost = host === s.handle || host === name ? "" : host;
        const detail = [shownName, shownName && shownHost ? `at ${shownHost}` : shownHost]
            .filter(Boolean)
            .join(" ");
        const where = detail ? ` (${detail})` : "";

        const state = mcpState(s);
        const status = state === "unavailable"
            ? `unavailable: ${clean(s.error, MAX_ERROR_CHARS)}`
            : state === "connected" ? "connected" : "configured, not connected yet";

        const names = tools.filter(t => t.serverIndex === i).map(t => clean(t.name, MAX_SERVER_NAME_CHARS));
        let toolPart: string;
        if (addressed.has(i)) {
            toolPart = "tools listed in full below";
        } else if (names.length === 0) {
            // Never "this server has no tools": a failed discovery wipes the cached tool list, so a
            // server that exposed 14 tools a moment ago would be reported as having none.
            toolPart = "tools not discovered yet";
        } else {
            const shown = names.slice(0, MAX_ROSTER_TOOL_NAMES).join(", ");
            const rest = names.length - MAX_ROSTER_TOOL_NAMES;
            toolPart = `${names.length} ${names.length === 1 ? "tool" : "tools"}: ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`;
        }

        return `- ${s.handle}${where} - ${status} - ${toolPart}`;
    });

    const anyAddressed = addressed.size > 0;
    // The addressing rule is stated with the list rather than only in the guidance below, so a model
    // that quotes a server back to the user quotes the name they can actually type.
    const header = anyAddressed
        ? "\n\nMCP servers configured for this conversation. Each is addressed by the name at the start of its line:\n"
        : "\n\nMCP servers configured for this conversation, each addressed by the name at the start of its line (reference only - no tool can be called in this reply):\n";

    // The cap bounds the *list* - the part that grows with the deployment. Capping the block as a
    // whole kept the start, so a large enough deployment silently dropped the guidance off the end,
    // losing exactly the instructions that stop the model emitting an uncallable tool block.
    return capText(header + lines.join("\n"), MAX_MCP_ROSTER_CHARS, "the MCP server list") + "\n" + guidance(anyAddressed);
}

// The "complete set" sentence used to live in DEFAULT_SYSTEM_PROMPT, where it was sent even by
// deployments with no MCP at all - describing an attachment that was not there. It belongs with the
// list it describes, which is emitted only when servers are configured, and it now survives a
// `systemPrompt` override (which previously discarded it).
const COMPLETE_SET = `This list is complete: answer in prose which servers exist, their state and which tools they expose, and never say you have no information about MCP.`;

function guidance(anyAddressed: boolean): string {
    if (anyAddressed) {
        return `
Only the tools under "Available tools:" below can be called in this reply; they belong to the server(s) named in the conversation. Naming any other tool in a tool block will not run it, and the user will see the raw text instead of an answer.
${COMPLETE_SET}`;
    }
    // The header already says "reference only - no tool can be called in this reply", so this opens
    // with the instruction rather than repeating the state.
    return `
Do not output a <tool> block or any tool-call JSON: nothing will execute it and the user's question will go unanswered.
- ${COMPLETE_SET}
- Refer to a tool only by the name shown. Do not state what it does, what arguments it takes, or what it returns - that is not given here.
- If answering needs a tool, ask the user to include that server's name - exactly as written at the start of its line above - in their next message, then answer as far as you can without it.`;
}

/**
 * The callable tool block, for the server(s) named in the conversation. Grouped by server so the
 * model can attribute a result to one; tool names are reproduced exactly, because that is what
 * parseToolCall matches on.
 */
export function toolPrompt(tools: McpTool[], serverName: (index: number) => string): string {
    let text = "\n\nAvailable tools:\n";
    for (const index of [...new Set(tools.map(t => t.serverIndex))]) {
        const group = tools.filter(t => t.serverIndex === index);
        if (group.length === 0) continue;
        text += `\nFrom the ${clean(serverName(index), MAX_SERVER_NAME_CHARS)} server:\n`;
        for (const tool of group) {
            text += `- ${tool.name}: ${tool.description || "No description"}\n`;
            if (tool.inputSchema) {
                text += `  Arguments schema: ${JSON.stringify(tool.inputSchema)}\n`;
            }
        }
    }
    text += "\nTo use a tool, output a tool block using an EXACT tool name from the list above:\n";
    text += '<tool name="EXACT_TOOL_NAME">\n{ JSON arguments matching that tool\'s schema }\n</tool>\n';
    text += `For example:\n<tool name="${tools[0].name}">\n${exampleArgs(tools[0])}\n</tool>\n`;
    text += "Always wrap the arguments in the <tool>...</tool> tags with the exact tool name; never output bare JSON. A brief sentence before the block is allowed. If the request does not require a tool, answer directly without one.";
    return text;
}

/**
 * Sent back to the model after it emitted a tool block that nothing could run, to get a real answer
 * out of the retry. The block itself is never shown to the user: `<tool>` is not an allowed tag, so
 * the sanitiser drops the element but keeps its text, leaving a bare JSON blob where the answer
 * should be.
 */
export function noToolNote(attempted: string | undefined, hadTools: boolean): string {
    const lead = hadTools
        ? `That tool block did not run: ${attempted ? `"${attempted}" is not` : "the name given was not"} one of the tools listed under "Available tools:".`
        : "That tool block did not run, and the user did not see it: no tool is callable in this reply.";
    return `${lead} No tool ran, so you have no tool output - do not imply what one would have returned. Answer the original question directly, in prose, using only the context already provided. Do not output a tool block or any tool-call JSON. If the question genuinely needs an MCP tool, name the server that would provide it and ask the user to include that server's name in their next message.`;
}

/** What to say when the model tried to use a tool and there was none, naming a handle that works. */
export function noToolFallback(servers: McpServerStatus[]): string {
    const usable = servers.find(s => mcpState(s) === "connected") ?? servers[0];
    return usable
        ? `I tried to use a tool, but none was available for this message. Include a server name in your question - for example "${usable.handle}, ..." - and I can use its tools.`
        : "I tried to use a tool, but none was available for this message.";
}
