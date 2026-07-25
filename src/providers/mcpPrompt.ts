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
const MAX_NAME_CHARS = 64;
const MAX_ERROR_CHARS = 200;

function clean(value: string | undefined, max: number): string {
    return (value ?? "").replace(/[\p{C}\s]+/gu, " ").trim().slice(0, max);
}

// A short label for a server before it reports its own name. Never the full URL: getMcpStatus
// carries the configured URL verbatim, which may hold `user:pass@` or a query token.
export function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

/**
 * The strings that address a server in a message: its reported name, its hostname, and the
 * hostname's first label.
 *
 * Shared by the roster (which tells the user how to address a server) and by the matcher (which
 * decides whether they did). Deriving them twice would let the roster advertise a handle the
 * matcher rejects.
 *
 * Two are dropped. A handle under 2 characters is too short to match a word reliably. A *first
 * label* under 4 characters is usually a generic infrastructure word - `api.example.com` would
 * otherwise make "api" mean "call that server", and "the API server is failing" is a normal Argo CD
 * question. The full hostname and the reported name are kept whatever their length.
 */
export function serverHandles(name: string | undefined, url: string): string[] {
    const host = hostnameOf(url);
    const label = host.split(".")[0];
    const handles = [name, host, label !== host && label.length >= 4 ? label : undefined];
    return handles.filter((h): h is string => !!h && h.length >= 2);
}

/**
 * The handle to *show*, as opposed to the handles that match.
 *
 * The first single-word one, which is normally the reported name and otherwise the hostname. A
 * server free-texting its name ("Docs MCP Server", or something adversarial) would otherwise have
 * the assistant instruct the user to type a whole sentence. Matching still accepts every handle from
 * serverHandles, so a user who does type the full name is still understood.
 */
function preferredHandle(status: McpServerStatus): string {
    const handles = serverHandles(status.name, status.url).map(h => clean(h, MAX_NAME_CHARS));
    return handles.find(h => !/\s/.test(h)) ?? handles[0] ?? "";
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
        const name = clean(s.name, MAX_NAME_CHARS);
        const host = hostnameOf(s.url);
        // Only when it adds something: an unnamed server already shows its hostname as its name.
        const where = clean(host, MAX_NAME_CHARS) === name ? "" : ` (${clean(host, MAX_NAME_CHARS)})`;

        const state = mcpState(s);
        const status = state === "unavailable"
            ? `unavailable: ${clean(s.error, MAX_ERROR_CHARS)}`
            : state === "connected" ? "connected" : "configured, not connected yet";

        const handle = preferredHandle(s);
        const names = tools.filter(t => t.serverIndex === i).map(t => clean(t.name, MAX_NAME_CHARS));
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
            toolPart = `${names.length} tools: ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`;
        }

        return `- ${name}${where} - ${status} - address it as "${handle}" - ${toolPart}`;
    });

    const anyAddressed = addressed.size > 0;
    const header = anyAddressed
        ? "\n\nMCP servers configured for this conversation:\n"
        : "\n\nMCP servers configured for this conversation (reference only - no tool can be called in this reply):\n";

    return capText(header + lines.join("\n") + "\n" + guidance(anyAddressed), MAX_MCP_ROSTER_CHARS, "the MCP server list");
}

function guidance(anyAddressed: boolean): string {
    if (anyAddressed) {
        return `
Only the tools under "Available tools:" below can be called in this reply; they belong to the server(s) named in the conversation. Every other tool above is listed for reference only - putting one of those names in a tool block will not run it, and the user will see the raw text instead of an answer.`;
    }
    return `
The list above is background information, not a set of callable tools, and there is no way to run one in this reply. Do not output a <tool> block, a tool-call JSON object, or any other invocation syntax: nothing will execute it and the user's question will go unanswered.
- If the user asks which MCP servers or tools are available, answer from the list above in prose.
- Refer to a tool only by the name shown. Do not state what it does, what arguments it takes, or what it returns - that is not given here.
- If answering properly needs a tool, say so, name the server that has it, and ask the user to include that server's name in their next message. Then answer as far as you can without it.`;
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
        text += `\nFrom the ${clean(serverName(index), MAX_NAME_CHARS)} server:\n`;
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
    return `${lead} Answer the original question directly, in prose, using only the context already provided. Do not output a tool block or any tool-call JSON. If the question genuinely needs an MCP tool, name the server that would provide it and ask the user to include that server's name in their next message.`;
}

/** What to say when the model tried to use a tool and there was none, naming a handle that works. */
export function noToolFallback(servers: McpServerStatus[]): string {
    const usable = servers.find(s => mcpState(s) === "connected") ?? servers[0];
    return usable
        ? `I tried to use a tool, but none was available for this message. Include a server name in your question - for example "${preferredHandle(usable)}, ..." - and I can use its tools.`
        : "I tried to use a tool, but none was available for this message.";
}
