import { AttachmentType, ChatTurn, McpServerStatus, QueryContext, QueryProvider, QueryResponse } from "../model/provider";
import { containsWord, getMappedHeaders, mcpConfigured } from "../util/util";
import { McpClient, McpTool } from "./mcpClient";

// Short display label for an MCP server before it reports its own name.
function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

// Default persona/instructions prepended to every request. Grounds answers in the
// attached context and keeps replies concise and actionable. Override per-deployment
// via the top-level `systemPrompt` setting.
export const DEFAULT_SYSTEM_PROMPT = `You are the Argo CD AI Assistant, an expert in Argo CD, Kubernetes, and GitOps. You help users understand and troubleshoot the Kubernetes resources they manage with Argo CD.

Guidelines:
- Ground every answer in the provided context (resource manifest, events, and logs). If the context does not contain the answer, say so plainly instead of guessing.
- Never invent resource names, namespaces, images, or field values that are not present in the context.
- Be concise and actionable: prefer short explanations, concrete kubectl/argocd commands, and step-by-step remediation over prose.
- When diagnosing, cite the specific fields, status conditions, or events you are reasoning from.
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

    // Live status of the configured MCP servers for UI display. Before the first query
    // the client has not connected, so this reports the URL hostname / not-connected / 0
    // tools; after a query it upgrades to the server-reported name and discovered tools.
    getMcpStatus(urls: string[]): McpServerStatus[] {
        const infos = this.mcpClient?.getServerInfos();
        return urls.map((url, i) => {
            const connected = !!infos && infos[i] != null;
            const toolCount = (this.mcpTools ?? []).filter(t => t.serverIndex === i).length;
            return {
                url,
                name: infos?.[i]?.name || hostnameOf(url),
                connected,
                toolCount
            };
        });
    }

    // Tools are advertised only for MCP servers the user addresses by name in this message, so a
    // normal question never triggers a tool call. A server is addressed when its reported name, its
    // hostname, or the hostname's first label appears as a whole word in the prompt. Returns the
    // subset of `allTools` on addressed servers (empty when none is named).
    private addressedTools(prompt: string, urls: string[], allTools: McpTool[]): McpTool[] {
        const infos = this.mcpClient?.getServerInfos();
        const addressed = new Set<number>();
        for (let i = 0; i < urls.length; i++) {
            const host = hostnameOf(urls[i]);
            const handles = [infos?.[i]?.name, host, host.split(".")[0]]
                .filter((h): h is string => !!h && h.length >= 2);
            if (handles.some(h => containsWord(prompt, h))) addressed.add(i);
        }
        return allTools.filter(t => addressed.has(t.serverIndex));
    }

    async query(context: QueryContext, prompt: string, onStreamUpdate: (text: string) => void, signal?: AbortSignal, history?: ChatTurn[], onStatus?: (label: string | null) => void): Promise<QueryResponse> {
        const settings = context.settings;
        const baseURL = settings.data?.baseURL || `https://${location.host}/extensions/assistant`;
        const model = settings.model;
        if (!model) {
            return {
                success: false,
                error: { status: 400, message: 'LLM model is not configured. Check extension settings (model field in argocdAssistantSettings).' },
            };
        }
        const apiKey = settings.data?.apiKey;
        const mcpServerUrls: string[] | undefined = settings.data?.mcpServers;

        let mcpTools: McpTool[] | undefined;
        if (mcpConfigured(mcpServerUrls)) {
            try {
                if (!this.mcpClient) {
                    this.mcpClient = new McpClient(mcpServerUrls);
                    this.mcpClient.setAuthToken(context.mcpToken);
                    await this.mcpClient.connect();
                } else {
                    // Refresh the token in case it was entered/changed since the client connected.
                    this.mcpClient.setAuthToken(context.mcpToken);
                }
                if (!this.mcpTools) {
                    this.mcpTools = await this.mcpClient.listAllTools();
                }
                const mcpErrors = this.mcpClient.getErrors();
                if (mcpErrors.length > 0) {
                    console.warn("MCP issues (answering without those servers/tools):", mcpErrors);
                }
                mcpTools = this.mcpTools;
                if (!mcpTools || mcpTools.length === 0) {
                    // A broken/unreachable MCP server must not break the assistant: fall back to
                    // LLM-only. If it failed with errors (rather than genuinely exposing no tools),
                    // drop the cached client so a recovered server is re-probed on the next query.
                    mcpTools = undefined;
                    if (mcpErrors.length > 0) {
                        this.mcpClient = undefined;
                        this.mcpTools = undefined;
                    }
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn(`MCP initialization failed, answering without tools: ${errMsg}`);
                this.mcpClient = undefined;
                this.mcpTools = undefined;
                mcpTools = undefined;
            }
        }

        // Advertise tools only for MCP server(s) the user named in this message; otherwise answer
        // LLM-only. This is what keeps a normal question from triggering a tool call.
        const addressed = (mcpTools && mcpTools.length) ? this.addressedTools(prompt, mcpServerUrls!, mcpTools) : [];
        const toolsForModel = addressed.length ? addressed : undefined;

        const messages = this.buildMessages(context, prompt, toolsForModel, history);

        // The UI derives its deltas from one cumulative string across the whole query, so every
        // completion in the tool loop below must continue from this exact text. It is the last
        // cumulative value forwarded to onStreamUpdate (starts empty).
        let emittedPrefix = "";

        // Stream one completion while keeping raw <tool ...> XML out of the UI: it is internal (the
        // visible answer comes from a later completion) and streaming it would corrupt the cumulative
        // deltas. Suppress from the first <tool marker onward (forwarding any preamble once). The
        // marker is <tool followed by whitespace or ">" (the prompt's <tool name="..."> shape), never
        // a bare word boundary: the latter transiently matches "...<tool" mid-stream, so <toolbar> /
        // <toolkit> in prose would get their tail wrongly hidden. Returns the raw text (for tool-call
        // parsing) and whether a tool block was hidden.
        const streamStep = async (
            stepMessages: Array<{ role: string; content: string }>
        ): Promise<{ response: QueryResponse & { data?: string }; suppressed: boolean }> => {
            const prefixAtStart = emittedPrefix;
            let suppressed = false;
            const onUpdate = (text: string) => {
                if (suppressed) return;
                const m = text.match(/<tool[\s>]/);
                if (m) {
                    suppressed = true;
                    const before = text.slice(0, m.index).trimEnd();
                    if (before) {
                        emittedPrefix = prefixAtStart ? `${prefixAtStart}\n\n${before}` : before;
                        onStreamUpdate(emittedPrefix);
                    }
                    return;
                }
                // A trailing "<", "<t", "<to", "<too" may be the start of a <tool> block whose word
                // boundary hasn't streamed yet. Withhold it: downstream deltas are append-only, so a
                // "<" shown now could never be retracted once we learn it began a (suppressed) block.
                const lt = text.lastIndexOf("<");
                const emit = lt >= 0 && "<tool".startsWith(text.slice(lt)) ? text.slice(0, lt) : text;
                if (!emit) return;
                emittedPrefix = prefixAtStart ? `${prefixAtStart}\n\n${emit}` : emit;
                onStreamUpdate(emittedPrefix);
            };
            const response = await this.sendChatCompletion(baseURL, model, apiKey, context, stepMessages, signal, onUpdate);
            return { response, suppressed };
        };

        // Bounded tool loop: stream a completion; if the model calls an available tool, run it and
        // feed the result back, up to MAX_TOOL_ITERATIONS executions. The final iteration is forced
        // tool-free so a broken/looping tool never leaves the reply blank or hanging.
        let stepMessages = messages;
        for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
            const forceNoTool = iter === MAX_TOOL_ITERATIONS;
            const { response, suppressed } = await streamStep(stepMessages);
            if (!response.success) {
                return response;
            }
            const fullText = response.data || "";
            const toolCall = forceNoTool ? null : this.parseToolCall(fullText, toolsForModel);

            if (!toolCall) {
                if (iter === 0) {
                    // No tool at all. If a partial/invalid <tool> attempt was suppressed during
                    // streaming, reveal the raw text now so the reply is not blank (fullText is a
                    // superset of what was emitted, so the cumulative cursor stays consistent).
                    if (suppressed) onStreamUpdate(fullText);
                } else if (fullText.trim().length === 0 || emittedPrefix.trim().length === 0) {
                    // Answering after >=1 tool ran, but nothing visible was produced: surface a
                    // fallback so a tool call never resolves to an empty message.
                    const fallback = "I couldn't complete that request using the available tools.";
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
                    const toolResult = await this.mcpClient.callTool(tool.serverIndex, toolCall.name, toolCall.arguments);
                    followUpNote = `Tool result for ${toolCall.name}:\n${toolResult}\n\nPlease answer the original question using this result.`;
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    console.warn(`MCP tool '${toolCall.name}' failed, answering without it: ${errMsg}`);
                    followUpNote = `The tool ${toolCall.name} could not be run (error: ${errMsg}). Answer the original question directly, without the tool.`;
                } finally {
                    onStatus?.(null);
                }
            } else {
                console.warn(`MCP tool '${toolCall.name}' was requested but not available; answering without it.`);
                followUpNote = `The tool ${toolCall.name} is not available. Answer the original question directly, without any tool.`;
            }
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
        onStreamUpdate: (text: string) => void
    ): Promise<QueryResponse & { data?: string }> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        const argocdHeaders = getMappedHeaders(context.application);
        Object.entries(argocdHeaders).forEach(([key, value]) => {
            if (value) {
                const lowerKey = key.toLowerCase();
                if (lowerKey !== 'content-type' && lowerKey !== 'accept') {
                    headers[key] = value;
                }
            }
        });

        if (apiKey) {
            headers['Authorization'] = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
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
            const response = await fetch(`${baseURL}/v1/chat/completions`, {
                method: 'POST',
                headers,
                body,
                signal: internal.signal,
            });
            resetTimer();

            if (!response.ok || !response.body) {
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
                            ? `LLM backend error (${response.status}). The server returned an internal error.`
                            : (response.body ? await response.text() : response.statusText);
                }
                return {
                    success: false,
                    error: { status: response.status, message },
                };
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let text = '';

            // Parse a single SSE line. Returns an error response to short-circuit on, or null to continue.
            const handleLine = (line: string): (QueryResponse & { data?: string }) | null => {
                if (!line.startsWith('data: ')) return null;
                const data = line.slice(6).trim();
                if (data === '[DONE]' || !data) return null;

                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) {
                        text += content;
                        onStreamUpdate(text);
                    }
                    if (parsed.error) {
                        return {
                            success: false,
                            error: { status: 500, message: parsed.error.message || 'Unknown error' },
                        };
                    }
                } catch (_e) {
                    // ignore malformed chunks
                }
                return null;
            };

            while (true) {
                const { done, value } = await reader.read();
                resetTimer();
                if (done) break;

                // Keep the trailing partial line so events split across chunks are reassembled.
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const errorResponse = handleLine(line);
                    if (errorResponse) return errorResponse;
                }
            }

            // Flush a final event left in the buffer when the stream ends without a trailing newline.
            const trailing = handleLine(buffer);
            if (trailing) return trailing;

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

    private buildMessages(context: QueryContext, prompt: string, mcpTools?: McpTool[], history?: ChatTurn[]): Array<{ role: string; content: string }> {
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

        if (mcpTools && mcpTools.length > 0) {
            systemText += "\n\nAvailable tools:\n";
            for (const tool of mcpTools) {
                systemText += `- ${tool.name}: ${tool.description || "No description"}\n`;
                if (tool.inputSchema) {
                    systemText += `  Arguments schema: ${JSON.stringify(tool.inputSchema)}\n`;
                }
            }
            systemText += "\nTo use a tool, output a tool block using an EXACT tool name from the list above:\n";
            systemText += '<tool name="EXACT_TOOL_NAME">\n{ JSON arguments matching that tool\'s schema }\n</tool>\n';
            systemText += `For example:\n<tool name="${mcpTools[0].name}">\n${this.exampleArgs(mcpTools[0])}\n</tool>\n`;
            systemText += "Always wrap the arguments in the <tool>...</tool> tags with the exact tool name; never output bare JSON. A brief sentence before the block is allowed. If the request does not require a tool, answer directly without one.";
        }

        messages.push({ role: 'system', content: systemText });

        if (history && history.length > 0) {
            messages.push(...history);
        }

        messages.push({ role: 'user', content: prompt });
        return messages;
    }

    private parseToolCall(text: string, mcpTools?: McpTool[]): { name: string; arguments: any } | null {
        // Primary: a <tool name="X">{json}</tool> block anywhere in the reply (tolerate a preamble).
        const xml = text.match(/<tool\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/tool>/);
        if (xml) {
            const name = xml[1];
            // Only a real tool name is a call; this ignores the prompt's own name="EXACT_TOOL_NAME"
            // template and any <tool> syntax the model quotes inside a normal answer.
            if (!mcpTools || !mcpTools.some(t => t.name === name)) return null;
            try {
                return { name, arguments: JSON.parse(xml[2].trim()) };
            } catch (_e) {
                return { name, arguments: {} };
            }
        }

        // Fallback: the model emitted a bare or fenced JSON object instead of the wrapper.
        const json = this.extractJsonObject(text);
        if (!json || typeof json.value !== "object") return null;
        // A real bare-JSON call ends the model's turn; if prose follows the object it is incidental
        // JSON inside an answer, not a call, so ignore it (tolerate only a trailing ``` fence).
        if (text.slice(json.end).replace(/```/g, "").trim()) return null;
        const obj = json.value;

        // The object may name the tool explicitly.
        const named = obj.name ?? obj.tool;
        const namedArgs = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters;
        if (typeof named === "string" && namedArgs && typeof namedArgs === "object"
            && mcpTools && mcpTools.some(t => t.name === named)) {
            return { name: named, arguments: namedArgs };
        }

        // Otherwise infer the tool from the argument shape - only when exactly one tool fits, to
        // avoid guessing wrong (this recovers a nameless args object like {query, max_results}).
        if (mcpTools && mcpTools.length > 0) {
            const keys = Object.keys(obj);
            if (keys.length === 0) return null;
            const matches = mcpTools.filter(t => this.argsFitSchema(keys, t.inputSchema));
            if (matches.length === 1) {
                return { name: matches[0].name, arguments: obj };
            }
        }
        return null;
    }

    // Extract the first brace-balanced JSON object from arbitrary text (handles a ```json fence or
    // a bare object amid prose), skipping braces inside strings. Returns the parsed value and the
    // index just past its closing brace (so the caller can inspect what follows), or null.
    private extractJsonObject(text: string): { value: any; end: number } | null {
        const start = text.indexOf("{");
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    try { return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }; }
                    catch (_e) { return null; }
                }
            }
        }
        return null;
    }

    // True when every provided arg key is a known schema property and all required props are set.
    private argsFitSchema(keys: string[], schema: any): boolean {
        if (keys.length === 0) return false;
        const props = schema?.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : null;
        if (!props || props.length === 0) return false;
        if (!keys.every(k => props.includes(k))) return false;
        const required: string[] = Array.isArray(schema.required) ? schema.required : [];
        return required.every(r => keys.includes(r));
    }

    // A minimal example arguments object for the prompt, derived from a tool's schema.
    private exampleArgs(tool: McpTool): string {
        const schema = tool.inputSchema;
        const props = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
        const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
        const keys = required.length ? required : Object.keys(props).slice(0, 1);
        const obj: Record<string, any> = {};
        for (const k of keys) {
            const t = props[k]?.type;
            obj[k] = t === "integer" || t === "number" ? 1 : t === "boolean" ? true : "value";
        }
        return JSON.stringify(obj);
    }

    private attachmentLabel(type: AttachmentType): string {
        switch (type) {
            case AttachmentType.EVENTS: return 'Events';
            case AttachmentType.LOG: return 'Log';
            case AttachmentType.MANIFEST: return 'Manifest';
            default: return 'Attachment';
        }
    }
}
