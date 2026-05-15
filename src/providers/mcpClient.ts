interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params?: any;
}

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id?: number;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: any;
    serverIndex: number;
}

export class McpClient {
    private urls: string[];
    private sessionIds: (string | null)[];
    private nextId = 1;

    constructor(urls: string[]) {
        this.urls = urls;
        this.sessionIds = new Array(urls.length).fill(null);
    }

    async connect(): Promise<string[]> {
        const errors: string[] = [];
        for (let i = 0; i < this.urls.length; i++) {
            try {
                const response = await this.request(i, {
                    jsonrpc: "2.0",
                    id: this.nextId++,
                    method: "initialize",
                    params: {
                        protocolVersion: "2024-11-05",
                        capabilities: {},
                        clientInfo: {
                            name: "argocd-ai-assistant",
                            version: "1.0.0"
                        }
                    }
                });

                if (response.error) {
                    errors.push(`MCP server ${i} (${this.urls[i]}) initialization failed: ${response.error.message}`);
                    continue;
                }

                await this.request(i, {
                    jsonrpc: "2.0",
                    method: "notifications/initialized"
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`MCP server ${i} (${this.urls[i]}) unreachable: ${msg}`);
            }
        }
        return errors;
    }

    async listAllTools(): Promise<McpTool[]> {
        const allTools: McpTool[] = [];
        for (let i = 0; i < this.urls.length; i++) {
            try {
                const response = await this.request(i, {
                    jsonrpc: "2.0",
                    id: this.nextId++,
                    method: "tools/list",
                    params: {}
                });

                if (response.error) {
                    console.error(`MCP server ${i} tools/list failed:`, response.error.message);
                    continue;
                }

                const tools = response.result?.tools || [];
                for (const tool of tools) {
                    allTools.push({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                        serverIndex: i
                    });
                }
            } catch (err) {
                console.error(`MCP server ${i} unreachable during tools/list:`, err);
            }
        }
        return allTools;
    }

    async callTool(serverIndex: number, name: string, args: any): Promise<string> {
        const response = await this.request(serverIndex, {
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "tools/call",
            params: {
                name,
                arguments: args
            }
        });

        if (response.error) {
            throw new Error(`Tool call failed: ${response.error.message}`);
        }

        const result = response.result;
        if (result?.isError) {
            throw new Error(`Tool execution error: ${this.extractTextContent(result.content)}`);
        }

        return this.extractTextContent(result?.content);
    }

    private async request(serverIndex: number, body: JsonRpcRequest): Promise<JsonRpcResponse> {
        const url = this.urls[serverIndex];
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream"
        };

        const sessionId = this.sessionIds[serverIndex];
        if (sessionId) {
            headers["Mcp-Session-Id"] = sessionId;
        }

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`MCP server ${serverIndex} returned HTTP ${response.status}`);
        }

        const newSessionId = response.headers.get("mcp-session-id");
        if (newSessionId) {
            this.sessionIds[serverIndex] = newSessionId;
        }

        // Notifications have no id and servers may return 202 Accepted with no body
        if (body.id === undefined || response.status === 202) {
            return { jsonrpc: "2.0", result: {} };
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
            return this.parseSseResponse(response, body.id);
        }

        return response.json();
    }

    private async parseSseResponse(response: Response, expectedId?: number): Promise<JsonRpcResponse> {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error("No response body for SSE stream");
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const parsed: JsonRpcResponse = JSON.parse(data);
                    if (expectedId === undefined || parsed.id === expectedId) {
                        return parsed;
                    }
                } catch (_e) {
                    // ignore malformed chunks
                }
            }
        }

        throw new Error("Expected JSON-RPC response not found in SSE stream");
    }

    private extractTextContent(content: any[]): string {
        if (!Array.isArray(content)) return String(content ?? "");
        return content
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("\n");
    }
}
