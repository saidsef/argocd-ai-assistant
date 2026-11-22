// Everything MCP adds to the system prompt. A roster lists every configured server, which the model
// can describe but not call. A tool block lists the built-in tools and the tools of each server the
// user named, which it can call. See docs/architecture.md#mcp-servers.

import { McpServerStatus, mcpState, ToolCallingMode } from "../model/provider";
import { capText, DATA_RULE, dataBlock, MAX_MCP_ROSTER_CHARS } from "../util/context";
import { BUILT_IN_SERVER } from "./builtInTools";
import { McpTool } from "./mcpClient";
import { exampleArgs } from "./toolCall";

/**
 * Tool names beyond this are summarised as a count, which answers the same questions as a list of
 * every name.
 */
const MAX_ROSTER_TOOL_NAMES = 20;

/** Bounds for remote-supplied names and errors, which go into the system message of every request. */
export const MAX_SERVER_NAME_CHARS = 64;
const MAX_ERROR_CHARS = 200;

/**
 * A remote-supplied name or message made safe for the prompt. Control characters and newlines
 * become spaces, because they could restructure the prompt. Backticks go, because a handle is shown
 * in a code span. `_` stays, because the model must call each tool by its exact name.
 */
export function clean(value: string | undefined, max: number): string {
    return (value ?? "")
        .replace(/[\p{C}\s]+/gu, " ")
        .replace(/`/g, "")
        .trim()
        .slice(0, max);
}

/**
 * The host of a configured server URL. Never the URL itself, which may carry `user:pass@` or a
 * query token and is shown to the user and sent to the model.
 *
 * A URL without a scheme, such as `docs.example.com/mcp`, is parsed again with `https://`, and one
 * that still fails falls back to a hand-rolled host extraction. See #123.
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

/**
 * Words that do not identify a particular server. Deriving a handle drops them, which turns
 * `docs-mcp-server` into `docs`. A bare `api.example.com` then falls back to its hostname rather
 * than turning "api" into an invocation.
 */
const FILLER = new Set([
    "mcp", "server", "servers", "service", "services", "svc", "api", "apis",
    "tool", "tools", "www", "http", "https", "local", "internal", "cluster", "default",
]);

/**
 * A handle has to survive containsWord as a whole word, and short words collide with ordinary Argo
 * CD questions ("the api server is failing").
 */
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
 * configured, whether or not the user named one.
 *
 * `addressed` holds the indices of the servers whose tools are callable this turn. Their tool names
 * are left out here, because the tool block repeats them with schemas. Two lists of the same names
 * invite the model to trust the wrong one.
 */
export function mcpRoster(servers: McpServerStatus[], tools: McpTool[], addressed: Set<number>, mode: ToolCallingMode = "text", builtIns = false): string {
    if (servers.length === 0) return "";

    const lines = servers.map((s, i) => {
        // The handle leads the line, because users type it and the assistant quotes it. A reported
        // name or host that differs follows it, which keeps a shortened handle identifiable.
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
            toolPart = mode === "native" ? "tools attached to this request" : "tools listed in full below";
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
        : `\n\nMCP servers configured for this conversation, each addressed by the name at the start of its line (reference only - ${builtIns ? "their tools cannot" : "no tool can"} be called in this reply):\n`;

    // Only the list is capped, because it grows with each deployment, and the guidance after it
    // must survive. See #132.
    return capText(header + lines.join("\n"), MAX_MCP_ROSTER_CHARS, "the MCP server list") + "\n" + guidance(anyAddressed, mode, builtIns);
}

/**
 * Sent with the list rather than in DEFAULT_SYSTEM_PROMPT. Deployments without MCP then never see
 * it, and a `systemPrompt` override keeps it. The second sentence stops the model reciting the list
 * in every reply. See #132.
 */
const COMPLETE_SET = `This list is complete: when the user asks about MCP, answer from it in prose - which servers exist, their state and which tools they expose - and never say you have no information about MCP. When they ask anything else, do not recite it: no preamble, aside or closing note about which servers are attached or how many tools they have.`;

/** Only an MCP server's tools need the server's name in the message, so the rules say whose tools are attached. */
function guidance(anyAddressed: boolean, mode: ToolCallingMode, builtIns: boolean): string {
    const owners = builtIns
        ? "are the built-in Argo CD tools and those of the server(s) named in the conversation"
        : "belong to the server(s) named in the conversation";
    if (anyAddressed && mode === "native") {
        return `
Only the functions attached to this request can be called in this reply. They ${owners}.
${COMPLETE_SET}`;
    }
    if (anyAddressed) {
        return `
Only the tools under "Available tools:" below can be called in this reply; they ${owners}. Naming any other tool in a tool block will not run it, and the user will see the raw text instead of an answer.
${COMPLETE_SET}`;
    }
    if (builtIns) {
        return `
Only the built-in Argo CD tools can be called in this reply. An MCP server's tools need the server's name in the user's message.
- ${COMPLETE_SET}
- Refer to an MCP tool only by the name shown. Do not state what it does, what arguments it takes, or what it returns - that is not given here.
- If answering needs an MCP tool, ask the user to include that server's name - exactly as written at the start of its line above - in their next message, then answer as far as you can without it.`;
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
 * Stated with the results, because that is where a fabricated fact can arrive with a tool's
 * authority. A paraphrase can misstate a fetched page, which is why the model quotes the sentence
 * it relies on.
 */
export const QUOTE_RULE = "Quote the sentence that answers the question rather than paraphrasing it.";

const RESULTS_RULE = `Answer from tool results and the context already provided. Use only what the results contain - do not extrapolate. If they do not answer the question, say so. ${QUOTE_RULE}`;

/**
 * The persona accepts "the context does not show this" as an answer. A short reply reaches for it
 * even when an attached tool could supply the missing value, such as the current time.
 */
export const FILL_GAP_RULE = "When the context lacks something an attached tool can supply, call the tool instead of saying it is missing.";

/**
 * The callable tool block, for the server(s) named in the conversation. Grouping by server lets the
 * model attribute a result to one. Tool names are reproduced exactly, because parseToolCall matches
 * on them.
 */
export function toolPrompt(tools: McpTool[], serverName: (index: number) => string, maxCalls: number, mode: ToolCallingMode = "text"): string {
    // The request's `tools` carries each name, description and schema, so only the rules remain.
    if (mode === "native") {
        return `\n\nCall a function when the question needs one, and answer directly when it does not. ${FILL_GAP_RULE} Several calls in one reply are fine for independent lookups. At most ${maxCalls} tool${maxCalls === 1 ? "" : "s"} will run for this question, and calls beyond that are not executed. ${RESULTS_RULE}`;
    }
    let text = "\n\nAvailable tools:\n";
    for (const index of [...new Set(tools.map(t => t.serverIndex))]) {
        const group = tools.filter(t => t.serverIndex === index);
        if (group.length === 0) continue;
        text += index === BUILT_IN_SERVER
            ? "\nBuilt-in Argo CD tools, which read the Application the user has open:\n"
            : `\nFrom the ${clean(serverName(index), MAX_SERVER_NAME_CHARS)} server:\n`;
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
    text += `Always wrap the arguments in the <tool>...</tool> tags with the exact tool name; never output bare JSON. A brief sentence before the block is allowed. If the request does not require a tool, answer directly without one. ${FILL_GAP_RULE}\n`;
    // Stating the budget is what makes batching safe to invite: a question needing three lookups
    // becomes one round trip instead of three, and the model knows where the ceiling is.
    text += `You may emit more than one block in a reply when a question needs several independent lookups; at most ${maxCalls} tool${maxCalls === 1 ? "" : "s"} will run for this question, and blocks beyond that are not executed.`;
    return text;
}

/** A tool's output as the model sees it, in a block that its own content cannot close. */
export function toolResult(name: string, output: string): string {
    return dataBlock("tool_result", { name: clean(name, MAX_SERVER_NAME_CHARS) }, output);
}

/** The note for a tool that failed. The error is the server's own text, so it gets a block too. */
export function toolErrorNote(name: string, error: string): string {
    const block = dataBlock("tool_result", { name: clean(name, MAX_SERVER_NAME_CHARS), status: "error" }, error);
    return `The tool ${name} could not be run and returned nothing. The error it reported:\n${block}`;
}

/** The user message that hands text-protocol tool results back to the model. */
export function resultsNote(notes: string[]): string {
    const plural = notes.length > 1;
    return `${notes.join("\n\n")}\n\n${DATA_RULE} Answer the original question from ${plural ? "these results" : "this result"} and the context already provided. Use only what ${plural ? "they contain" : "it contains"} - do not extrapolate. If ${plural ? "they do" : "it does"} not answer the question, say so. ${QUOTE_RULE}`;
}

/**
 * Bound on the server-supplied error text in a failure notice. It fits a short message, but not a
 * whole HTML error page.
 */
export const MAX_NOTICE_DETAIL_CHARS = 200;

/**
 * The line shown to the user when a tool does not run, so a broken server is distinguishable from
 * the model choosing not to search.
 *
 * Both halves are remote-supplied - the name from `tools/list`, the detail from whatever the server
 * returned - so each is flattened and bounded by `clean`: a newline or a backtick would otherwise
 * break out of the blockquote and code span this renders as.
 */
export function toolFailureNotice(name: string, detail: string): string {
    return `> ⚠ \`${clean(name, MAX_SERVER_NAME_CHARS)}\` could not be run: ${clean(detail, MAX_NOTICE_DETAIL_CHARS)}`;
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
