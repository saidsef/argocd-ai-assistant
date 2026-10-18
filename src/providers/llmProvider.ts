import { AttachmentType, ChatMessage, ChatToolCall, ChatTurn, McpServerConfig, McpServerStatus, QueryContext, QueryProvider, QueryResponse, ToolCallingMode } from "../model/provider";
import { budgetHistory, capText, MAX_HISTORY_TURN_CHARS, MAX_TOOL_RESULT_CHARS } from "../util/context";
import { readLines, sseData } from "../util/stream";
import { argocdHeaders, bearer, canRouteToProxy, containsWord, errorMessage, mcpConfigured, parseMcpServers } from "../util/util";
import { McpClient, McpTool } from "./mcpClient";
import { clean, hostnameOf, MAX_SERVER_NAME_CHARS, mcpRoster, noToolFallback, noToolNote, resolveHandles, resultsNote, serverHandles, toolFailureNotice, toolPrompt } from "./mcpPrompt";
import { ChatTools, createToolCallAccumulator, parseArguments, toChatTools, toolCallingSetting, toolsRejected, toTextMessages } from "./nativeTools";
import { parseToolCalls, TOOL_OPEN } from "./toolCall";
import { createToolMarkerFilter } from "./toolMarker";

// Names the cause of an empty reply from finish_reason, since each value points at a different fix.
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

// The user's own previous message, not the last turn of any role, since replies name every server.
function lastUserTurn(history?: ChatTurn[]): string {
    for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
        if (history![i].role === "user") return history![i].content;
    }
    return "";
}

// Same URLs in the same order, the identity serverIndex values rely on. Names may change freely.
function sameUrls(a: string[] | undefined, b: McpServerConfig[]): boolean {
    return !!a && a.length === b.length && a.every((u, i) => u === b[i].url);
}

// Accepts a baseURL with or without a trailing /v1, since the documented examples include it.
const apiRoot = (baseURL: string): string => baseURL.replace(/\/+$/, "").replace(/\/v1$/i, "");

export function chatCompletionsUrl(baseURL: string): string {
    return `${apiRoot(baseURL)}/v1/chat/completions`;
}

export function modelsUrl(baseURL: string): string {
    return `${apiRoot(baseURL)}/v1/models`;
}

// Ids from a /v1/models body, dropping anything that is not a non-empty string.
export function parseModelList(body: any): string[] {
    if (!Array.isArray(body?.data)) return [];
    return body.data
        .map((m: any) => (typeof m === "string" ? m : m?.id))
        .filter((id: any): id is string => typeof id === "string" && id.trim().length > 0);
}

// Names the backend's models when it serves several, so one can be copied into the settings.
export function modelChoiceMessage(found: string[]): string {
    return found.length
        ? `The LLM backend serves ${found.length} models, so one has to be chosen: set \`model\` in argocdAssistantSettings to one of ${found.join(", ")}.`
        : "LLM model is not configured, and the backend did not report one to fall back on. Set the model field in argocdAssistantSettings.";
}

// Accuracy rules as checkable prohibitions, one per line: see docs/architecture.md#system-prompt.
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

// Tools per question, counted per tool. The completion after the last one is forced tool-free.
const MAX_TOOL_ITERATIONS = 3;

// Per-result cap when one reply runs several tools, so a batch cannot crowd out the other context.
const MAX_BATCH_RESULT_CHARS = Math.floor(MAX_TOOL_RESULT_CHARS / 2);

// Silence between bytes that aborts a stream, generous enough for a slow first token.
const STREAM_INACTIVITY_MS = 45000;

// What a completion request adds to `{model, messages, stream}`.
type CompletionOptions = { tools?: any[]; toolChoice?: string };

// Backends that rejected `tools`, keyed by base URL and model. Module level, so it outlives a remount.
const textOnlyBackends = new Set<string>();

export class LlmProvider implements QueryProvider {

    private mcpClient?: McpClient;
    private mcpTools?: McpTool[];
    // The URL list the cached client was built for, so a settings change invalidates it.
    private mcpUrls?: string[];
    // Per-server failure reason from the last probe, shown on the UI badge.
    private mcpErrors: (string | undefined)[] = [];
    // Set when a server failed, so the next query probes again instead of caching the failure.
    private mcpNeedsReprobe = false;
    // The in-flight or settled probe, shared by the warm-up and any query, so each server handshakes once.
    private mcpReady?: Promise<void>;
    // The rendered tool prompt, keyed by the tools and mode it was built from.
    private toolPromptCache?: { key: string; text: string };
    // What GET /v1/models reported, keyed by base URL. Only a served list is cached.
    private modelCache?: { baseURL: string; models: string[] };

    // Decides every server's handle in one place, since a handle must be unique across the set.
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

    /** Connects and lists tools once for all concurrent callers. Rejects only on a user abort. */
    private ensureMcp(
        servers: McpServerConfig[],
        mcpToken: string | undefined,
        signal?: AbortSignal,
        onStatus?: (label: string | null) => void
    ): Promise<void> {
        // Rebuild after a failed server or a changed URL list, since serverIndex values are list positions.
        if (this.mcpNeedsReprobe || !sameUrls(this.mcpUrls, servers)) this.dropMcp();
        // Adopt the newest token, which the token flow may have set since this client connected.
        this.mcpClient?.setAuthToken(mcpToken);
        if (this.mcpReady) return this.mcpReady;

        // Only a caller that can show the wait announces it. The warm-up passes no onStatus.
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
                // Answer without MCP, dropping the client when nothing at all was discovered.
                if (!this.mcpTools?.length) this.dropMcp();
                // Probe again next time, so a recovered server and new tools come back.
                this.mcpNeedsReprobe = true;
                this.mcpReady = undefined;
            }
        } catch (err) {
            // A Stop is not an MCP failure. Reset first, or every later query reuses this rejection.
            if (err instanceof Error && err.name === "AbortError") {
                this.dropMcp();
                throw err;
            }
            const errMsg = errorMessage(err);
            console.warn(`MCP initialization failed, answering without tools: ${errMsg}`);
            this.mcpErrors = servers.map(() => errMsg);
            this.dropMcp();
        }
    }

    private dropMcp(): void {
        this.mcpClient = undefined;
        this.mcpTools = undefined;
        this.mcpUrls = undefined;
        this.mcpNeedsReprobe = false;
        this.mcpReady = undefined;
    }

    /** Connects before the first message, so the badge shows each server's handle. Never throws. */
    async warmUpMcp(servers: McpServerConfig[], mcpToken?: string): Promise<void> {
        if (!mcpConfigured(servers)) return;
        try {
            await this.ensureMcp(servers, mcpToken);
        } catch (_e) {
            // ensureMcp only rejects on abort, which the warm-up never triggers.
        }
    }

    // Servers named in this message or the user's previous one: see docs/architecture.md#addressing-a-server.
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
        // location.origin, since the documented port-forward serves plain http on localhost.
        const usingProxy = !settings.data?.baseURL;
        const baseURL = settings.data?.baseURL || `${location.origin}/extensions/assistant`;
        // The proxy authorises per Application, so explain a missing one before discovery hits the same 400.
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

        // Ask the backend when model is unset, so a single-model deployment needs no settings at all.
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
            // Discovery can take seconds, so skip the completion if the user has already cancelled.
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        }

        // Tools only for servers the user named, so a normal question never triggers a call.
        const serverStatus = mcpConfigured(mcpServers) ? this.getMcpStatus(mcpServers) : [];
        const previousPrompt = lastUserTurn(history);
        const addressedSet = this.addressedServers(prompt, previousPrompt, serverStatus);
        const addressed = (mcpTools && mcpTools.length)
            ? mcpTools.filter(t => addressedSet.has(t.serverIndex))
            : [];
        const toolsForModel = addressed.length ? addressed : undefined;

        // Every configured server is listed whether or not it was named, so MCP questions have an answer.
        const systemFor = (mode: ToolCallingMode) => this.systemText(context, toolsForModel, serverStatus.length
            ? mcpRoster(serverStatus, this.mcpTools ?? [], toolsForModel ? addressedSet : new Set<number>(), mode)
            : "", serverStatus, mode);

        // Native calls by default. A backend that rejected `tools` this session goes straight to text.
        const toolSetting = toolCallingSetting(settings.data?.toolCalling);
        const backendKey = `${baseURL}\u0000${model}`;
        let mode: ToolCallingMode = toolSetting !== "auto" ? toolSetting : textOnlyBackends.has(backendKey) ? "text" : "native";
        let chatTools: ChatTools | undefined = toolsForModel && mode === "native" ? toChatTools(toolsForModel) : undefined;

        const messages = this.buildMessages(context, prompt, history, systemFor(mode));

        // The UI derives deltas from one cumulative string, so every completion continues this text.
        let emittedPrefix = "";

        // Streams one completion, keeping text tool blocks out of the UI (see ./toolMarker).
        const streamStep = async (
            stepMessages: ChatMessage[],
            options: CompletionOptions = {}
        ): Promise<{ response: QueryResponse; suppressed: boolean }> => {
            const prefixAtStart = emittedPrefix;
            const filter = createToolMarkerFilter();
            const onUpdate = (text: string) => {
                const emit = filter.push(text);
                if (emit === null) return;
                emittedPrefix = prefixAtStart ? `${prefixAtStart}\n\n${emit}` : emit;
                onStreamUpdate(emittedPrefix);
            };
            const response = await this.sendChatCompletion(baseURL, model, apiKey, context, stepMessages, options, signal, onUpdate, onStatus);
            return { response, suppressed: filter.suppressed };
        };

        // Shows a failed tool in the chat, so a broken server is not mistaken for an unused one.
        const noticeFailure = (name: string, detail: string) => {
            const notice = toolFailureNotice(name, detail);
            emittedPrefix = emittedPrefix ? `${emittedPrefix}\n\n${notice}` : notice;
            onStreamUpdate(emittedPrefix);
        };

        // Bounded tool loop. The final pass is forced tool-free, so a looping tool cannot hang the reply.
        let stepMessages: ChatMessage[] = messages;
        // At most one extra completion, on top of the tool loop's own bound.
        let retriedToolFree = false;
        // Tools run so far, counted per tool, so a batch of three spends what three replies would.
        let toolsRun = 0;

        // One native call, answered with the text its tool message carries.
        const runNativeCall = async (name: string, tool: McpTool | undefined, args: ReturnType<typeof parseArguments>, resultCap: number): Promise<string> => {
            if (!tool || !this.mcpClient) {
                console.warn(`MCP tool '${name}' was requested but not available; answering without it.`);
                noticeFailure(name, "it is not available");
                return `The tool ${name} is not available and returned nothing.`;
            }
            if (args.error) return `The tool ${name} was not run: ${args.error}.`;
            onStatus?.(`Running ${name}…`);
            try {
                return capText(await this.mcpClient.callTool(tool.serverIndex, tool.name, args.value, signal), resultCap, `the ${name} result`);
            } catch (err) {
                if (err instanceof Error && err.name === "AbortError") throw err;
                const errMsg = errorMessage(err);
                console.warn(`MCP tool '${name}' failed, answering without it: ${errMsg}`);
                noticeFailure(name, errMsg);
                return `The tool ${name} could not be run (error: ${errMsg}) and returned nothing.`;
            }
        };

        // Every call id gets a tool message, since the next request is rejected while any is unanswered.
        const runNativeCalls = async (text: string, calls: ChatToolCall[], tools: ChatTools): Promise<ChatMessage[]> => {
            const resultCap = Math.min(calls.length, MAX_TOOL_ITERATIONS - toolsRun) > 1 ? MAX_BATCH_RESULT_CHARS : MAX_TOOL_RESULT_CHARS;
            const results = new Map<string, string>();
            const overBudget: string[] = [];
            const replies: ChatMessage[] = [];
            for (const call of calls) {
                const tool = tools.byName.get(call.function.name);
                const name = tool?.name ?? call.function.name;
                const args = parseArguments(call.function.arguments);
                // A repeated call gets the first one's result, without spending a round trip on it.
                const key = JSON.stringify([call.function.name, args.value ?? call.function.arguments]);
                let content = results.get(key);
                if (content === undefined) {
                    if (toolsRun >= MAX_TOOL_ITERATIONS) {
                        overBudget.push(name);
                        content = `Not run: this query's limit of ${MAX_TOOL_ITERATIONS} tools was reached.`;
                    } else {
                        toolsRun++;
                        content = await runNativeCall(name, tool, args, resultCap);
                    }
                    results.set(key, content);
                }
                replies.push({ role: "tool", tool_call_id: call.id, content: content || "The tool returned no output." });
            }
            if (overBudget.length) {
                noticeFailure(overBudget.join(", "), `this query's limit of ${MAX_TOOL_ITERATIONS} tool calls was reached`);
            }
            onStatus?.("Analysing results…");
            return [{ role: "assistant", content: text || null, tool_calls: calls }, ...replies];
        };

        for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
            const forceNoTool = iter === MAX_TOOL_ITERATIONS || toolsRun >= MAX_TOOL_ITERATIONS;
            const sentTools = chatTools;
            let { response, suppressed } = await streamStep(stepMessages,
                sentTools ? { tools: sentTools.tools, toolChoice: forceNoTool ? "none" : undefined } : {});
            // Retry a rejected tools request as text. Only a retry that succeeds marks the backend text-only.
            if (!response.success && sentTools && toolSetting === "auto" && toolsRejected(response.error?.status)) {
                mode = "text";
                chatTools = undefined;
                stepMessages = [{ role: "system", content: systemFor(mode) }, ...toTextMessages(stepMessages.slice(1), sentTools.byName)];
                ({ response, suppressed } = await streamStep(stepMessages));
                if (response.success) textOnlyBackends.add(backendKey);
            }
            if (!response.success) {
                return response;
            }
            const fullText = response.data || "";

            const nativeCalls = forceNoTool || !chatTools ? [] : (response.toolCalls ?? []);
            if (nativeCalls.length > 0) {
                stepMessages = [...stepMessages, ...await runNativeCalls(fullText, nativeCalls, chatTools!)];
                continue;
            }

            const toolCalls = forceNoTool ? [] : parseToolCalls(fullText, toolsForModel);

            if (toolCalls.length === 0) {
                // One tool-free retry when a hidden block ran nothing, never on the last pass.
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
                    // Never leave a blank bubble, even for a whitespace-only first reply.
                    const fallback = toolsForModel
                        ? "I couldn't complete that request using the available tools."
                        : noToolFallback(serverStatus);
                    onStreamUpdate(emittedPrefix ? `${emittedPrefix}\n\n${fallback}` : fallback);
                }
                return { success: true };
            }

            // Feed every requested call back, run or not, so the raw tool block is never the reply.
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
                        // Stop mid-tool is a cancellation, not a tool failure, so let it unwind.
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

            // The note states the bound, since a fabricated fact could arrive here with a tool's authority.
            const followUpNote = resultsNote(notes);
            // Keeps the status visible through the follow-up's first-token wait.
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

    // GET /v1/models, cached per base URL. Never throws, and logs the reason to the console.
    private async discoverModels(
        baseURL: string,
        apiKey: string | undefined,
        context: QueryContext,
        signal?: AbortSignal
    ): Promise<string[]> {
        if (this.modelCache?.baseURL === baseURL) return this.modelCache.models;
        const headers = argocdHeaders(context.application, { Accept: "application/json" });
        if (apiKey) headers["Authorization"] = bearer(apiKey);
        try {
            const response = await fetch(modelsUrl(baseURL), { method: "GET", headers, signal });
            if (!response.ok) {
                console.warn(`Model discovery failed: GET /v1/models returned ${response.status}.`);
                return [];
            }
            const models = parseModelList(await response.json());
            this.modelCache = { baseURL, models };
            return models;
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            console.warn(`Model discovery failed: ${errorMessage(err)}`);
            return [];
        }
    }

    private async sendChatCompletion(
        baseURL: string,
        model: string,
        apiKey: string | undefined,
        context: QueryContext,
        messages: ChatMessage[],
        options: CompletionOptions,
        signal: AbortSignal | undefined,
        onStreamUpdate: (text: string) => void,
        onStatus?: (label: string | null) => void
    ): Promise<QueryResponse> {
        // The proxy reads the Argocd-* pair to authorise the forwarded request.
        const headers = argocdHeaders(context.application, { 'Content-Type': 'application/json' });

        if (apiKey) {
            headers['Authorization'] = bearer(apiKey);
        }

        const body = JSON.stringify({
            model,
            messages,
            stream: true,
            ...(options.tools ? { tools: options.tools } : {}),
            ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
        });

        // Aborts after STREAM_INACTIVITY_MS of silence, alongside the caller's signal so Stop still works.
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

            // Status first, since a 401, 404 or 429 often has no body to explain it.
            if (!response.ok) {
                // The backend's own error text, 5xx included, is the most useful detail there is.
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
            // Shows "Reasoning…" while a model streams reasoning_content before its first answer token.
            let sawReasoning = false;
            // Why the model stopped, so an empty reply can name its cause.
            let finishReason: string | undefined;
            const toolCalls = createToolCallAccumulator();

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
                toolCalls.push(delta?.tool_calls);
                const content = delta?.content;
                if (content) {
                    text += content;
                    onStreamUpdate(text);
                } else if (!text && delta?.reasoning_content && !sawReasoning) {
                    sawReasoning = true;
                    onStatus?.('Reasoning…');
                }
            }

            // No text and no tool call is a failure, never a blank bubble.
            const calls = toolCalls.calls();
            if (!text && calls.length === 0) {
                return {
                    success: false,
                    error: { status: 502, message: emptyReplyMessage(finishReason) },
                };
            }

            return { success: true, data: text, ...(calls.length ? { toolCalls: calls } : {}) };
        } catch (err) {
            // An inactivity abort becomes an error. A user Stop or a network error propagates unchanged.
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

    // The system message: persona, attachments, the MCP roster and, when tools are offered, their rules.
    private systemText(context: QueryContext, mcpTools: McpTool[] | undefined, roster: string, servers: McpServerStatus[], mode: ToolCallingMode): string {
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
            systemText += this.toolPrompt(mcpTools, servers, mode);
        }
        return systemText;
    }

    private buildMessages(context: QueryContext, prompt: string, history: ChatTurn[] | undefined, systemText: string): ChatMessage[] {
        const messages: ChatMessage[] = [{ role: "system", content: systemText }];

        if (history && history.length > 0) {
            // History is capped per turn and in total here, the one place that sees the whole prompt.
            messages.push(...budgetHistory(history.map((turn) => ({
                role: turn.role,
                content: capText(turn.content, MAX_HISTORY_TURN_CHARS, "an earlier message")
            }))));
        }

        messages.push({ role: 'user', content: prompt });
        return messages;
    }

    // Memo around mcpPrompt.toolPrompt, keyed by the tools, the server handles and the mode.
    private toolPrompt(mcpTools: McpTool[], servers: McpServerStatus[], mode: ToolCallingMode): string {
        const key = [mode, ...mcpTools.map(t => `${t.serverIndex}:${t.name}`), ...servers.map(s => s.handle)].join("\u0000");
        if (this.toolPromptCache?.key === key) return this.toolPromptCache.text;

        const text = toolPrompt(mcpTools, (i) => servers[i]?.handle ?? "", MAX_TOOL_ITERATIONS, mode);
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
