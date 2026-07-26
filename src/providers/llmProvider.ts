import { AttachmentType, ChatTurn, McpServerConfig, McpServerStatus, QueryContext, QueryProvider, QueryResponse } from "../model/provider";
import { capText, MAX_HISTORY_TURN_CHARS, MAX_TOOL_RESULT_CHARS } from "../util/context";
import { readLines, sseData } from "../util/stream";
import { argocdHeaders, bearer, canRouteToProxy, containsWord, errorMessage, mcpConfigured, parseMcpServers } from "../util/util";
import { McpClient, McpTool } from "./mcpClient";
import { clean, hostnameOf, MAX_SERVER_NAME_CHARS, mcpRoster, noToolFallback, noToolNote, resolveHandles, serverHandles, toolPrompt } from "./mcpPrompt";
import { parseToolCall } from "./toolCall";
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

// Resolve the chat-completions endpoint from a configured base URL.
//
// Every documented example sets `baseURL` to the provider's OpenAI-compatible root *including* the
// version segment ("https://api.openai.com/v1", "http://ollama:11434/v1"), so appending
// "/v1/chat/completions" produced ".../v1/v1/chat/completions" and a 404. Accept either form: drop
// trailing slashes and one trailing "/v1", then append the full path.
export function chatCompletionsUrl(baseURL: string): string {
    const root = baseURL.replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${root}/v1/chat/completions`;
}

// Default persona/instructions prepended to every request. Grounds answers in the
// attached context and keeps replies concise and actionable. Override per-deployment
// via the top-level `systemPrompt` setting.
export const DEFAULT_SYSTEM_PROMPT = `You are the Argo CD AI Assistant, an expert in Argo CD, Kubernetes, and GitOps. You help users understand and troubleshoot the Kubernetes resources they manage with Argo CD.

Guidelines:
- Ground every answer in the provided context (resource manifest, events, logs, and any attached lists). If the context does not contain the answer, say so plainly instead of guessing.
- Never invent resource names, namespaces, images, or field values that are not present in the context.
- Be concise and actionable: prefer short explanations, concrete kubectl/argocd commands, and step-by-step remediation over prose.
- When diagnosing, cite the specific fields, status conditions, or events you are reasoning from.
- An "Argo CD Application" summary (a distilled \`argocd app get\`: source/chart, sync status, health, sync policy, images, and any out-of-sync or degraded resources) may be attached. Use it to answer questions about the application's deployment, Helm chart/version, sync, and health, citing its specific fields.
- A list of configured MCP tool servers may be attached. It is the complete set, so answer questions about which servers exist, their state, and which tools they expose directly from it - do not say you have no information about MCP when that list is present.
- Format replies in Markdown; put commands, manifests, and log excerpts in fenced code blocks.`;

// Max tools the model may chain within one query. Bounds latency/cost and guarantees termination
// in at most MAX_TOOL_ITERATIONS + 1 completions (the final one is forced tool-free).
const MAX_TOOL_ITERATIONS = 3;

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
            // A user Stop during connect/discovery is not an MCP failure; let it unwind.
            if (err instanceof Error && err.name === "AbortError") throw err;
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
        const model = settings.model;
        if (!model) {
            return {
                success: false,
                error: { status: 400, message: 'LLM model is not configured. Check extension settings (model field in argocdAssistantSettings).' },
            };
        }
        // The Argo CD proxy authorises per-Application and rejects a request without a resolvable
        // one ("400 Invalid headers: invalid value for namespace"). Catch that here so the user gets
        // an explanation instead of the proxy's raw error, and so Retry means something.
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

        // Bounded tool loop: stream a completion; if the model calls an available tool, run it and
        // feed the result back, up to MAX_TOOL_ITERATIONS executions. The final iteration is forced
        // tool-free so a broken/looping tool never leaves the reply blank or hanging.
        let stepMessages = messages;
        // At most one extra completion, on top of the tool loop's own bound.
        let retriedToolFree = false;
        for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
            const forceNoTool = iter === MAX_TOOL_ITERATIONS;
            const { response, suppressed } = await streamStep(stepMessages);
            if (!response.success) {
                return response;
            }
            const fullText = response.data || "";
            const toolCall = forceNoTool ? null : parseToolCall(fullText, toolsForModel);

            if (!toolCall) {
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
                    const attempted = fullText.match(/<tool\s+name="([^"]+)"/)?.[1];
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

            // The model asked for a tool. Whether or not it can run (tools may be absent because MCP
            // fell back to LLM-only, or the call may fail), feed a follow-up note back so the raw
            // <tool> XML is never the reply and a broken tool never breaks the answer.
            const tool = toolsForModel?.find(t => t.name === toolCall.name);
            let followUpNote: string;
            if (tool && this.mcpClient) {
                onStatus?.(`Running ${toolCall.name}…`);
                try {
                    const toolResult = await this.mcpClient.callTool(tool.serverIndex, toolCall.name, toolCall.arguments, signal);
                    const capped = capText(toolResult, MAX_TOOL_RESULT_CHARS, `the ${toolCall.name} result`);
                    followUpNote = `Tool result for ${toolCall.name}:\n${capped}\n\nPlease answer the original question using this result.`;
                } catch (err) {
                    // Stop pressed mid-tool is a cancellation, not a tool failure: reporting it as
                    // one fed a misleading note back and burned another completion that aborted
                    // immediately. Let the abort unwind instead.
                    if (err instanceof Error && err.name === "AbortError") throw err;
                    const errMsg = errorMessage(err);
                    console.warn(`MCP tool '${toolCall.name}' failed, answering without it: ${errMsg}`);
                    followUpNote = `The tool ${toolCall.name} could not be run (error: ${errMsg}). Answer the original question directly, without the tool.`;
                }
            } else {
                console.warn(`MCP tool '${toolCall.name}' was requested but not available; answering without it.`);
                followUpNote = `The tool ${toolCall.name} is not available. Answer the original question directly, without any tool.`;
            }
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
            // Cap each turn: history is bounded by turn count, not size, so one pasted manifest in an
            // earlier message would otherwise ride along in full on every subsequent request.
            messages.push(...history.map((turn) => ({
                role: turn.role,
                content: capText(turn.content, MAX_HISTORY_TURN_CHARS, "an earlier message")
            })));
        }

        messages.push({ role: 'user', content: prompt });
        return messages;
    }

    // Memo around mcpPrompt.toolPrompt: the JSON schemas are re-serialised identically on every
    // request otherwise. Keyed by tool names *and* the server names it groups them under.
    private toolPrompt(mcpTools: McpTool[], servers: McpServerStatus[]): string {
        const key = [...mcpTools.map(t => `${t.serverIndex}:${t.name}`), ...servers.map(s => s.handle)].join("\u0000");
        if (this.toolPromptCache?.key === key) return this.toolPromptCache.text;

        const text = toolPrompt(mcpTools, (i) => servers[i]?.handle ?? "");
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
