import { AttachmentType, ChatTurn, McpServerConfig, McpServerStatus, QueryContext, QueryProvider, QueryResponse } from "../model/provider";
import { budgetHistory, capText, MAX_HISTORY_TURN_CHARS, MAX_TOOL_RESULT_CHARS } from "../util/context";
import { readLines, sseData } from "../util/stream";
import { argocdHeaders, bearer, canRouteToProxy, containsWord, errorMessage, mcpConfigured, parseMcpServers } from "../util/util";
import { McpClient, McpTool } from "./mcpClient";
import { clean, hostnameOf, MAX_SERVER_NAME_CHARS, mcpRoster, noToolFallback, noToolNote, resolveHandles, serverHandles, toolFailureNotice, toolPrompt } from "./mcpPrompt";
import { parseToolCalls, TOOL_OPEN } from "./toolCall";
import { createToolMarkerFilter } from "./toolMarker";

// Explain a completion that produced no answer text. `finish_reason` is the only signal the wire
// format gives, and each value points at a different fix - so name it rather than reporting one
// generic "no usable data" for a content filter, a truncation and an incompatible backend alike.
export function emptyReplyMessage(finishReason?: string): string {
    switch (finishReason) {
        case "content_filter":
            return "The LLM backend filtered this response and returned no content. Rephrase the question, or check the backend's content-filter configuration.";
        case "length":
            return "The response was cut off by the backend's output token limit before any content was produced. Reduce the attached context or raise the limit on the backend.";
        case undefined:
        case "":
            return "The LLM backend returned no usable data. It may not be emitting an OpenAI-compatible SSE stream.";
        default:
            return `The LLM backend ended the response (${finishReason}) without producing any content.`;
    }
}

// The user's own most recent previous message, for the two-turn addressing window. Deliberately not
// the last turn of any role: an assistant reply that lists the servers would otherwise address all
// of them (see addressedServers).
function lastUserTurn(history?: ChatTurn[]): string {
    for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
        if (history![i].role === "user") return history![i].content;
    }
    return "";
}

// Same URL list, same order - the identity the cached MCP client and its tools' serverIndex rely on.
// Names are deliberately not part of it: renaming a server in settings must not drop its connection.
function sameUrls(a: string[] | undefined, b: McpServerConfig[]): boolean {
    return !!a && a.length === b.length && a.every((u, i) => u === b[i].url);
}

// Resolve an OpenAI-compatible endpoint from a configured base URL.
//
// Every documented example sets `baseURL` to the provider's OpenAI-compatible root *including* the
// version segment ("https://api.openai.com/v1", "http://ollama:11434/v1"), so appending
// "/v1/chat/completions" produced ".../v1/v1/chat/completions" and a 404. Accept either form: drop
// trailing slashes and one trailing "/v1", then append the full path.
const apiRoot = (baseURL: string): string => baseURL.replace(/\/+$/, "").replace(/\/v1$/i, "");

export function chatCompletionsUrl(baseURL: string): string {
    return `${apiRoot(baseURL)}/v1/chat/completions`;
}

export function modelsUrl(baseURL: string): string {
    return `${apiRoot(baseURL)}/v1/models`;
}

// Model names out of a GET /v1/models body. The wire format is `{data: [{id}]}` for OpenAI, vLLM
// and Ollama alike, but this runs against whatever a deployment points at, so anything that is not
// a non-empty string id is dropped rather than trusted into an error message or a completion.
export function parseModelList(body: any): string[] {
    if (!Array.isArray(body?.data)) return [];
    return body.data
        .map((m: any) => (typeof m === "string" ? m : m?.id))
        .filter((id: any): id is string => typeof id === "string" && id.trim().length > 0);
}

// What to say when the model is unset and /v1/models did not settle it. Both cases point at the
// same fix - put `model` in the settings - but a backend serving several models can name them, and
// copying one out of the message beats going and looking it up.
export function modelChoiceMessage(found: string[]): string {
    return found.length
        ? `The LLM backend serves ${found.length} models, so one has to be chosen: set \`model\` in argocdAssistantSettings to one of ${found.join(", ")}.`
        : "LLM model is not configured, and the backend did not report one to fall back on. Set the model field in argocdAssistantSettings.";
}

// Default persona/instructions prepended to every request. Grounds answers in the
// attached context and keeps replies concise and actionable. Override per-deployment
// via the top-level `systemPrompt` setting.
//
// The accuracy rules are written as checkable prohibitions rather than adjectives. "Be accurate" and
// "be concise" are advice a model can satisfy while still padding an answer with plausible defaults;
// "an absent field is unknown, not default" and "do not restate the question" are rules it either
// followed or did not.
//
// One line per rule, and no line restating the one before it. This text is prepended to every
// request, so redundancy is paid for on each of them - and a prompt that waffles about not waffling
// is a poor instruction. Nothing here describes an attachment that may be absent: the MCP wording
// moved to mcpPrompt.mcpRoster, which is emitted only when servers are actually configured.
export const DEFAULT_SYSTEM_PROMPT = `You are the Argo CD AI Assistant: an expert in Argo CD, Kubernetes and GitOps, helping users troubleshoot the resources they manage with Argo CD.

Accuracy:
- No guessing. Every claim must come from the attached context or a tool result; if it does not, say what is missing and what would answer it.
- No assuming. An absent field is unknown, not default - never fill a gap with a convention or what is usually true.
- No lying. Never invent names, namespaces, images, tags, revisions, field values, events or log lines, and never invent kubectl/argocd flags or API fields - describe the action instead. Never claim to have run a command or queried the cluster.
- No waffling. Lead with the answer. No preamble, no restating the question, no unasked-for background, no closing summary. If two sentences answer it, write two.
- Mark an inference as an inference; never present one as observed fact.
- Say when you cannot tell: "the context does not show this, I would need X" is a complete answer.
- A \`[truncated: ...]\` marker means you are reading a fragment - do not infer from what is missing.
- Name a contradiction between sources instead of silently picking one.
- Quote values exactly as they appear; do not reformat or tidy them.

Answering:
- Cite the fields, conditions or events you reason from.
- An "Argo CD Application" summary (a distilled \`argocd app get\`) may be attached - use it for source/chart, sync, health and deployment questions.
- Prefer concrete kubectl/argocd commands and remediation steps over explanation.
- Reply in Markdown; put commands, manifests and log excerpts in fenced code blocks with a language tag.`;

// Max tools the model may run within one query, whether it asks for them one per reply or several
// at once. Bounds latency/cost and guarantees termination in at most MAX_TOOL_ITERATIONS + 1
// completions (the final one is forced tool-free).
const MAX_TOOL_ITERATIONS = 3;

// Per-result cap when one reply runs several tools, so a batch cannot crowd out the manifest, logs
// and history that share the same context window.
const MAX_BATCH_RESULT_CHARS = Math.floor(MAX_TOOL_RESULT_CHARS / 2);

// Abort a stream that goes silent for this long (measured between bytes, not total), so a stalled
// or dropped backend surfaces a clear error instead of spinning the typing indicator forever. Kept
// generous to tolerate slow first tokens / cold model starts.
const STREAM_INACTIVITY_MS = 45000;

export class LlmProvider implements QueryProvider {

    private mcpClient?: McpClient;
    private mcpTools?: McpTool[];
    // The URL list the cached client was built for, so a settings change invalidates it.
    private mcpUrls?: string[];
    // Per-server failure reason from the last connect/discovery attempt, surfaced on the UI badge so
    // a silently tool-free answer is explained rather than just logged to the console.
    private mcpErrors: (string | undefined)[] = [];
    // Set when at least one server failed, so the next query re-runs connect/discovery instead of
    // caching that failure for the session. Without it a partial failure (server A healthy, B down)
    // was sticky: the tool list was non-empty, so the cache was kept and B never re-probed.
    private mcpNeedsReprobe = false;
    // The in-flight (or settled) connect+discovery, shared by the mount warm-up and any query that
    // starts while it is still running, so a server is only ever handshaked once per probe.
    private mcpReady?: Promise<void>;
    // The rendered "Available tools:" prompt block, keyed by the tool names it was built from.
    // Re-serialising every tool's JSON schema on every request is pure waste.
    private toolPromptCache?: { key: string; text: string };
    // What GET /v1/models last reported, keyed by the base URL it was asked. Discovery only runs
    // when `model` is unset, and the answer does not change mid-session, so one request covers it.
    private modelCache?: { baseURL: string; models: string[] };

    // Live status of the configured MCP servers. Before the first query the client has not
    // connected, so this reports the URL hostname / not-connected / 0 tools; after a query it
    // upgrades to the server-reported name and discovered tools.
    //
    // The single place a server's `handle` is decided. It has to be: the handle must be unique
    // across the whole set, which no per-server helper can know, and every surface - badge, welcome
    // message, prompt roster, tool block, error fallback, and the matcher itself - reads it from
    // here, so none of them can advertise a name the others do not recognise. Names are sanitised
    // here too, because both the badge and the welcome bubble render them.
    getMcpStatus(servers: McpServerConfig[]): McpServerStatus[] {
        const infos = this.mcpClient?.getServerInfos();
        const errors = this.mcpErrors;
        const handles = resolveHandles(servers.map((s, i) => ({
            configured: s.name,
            reported: infos?.[i]?.name,
            url: s.url,
        })));
        return servers.map((server, i) => ({
            url: server.url,
            name: clean(infos?.[i]?.name || hostnameOf(server.url), MAX_SERVER_NAME_CHARS),
            handle: handles[i],
            connected: !!infos && infos[i] != null,
            toolCount: (this.mcpTools ?? []).filter(t => t.serverIndex === i).length,
            error: errors[i],
        }));
    }

    // The MCP servers the user has addressed by name, so a normal question never triggers a tool
    // call. A server is addressed when one of its handles (see serverHandles) appears as a whole
    // word in the current message or in the one immediately before it - the two-turn window is what
    // makes "use docs" followed by "now find X" work, without letting an addressing drift down the
    // whole conversation.
    //
    // `previousPrompt` must be the user's own previous message and nothing else. Assistant replies
    // routinely name every server now that the roster exists ("the configured servers are docs,
    // gitlab, github"), so matching against one would advertise every server's tools on every turn
    // after the first question about MCP - which is exactly the opt-in this function implements.
    /**
     * Connect and discover tools, at most once for any number of concurrent callers.
     *
     * The returned promise is memoised in `mcpReady`, and that is the whole point rather than an
     * optimisation: the warm-up and the user's first message can overlap, and without it the query
     * would see no client yet, build a second McpClient and `initialize` every server again. A
     * server holding a live session may reject the duplicate handshake, which would flap a healthy
     * server to "unavailable". It also absorbs React StrictMode's double-invoked mount effect.
     *
     * Never rejects for an MCP failure - a broken server must not break the assistant - so callers
     * read the outcome from `this.mcpTools` / `getMcpStatus` afterwards. A user abort still
     * propagates. Note that a query joining a probe the warm-up started cannot cancel the handshake
     * itself; Stop takes effect on the completion that follows it.
     */
    private ensureMcp(
        servers: McpServerConfig[],
        mcpToken: string | undefined,
        signal?: AbortSignal,
        onStatus?: (label: string | null) => void
    ): Promise<void> {
        // Discard the cached client when a previous attempt had a failing server, or when the
        // configured URL list has changed (tool `serverIndex` values are positions in that list, so a
        // stale client would route a call to the wrong server). Rebuilt from scratch rather than
        // re-handshaked: a server holding a live session may reject a second `initialize`, which
        // would flap a healthy server into "unavailable".
        if (this.mcpNeedsReprobe || !sameUrls(this.mcpUrls, servers)) {
            this.mcpClient = undefined;
            this.mcpTools = undefined;
            this.mcpUrls = undefined;
            this.mcpNeedsReprobe = false;
            this.mcpReady = undefined;
        }
        // Whether or not a probe is needed, adopt the newest token: it may have been entered through
        // the token flow since this client connected.
        this.mcpClient?.setAuthToken(mcpToken);
        if (this.mcpReady) return this.mcpReady;

        // Only a caller that can show it announces the wait; the warm-up passes no onStatus.
        onStatus?.("Connecting to tools…");
        this.mcpReady = this.probeMcp(servers, mcpToken, signal).finally(() => onStatus?.(null));
        return this.mcpReady;
    }

    private async probeMcp(servers: McpServerConfig[], mcpToken: string | undefined, signal?: AbortSignal): Promise<void> {
        try {
            if (!this.mcpClient) {
                this.mcpUrls = servers.map(s => s.url);
                this.mcpClient = new McpClient(servers.map(s => s.url));
                this.mcpClient.setAuthToken(mcpToken);
                await this.mcpClient.connect(signal);
            }
            if (!this.mcpTools) {
                this.mcpTools = await this.mcpClient.listAllTools(signal);
            }
            this.mcpErrors = this.mcpClient.getErrors();
            const failed = this.mcpErrors.filter(Boolean);
            if (failed.length > 0) {
                console.warn("MCP issues (answering without those servers/tools):", this.mcpErrors);
                // Re-probe next time so a recovered server comes back, and so new tools on a healthy
                // server are eventually discovered.
                this.mcpNeedsReprobe = true;
                this.mcpReady = undefined;
                // A broken/unreachable server must not break the assistant: fall back to LLM-only.
                // If nothing at all was discovered, drop the client so the retry starts clean.
                if (!this.mcpTools?.length) {
                    this.mcpClient = undefined;
                    this.mcpTools = undefined;
                    this.mcpUrls = undefined;
                }
            }
        } catch (err) {
            // A user Stop during connect/discovery is not an MCP failure; let it unwind - but reset
            // the probe state *before* rethrowing.
            //
            // `mcpReady` memoises this promise. Leaving a rejected one cached with `mcpUrls` set and
            // `mcpNeedsReprobe` false made `sameUrls` match on the next ensureMcp, so every later
            // query was handed the same rejected promise and rethrew this AbortError - which the
            // transport filters as an expected cancel. The assistant went permanently dead for the
            // rest of the session with nothing shown.
            //
            // The client is dropped rather than reused because a cancelled handshake leaves some
            // servers initialized and some not, and a half-built client would go straight to
            // tools/list against the ones that never connected. `mcpErrors` is deliberately left
            // alone: a cancellation should neither erase nor invent a per-server diagnosis.
            if (err instanceof Error && err.name === "AbortError") {
                this.mcpClient = undefined;
                this.mcpTools = undefined;
                this.mcpUrls = undefined;
                this.mcpNeedsReprobe = false;
                this.mcpReady = undefined;
                throw err;
            }
            const errMsg = errorMessage(err);
            console.warn(`MCP initialization failed, answering without tools: ${errMsg}`);
            this.mcpErrors = servers.map(() => errMsg);
            this.mcpClient = undefined;
            this.mcpTools = undefined;
            this.mcpUrls = undefined;
            this.mcpNeedsReprobe = false;
            this.mcpReady = undefined;
        }
    }

    /**
     * Connect ahead of the first message so a server's own name - the short handle shown on the
     * badge, in the welcome message and in the roster - is known before anything is displayed.
     * Without it the name is the URL hostname until the user has already sent a message and been
     * told to type the wrong thing. Never throws, and no-ops once a healthy client exists.
     */
    async warmUpMcp(servers: McpServerConfig[], mcpToken?: string): Promise<void> {
        if (!mcpConfigured(servers)) return;
        try {
            await this.ensureMcp(servers, mcpToken);
        } catch (_e) {
            // ensureMcp only rejects on abort, which the warm-up never triggers.
        }
    }

    // Matched against the same status objects every surface displays, so the handle the assistant
    // tells a user to type is by construction one this accepts.
    private addressedServers(prompt: string, previousPrompt: string, status: McpServerStatus[]): Set<number> {
        const addressed = new Set<number>();
        status.forEach((s, i) => {
            const handles = serverHandles(s);
            if (handles.some(h => containsWord(prompt, h) || containsWord(previousPrompt, h))) {
                addressed.add(i);
            }
        });
        return addressed;
    }

    async query(context: QueryContext, prompt: string, onStreamUpdate: (text: string) => void, signal?: AbortSignal, history?: ChatTurn[], onStatus?: (label: string | null) => void): Promise<QueryResponse> {
        const settings = context.settings;
        // location.origin, not a hardcoded https:// - the documented local-testing path is a
        // `kubectl port-forward` to http://localhost:8080, which https:// silently breaks.
        const usingProxy = !settings.data?.baseURL;
        const baseURL = settings.data?.baseURL || `${location.origin}/extensions/assistant`;
        // The Argo CD proxy authorises per-Application and rejects a request without a resolvable
        // one ("400 Invalid headers: invalid value for namespace"). Catch that here so the user gets
        // an explanation instead of the proxy's raw error, and so Retry means something. Checked
        // before model discovery below, which goes through the same proxy and would 400 the same way.
        if (usingProxy && !canRouteToProxy(context.application)) {
            return {
                success: false,
                error: {
                    status: 400,
                    message: 'Still resolving an Argo CD application to authorise this request - the Argo CD proxy authorises LLM traffic per application. Press Retry in a moment; if this persists you may not have access to any application.',
                },
            };
        }
        const apiKey = settings.data?.apiKey;

        // A deployment that serves one model does not have to name it. Asking the backend is what
        // lets the settings extension be optional: `model` was the only setting without a default,
        // and delivering that one string cost a ConfigMap, a volume and a volumeMount.
        let model = settings.model;
        if (!model) {
            onStatus?.("Finding the model…");
            const found = await this.discoverModels(baseURL, apiKey, context, signal);
            if (found.length !== 1) {
                return { success: false, error: { status: 400, message: modelChoiceMessage(found) } };
            }
            model = found[0];
        }
        const mcpServers = parseMcpServers(settings.data?.mcpServers);

        let mcpTools: McpTool[] | undefined;
        if (mcpConfigured(mcpServers)) {
            await this.ensureMcp(mcpServers, context.mcpToken, signal, onStatus);
            mcpTools = this.mcpTools?.length ? this.mcpTools : undefined;
            // Discovery can take seconds; don't start a completion the user has already cancelled.
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        }

        // Advertise tools only for MCP server(s) the user named; otherwise answer LLM-only. This is
        // what keeps a normal question from triggering a tool call. Only the user's own previous
        // message counts as "before" - see addressedServers.
        // One status array feeds the matcher, the roster, the tool block and the UI badge, so the
        // handle a user is told to type is the handle the matcher accepts.
        const serverStatus = mcpConfigured(mcpServers) ? this.getMcpStatus(mcpServers) : [];
        const previousPrompt = lastUserTurn(history);
        const addressedSet = this.addressedServers(prompt, previousPrompt, serverStatus);
        const addressed = (mcpTools && mcpTools.length)
            ? mcpTools.filter(t => addressedSet.has(t.serverIndex))
            : [];
        const toolsForModel = addressed.length ? addressed : undefined;

        // Every configured server is described to the model whether or not it was addressed, so
        // "which MCP servers are available?" has an answer. Without this the prompt was byte-for-byte
        // identical to a deployment with no MCP at all, and the model correctly said it had no
        // information - see mcpPrompt.mcpRoster.
        const roster = serverStatus.length
            ? mcpRoster(serverStatus, this.mcpTools ?? [], toolsForModel ? addressedSet : new Set<number>())
            : "";

        const messages = this.buildMessages(context, prompt, toolsForModel, history, roster, serverStatus);

        // The UI derives its deltas from one cumulative string across the whole query, so every
        // completion in the tool loop below must continue from this exact text. It is the last
        // cumulative value forwarded to onStreamUpdate (starts empty).
        let emittedPrefix = "";

        // Stream one completion, keeping raw <tool ...> XML out of the UI (see ./toolMarker). Returns
        // the raw text (for tool-call parsing) and whether a tool block was hidden.
        const streamStep = async (
            stepMessages: Array<{ role: string; content: string }>
        ): Promise<{ response: QueryResponse; suppressed: boolean }> => {
            const prefixAtStart = emittedPrefix;
            const filter = createToolMarkerFilter();
            const onUpdate = (text: string) => {
                const emit = filter.push(text);
                if (emit === null) return;
                emittedPrefix = prefixAtStart ? `${prefixAtStart}\n\n${emit}` : emit;
                onStreamUpdate(emittedPrefix);
            };
            const response = await this.sendChatCompletion(baseURL, model, apiKey, context, stepMessages, signal, onUpdate, onStatus);
            return { response, suppressed: filter.suppressed };
        };

        // A tool that fails is reported to the user, not only fed back to the model. Without this an
        // MCP server returning 503 reads exactly like the model choosing not to search: the reply
        // just narrates an absence, and nothing distinguishes a broken server from a quiet one.
        const noticeFailure = (name: string, detail: string) => {
            const notice = toolFailureNotice(name, detail);
            emittedPrefix = emittedPrefix ? `${emittedPrefix}\n\n${notice}` : notice;
            onStreamUpdate(emittedPrefix);
        };

        // Bounded tool loop: stream a completion; if the model calls an available tool, run it and
        // feed the result back, up to MAX_TOOL_ITERATIONS executions. The final iteration is forced
        // tool-free so a broken/looping tool never leaves the reply blank or hanging.
        let stepMessages = messages;
        // At most one extra completion, on top of the tool loop's own bound.
        let retriedToolFree = false;
        // Tools executed so far. The bound is on tools, not iterations, so a reply asking for three
        // at once spends the same budget as three replies asking for one.
        let toolsRun = 0;
        for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
            const forceNoTool = iter === MAX_TOOL_ITERATIONS || toolsRun >= MAX_TOOL_ITERATIONS;
            const { response, suppressed } = await streamStep(stepMessages);
            if (!response.success) {
                return response;
            }
            const fullText = response.data || "";
            const toolCalls = forceNoTool ? [] : parseToolCalls(fullText, toolsForModel);

            if (toolCalls.length === 0) {
                // A tool block was hidden but nothing could run it - either no server was addressed
                // this turn, or the name was not a real tool. This used to reveal the raw text, which
                // is worse than it sounds: <tool> is not an allowed tag, so the sanitiser drops the
                // element and keeps its children, leaving the user a bare JSON blob where the answer
                // should be, with no retry. Ask once more, tool-free, so they get prose.
                // `iter < MAX_TOOL_ITERATIONS` is load-bearing: continuing on the last iteration
                // would exit the loop entirely and fall through to the terminal return with nothing
                // emitted - a blank bubble. The final pass always takes the path below.
                if (suppressed && !retriedToolFree && iter < MAX_TOOL_ITERATIONS) {
                    retriedToolFree = true;
                    const attempted = fullText.match(new RegExp(`${TOOL_OPEN}\\s+name="([^"]+)"`))?.[1];
                    onStatus?.("Rethinking…");
                    stepMessages = [
                        ...stepMessages,
                        { role: "assistant", content: fullText },
                        { role: "user", content: noToolNote(attempted, !!toolsForModel) }
                    ];
                    continue;
                }
                if (emittedPrefix.trim().length === 0) {
                    // Nothing visible was produced. Never leave a blank bubble. (Not gated on the
                    // iteration: a whitespace-only first reply passes sendChatCompletion's !text
                    // check and used to render as an empty bubble.)
                    const fallback = toolsForModel
                        ? "I couldn't complete that request using the available tools."
                        : noToolFallback(serverStatus);
                    onStreamUpdate(emittedPrefix ? `${emittedPrefix}\n\n${fallback}` : fallback);
                }
                return { success: true };
            }

            // The model asked for one or more tools. Whether or not they can run (tools may be absent
            // because MCP fell back to LLM-only, or a call may fail), feed a follow-up note back so
            // the raw <tool> XML is never the reply and a broken tool never breaks the answer.
            const runnable = toolCalls.slice(0, MAX_TOOL_ITERATIONS - toolsRun);
            const deferred = toolCalls.length - runnable.length;
            // Several results share one context window, so each is capped tighter than a lone one.
            const resultCap = runnable.length > 1 ? MAX_BATCH_RESULT_CHARS : MAX_TOOL_RESULT_CHARS;
            const notes: string[] = [];

            for (const call of runnable) {
                const tool = toolsForModel?.find(t => t.name === call.name);
                toolsRun++;
                if (tool && this.mcpClient) {
                    onStatus?.(`Running ${call.name}…`);
                    try {
                        const toolResult = await this.mcpClient.callTool(tool.serverIndex, call.name, call.arguments, signal);
                        notes.push(`Tool result for ${call.name}:\n${capText(toolResult, resultCap, `the ${call.name} result`)}`);
                    } catch (err) {
                        // Stop pressed mid-tool is a cancellation, not a tool failure: reporting it as
                        // one fed a misleading note back and burned another completion that aborted
                        // immediately. Let the abort unwind instead.
                        if (err instanceof Error && err.name === "AbortError") throw err;
                        const errMsg = errorMessage(err);
                        console.warn(`MCP tool '${call.name}' failed, answering without it: ${errMsg}`);
                        noticeFailure(call.name, errMsg);
                        notes.push(`The tool ${call.name} could not be run (error: ${errMsg}) and returned nothing.`);
                    }
                } else {
                    console.warn(`MCP tool '${call.name}' was requested but not available; answering without it.`);
                    noticeFailure(call.name, "it is not available");
                    notes.push(`The tool ${call.name} is not available and returned nothing.`);
                }
            }
            if (deferred > 0) {
                const names = toolCalls.slice(runnable.length).map(c => c.name).join(", ");
                noticeFailure(names, `this query's limit of ${MAX_TOOL_ITERATIONS} tool calls was reached`);
                notes.push(`${deferred} further call(s) in that reply were not run (${names}): this query's limit of ${MAX_TOOL_ITERATIONS} tools was reached.`);
            }

            // "using these results" alone invites the model to round them out with what it expected
            // the tools to say. This is the one place a fabricated fact arrives wearing the authority
            // of a tool call, so the bound is stated with the results.
            const plural = notes.length > 1;
            const followUpNote = `${notes.join("\n\n")}\n\nAnswer the original question from ${plural ? "these results" : "this result"} and the context already provided. Use only what ${plural ? "they contain" : "it contains"} - do not extrapolate. If ${plural ? "they do" : "it does"} not answer the question, say so.`;
            // Keep the indicator alive through the follow-up completion, whose first-token wait
            // is otherwise a silent gap that makes the reply look finished. The UI clears this
            // label as soon as the answer starts streaming (useChat text-delta handler).
            onStatus?.("Analysing results…");
            stepMessages = [
                ...stepMessages,
                { role: "assistant", content: fullText },
                { role: "user", content: followUpNote }
            ];
        }
        // Unreachable: the forced tool-free final iteration always returns above.
        return { success: true };
    }

    // GET /v1/models, cached per base URL for the session. Never throws: a backend that does not
    // serve the endpoint, or serves something unexpected, gets the same "set model yourself"
    // message as one that reports nothing, and the reason goes to the console.
    private async discoverModels(
        baseURL: string,
        apiKey: string | undefined,
        context: QueryContext,
        signal?: AbortSignal
    ): Promise<string[]> {
        if (this.modelCache?.baseURL === baseURL) return this.modelCache.models;
        const headers = argocdHeaders(context.application, { Accept: "application/json" });
        if (apiKey) headers["Authorization"] = bearer(apiKey);
        let models: string[] = [];
        try {
            const response = await fetch(modelsUrl(baseURL), { method: "GET", headers, signal });
            if (response.ok) models = parseModelList(await response.json());
            else console.warn(`Model discovery failed: GET /v1/models returned ${response.status}.`);
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            console.warn(`Model discovery failed: ${errorMessage(err)}`);
        }
        this.modelCache = { baseURL, models };
        return models;
    }

    private async sendChatCompletion(
        baseURL: string,
        model: string,
        apiKey: string | undefined,
        context: QueryContext,
        messages: Array<{ role: string; content: string }>,
        signal: AbortSignal | undefined,
        onStreamUpdate: (text: string) => void,
        onStatus?: (label: string | null) => void
    ): Promise<QueryResponse> {
        // Argo CD proxy routing headers plus the JSON content type; the proxy reads the Argocd-*
        // pair to authorise the forwarded request.
        const headers = argocdHeaders(context.application, { 'Content-Type': 'application/json' });

        if (apiKey) {
            headers['Authorization'] = bearer(apiKey);
        }

        const body = JSON.stringify({
            model,
            messages,
            stream: true,
        });

        // Inactivity watchdog: abort if no bytes arrive within STREAM_INACTIVITY_MS, so a stalled or
        // silently-dropped backend surfaces an error instead of hanging. Composed with the caller's
        // signal so the user's Stop still works; the timer is reset on every chunk.
        const internal = new AbortController();
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const clearTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
        const resetTimer = () => {
            clearTimer();
            timer = setTimeout(() => { timedOut = true; internal.abort(); }, STREAM_INACTIVITY_MS);
        };
        const onExternalAbort = () => internal.abort();
        if (signal) {
            if (signal.aborted) internal.abort();
            else signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        try {
            resetTimer();
            const response = await fetch(chatCompletionsUrl(baseURL), {
                method: 'POST',
                headers,
                body,
                signal: internal.signal,
            });
            resetTimer();

            // Status first, body second: a 401/404/429 with no body used to be reported as
            // "may not support streaming", hiding the actual (and actionable) reason.
            if (!response.ok) {
                // The backend's own error text is the most useful thing we have, so read it whenever
                // there is one - including on 5xx, which used to discard it.
                const detail = await response.text().catch(() => "");
                const trimmed = detail.trim();
                let message: string;
                switch (response.status) {
                    case 401:
                        message = "Authentication failed (401). Check your API key or token in the extension settings.";
                        break;
                    case 403:
                        message = "Access forbidden (403). Your API key or token does not have permission to use this model or endpoint.";
                        break;
                    case 404:
                        message = "LLM endpoint not found (404). Check the baseURL in the extension settings.";
                        break;
                    case 429:
                        message = "Rate limit exceeded (429). Too many requests - try again shortly.";
                        break;
                    default:
                        message = response.status >= 500
                            ? `LLM backend error (${response.status}). ${trimmed || "The server returned an internal error."}`
                            : trimmed || `Request failed (${response.status} ${response.statusText}).`;
                }
                return {
                    success: false,
                    error: { status: response.status, message },
                };
            }

            if (!response.body) {
                return {
                    success: false,
                    error: {
                        status: response.status,
                        message: `The LLM backend returned ${response.status} with an empty body. It may not support streaming responses at this endpoint.`,
                    },
                };
            }

            let text = '';
            // Reasoning models (DeepSeek and friends) stream `reasoning_content` before any answer
            // token. That thinking is deliberately not shown, but knowing it is happening turns an
            // otherwise silent 30-second wait into visible progress.
            let sawReasoning = false;
            // Why the model stopped, from the last chunk that reported it. Turns an empty reply from
            // an unexplained blank bubble into a named cause.
            let finishReason: string | undefined;

            for await (const line of readLines(response.body, resetTimer)) {
                const data = sseData(line);
                if (!data) continue;

                let parsed: any;
                try {
                    parsed = JSON.parse(data);
                } catch (_e) {
                    continue; // ignore malformed chunks
                }

                if (parsed.error) {
                    return {
                        success: false,
                        error: { status: 500, message: parsed.error.message || 'Unknown error' },
                    };
                }

                const choice = parsed.choices?.[0];
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                const delta = choice?.delta;
                const content = delta?.content;
                if (content) {
                    text += content;
                    onStreamUpdate(text);
                } else if (!text && delta?.reasoning_content && !sawReasoning) {
                    sawReasoning = true;
                    onStatus?.('Reasoning…');
                }
            }

            // No answer text is a failure, not an empty success - otherwise the reply is a silent
            // blank bubble with no way to diagnose it. This must not be gated on "did any chunk
            // arrive": every OpenAI-compatible backend opens with a role-only delta, so that test
            // passed for exactly the cases it was meant to catch (a content filter, a truncated
            // upstream, or a reasoning model that emitted only reasoning_content).
            if (!text) {
                return {
                    success: false,
                    error: { status: 502, message: emptyReplyMessage(finishReason) },
                };
            }

            return { success: true, data: text };
        } catch (err) {
            // An inactivity abort becomes a friendly error; a user abort (Stop) or genuine network
            // error propagates unchanged so existing handling (silent AbortError) still applies.
            if (timedOut) {
                return {
                    success: false,
                    error: {
                        status: 504,
                        message: `The assistant stopped responding (no data for ${STREAM_INACTIVITY_MS / 1000}s). The LLM backend may be unreachable or overloaded - please try again.`,
                    },
                };
            }
            throw err;
        } finally {
            clearTimer();
            if (signal) signal.removeEventListener('abort', onExternalAbort);
        }
    }

    private buildMessages(context: QueryContext, prompt: string, mcpTools: McpTool[] | undefined, history: ChatTurn[] | undefined, roster: string, servers: McpServerStatus[]): Array<{ role: string; content: string }> {
        const messages: Array<{ role: string; content: string }> = [];

        const override = context.settings.systemPrompt;
        let systemText = override && override.trim() ? override : DEFAULT_SYSTEM_PROMPT;

        if (context.attachments.length > 0) {
            systemText += "\n\nContext:\n";
            for (const attachment of context.attachments) {
                const label = this.attachmentLabel(attachment.type);
                systemText += `\n[${label} - ${attachment.mimeType}]:\n${attachment.content}\n`;
            }
        }

        systemText += roster;

        if (mcpTools && mcpTools.length > 0) {
            systemText += this.toolPrompt(mcpTools, servers);
        }

        messages.push({ role: 'system', content: systemText });

        if (history && history.length > 0) {
            // Two bounds, both needed. Per turn: one pasted manifest in an earlier message would
            // otherwise ride along in full on every subsequent request. In aggregate: the turn count
            // alone let a long conversation re-send up to MAX_HISTORY_MESSAGES x
            // MAX_HISTORY_TURN_CHARS on every request, which was the largest term in the prompt.
            //
            // Applied here rather than in the UI transport because this is the only place that sees
            // the whole prompt - persona, attachments, roster, tool block and history together.
            // Note lastUserTurn() reads the *raw* history argument, so trimming here cannot break
            // the two-turn MCP addressing window.
            messages.push(...budgetHistory(history.map((turn) => ({
                role: turn.role,
                content: capText(turn.content, MAX_HISTORY_TURN_CHARS, "an earlier message")
            }))));
        }

        messages.push({ role: 'user', content: prompt });
        return messages;
    }

    // Memo around mcpPrompt.toolPrompt: the JSON schemas are re-serialised identically on every
    // request otherwise. Keyed by tool names *and* the server names it groups them under.
    private toolPrompt(mcpTools: McpTool[], servers: McpServerStatus[]): string {
        const key = [...mcpTools.map(t => `${t.serverIndex}:${t.name}`), ...servers.map(s => s.handle)].join("\u0000");
        if (this.toolPromptCache?.key === key) return this.toolPromptCache.text;

        const text = toolPrompt(mcpTools, (i) => servers[i]?.handle ?? "", MAX_TOOL_ITERATIONS);
        this.toolPromptCache = { key, text };
        return text;
    }

    private attachmentLabel(type: AttachmentType): string {
        switch (type) {
            case AttachmentType.EVENTS: return 'Events';
            case AttachmentType.LOG: return 'Log';
            case AttachmentType.MANIFEST: return 'Manifest';
            case AttachmentType.APP_SUMMARY: return 'Argo CD Application';
            default: return 'Attachment';
        }
    }
}
