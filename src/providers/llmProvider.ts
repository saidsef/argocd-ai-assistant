import { QueryContext, QueryProvider, QueryResponse } from "../model/provider";
import { getMappedHeaders } from "../util/util";
import { FeatureFlags, isFeatureEnabled } from "../featureFlags";
import { McpClient, McpTool } from "./mcpClient";

export class LlmProvider implements QueryProvider {

    private mcpClient?: McpClient;
    private mcpTools?: McpTool[];

    async query(context: QueryContext, prompt: string, onStreamUpdate: (text: string) => void, signal?: AbortSignal): Promise<QueryResponse> {
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
        if (isFeatureEnabled(FeatureFlags.ArgoCDMCP) && mcpServerUrls && mcpServerUrls.length > 0) {
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

        const messages = this.buildMessages(context, prompt, mcpTools);

        const response = await this.sendChatCompletion(baseURL, model, apiKey, context, messages, signal, onStreamUpdate);
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

    private buildMessages(context: QueryContext, prompt: string, mcpTools?: McpTool[]): Array<{ role: string; content: string }> {
        const messages: Array<{ role: string; content: string }> = [];

        let contextText = "";
        if (context.attachments.length > 0) {
            contextText = "Context:\n";
            for (const attachment of context.attachments) {
                const label = this.attachmentLabel(attachment.type);
                contextText += `\n[${label} - ${attachment.mimeType}]:\n${attachment.content}\n`;
            }
        }

        if (mcpTools && mcpTools.length > 0) {
            if (contextText) contextText += "\n";
            contextText += "Available tools:\n";
            for (const tool of mcpTools) {
                contextText += `- ${tool.name}: ${tool.description || "No description"}\n`;
                if (tool.inputSchema) {
                    contextText += `  Arguments schema: ${JSON.stringify(tool.inputSchema)}\n`;
                }
            }
            contextText += "\nIf you need to use a tool, respond ONLY with:\n";
            contextText += '<tool name="TOOL_NAME">\n{JSON arguments matching the schema}\n</tool>\n';
            contextText += "Do not include any other text when using a tool.";
        }

        if (contextText) {
            messages.push({ role: 'system', content: contextText });
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

    private attachmentLabel(type: number): string {
        switch (type) {
            case 0: return 'Events';
            case 1: return 'Log';
            case 2: return 'Manifest';
            default: return 'Attachment';
        }
    }
}
