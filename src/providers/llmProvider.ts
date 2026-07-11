import { AttachmentType, ChatTurn, McpServerStatus, QueryContext, QueryProvider, QueryResponse } from "../model/provider";
import { getMappedHeaders, mcpConfigured } from "../util/util";
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

    async query(context: QueryContext, prompt: string, onStreamUpdate: (text: string) => void, signal?: AbortSignal, history?: ChatTurn[]): Promise<QueryResponse> {
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
                    const connectErrors = await this.mcpClient.connect();
                    if (connectErrors.length > 0) {
                        console.error("MCP connection errors:", connectErrors);
                    }
                }
                if (!this.mcpTools) {
                    this.mcpTools = await this.mcpClient.listAllTools();
                }
                mcpTools = this.mcpTools;
                if (!mcpTools || mcpTools.length === 0) {
                    return {
                        success: false,
                        error: { status: 500, message: "MCP servers are configured but no tools were discovered. Check that the servers are running and expose tools." }
                    };
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                return {
                    success: false,
                    error: { status: 500, message: `MCP initialization failed: ${errMsg}` }
                };
            }
        }

        const messages = this.buildMessages(context, prompt, mcpTools, history);

        // When MCP tools are available the model may reply with only a <tool ...> call.
        // Keep that raw XML out of the UI: it is internal (the visible answer is produced
        // by the follow-up completion below), and streaming it would corrupt the follow-up's
        // deltas, which the UI tracks as a single cumulative string across the whole query.
        const hasTools = !!mcpTools && mcpTools.length > 0;
        let toolXmlSuppressed = false;
        const firstUpdate = hasTools
            ? (text: string) => {
                if (toolXmlSuppressed) return;
                if (text.trimStart().startsWith("<tool")) {
                    toolXmlSuppressed = true;
                    return;
                }
                onStreamUpdate(text);
            }
            : onStreamUpdate;

        const response = await this.sendChatCompletion(baseURL, model, apiKey, context, messages, signal, firstUpdate);
        if (!response.success) {
            return response;
        }

        const fullText = response.data || "";
        const toolCall = this.parseToolCall(fullText);
        if (toolCall && this.mcpClient && mcpTools) {
            const tool = mcpTools.find(t => t.name === toolCall.name);
            if (tool) {
                try {
                    const toolResult = await this.mcpClient.callTool(tool.serverIndex, toolCall.name, toolCall.arguments);
                    const followUpMessages = [
                        ...messages,
                        { role: "assistant", content: fullText },
                        {
                            role: "user",
                            content: `Tool result for ${toolCall.name}:\n${toolResult}\n\nPlease answer the original question using this result.`
                        }
                    ];
                    const followUpResponse = await this.sendChatCompletion(baseURL, model, apiKey, context, followUpMessages, signal, onStreamUpdate);
                    return { success: followUpResponse.success, error: followUpResponse.error };
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    return {
                        success: false,
                        error: { status: 500, message: `Tool call failed: ${errMsg}` }
                    };
                }
            } else {
                return {
                    success: false,
                    error: { status: 500, message: `Tool '${toolCall.name}' is not available. The model attempted to use a tool that was not discovered from any configured MCP server.` }
                };
            }
        }

        // Reached only when no tool call was taken. If we suppressed a partial/invalid
        // <tool> attempt during streaming, surface the text now so the reply is not blank.
        if (toolXmlSuppressed) {
            onStreamUpdate(fullText);
        }
        return { success: true, data: fullText };
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

        const response = await fetch(`${baseURL}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body,
            signal,
        });

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
            systemText += "\nIf you need to use a tool, respond ONLY with:\n";
            systemText += '<tool name="TOOL_NAME">\n{JSON arguments matching the schema}\n</tool>\n';
            systemText += "Do not include any other text when using a tool.";
        }

        messages.push({ role: 'system', content: systemText });

        if (history && history.length > 0) {
            messages.push(...history);
        }

        messages.push({ role: 'user', content: prompt });
        return messages;
    }

    private parseToolCall(text: string): { name: string; arguments: any } | null {
        const trimmed = text.trim();
        const match = trimmed.match(/^<tool\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/tool>$/);
        if (!match) return null;

        const name = match[1];
        const argsText = match[2].trim();
        try {
            const args = JSON.parse(argsText);
            return { name, arguments: args };
        } catch (_e) {
            return { name, arguments: {} };
        }
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
