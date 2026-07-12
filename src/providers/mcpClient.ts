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

export interface McpServerInfo {
    name?: string;
    version?: string;
}

// Abort a JSON-RPC request that gets no response within this window, so a hung MCP server
// surfaces as a tracked error / LLM-only fallback instead of freezing the assistant.
const MCP_REQUEST_MS = 30000;

export class McpClient {
    private urls: string[];
    private sessionIds: (string | null)[];
    // Optional Argo CD token (from the token flow) sent as a Bearer header on every request.
    private authToken?: string;
    // Per-server identity from the `initialize` handshake; null until connected.
    private serverInfos: (McpServerInfo | null)[];
    // Failures from the most recent connect() / listAllTools(), kept separate so each is
    // reset by its own method and never compounds across calls.
    private connectErrors: string[] = [];
    private toolErrors: string[] = [];
    private nextId = 1;

    constructor(urls: string[]) {
        this.urls = urls;
        this.sessionIds = new Array(urls.length).fill(null);
        this.serverInfos = new Array(urls.length).fill(null);
    }

    // Set/replace the Bearer token used to authenticate MCP requests. Called per query so a token
    // entered mid-session applies to subsequent requests; undefined clears it (no header sent).
    setAuthToken(token?: string): void {
        this.authToken = token?.trim() || undefined;
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

                this.serverInfos[i] = response.result?.serverInfo ?? {};

                await this.request(i, {
                    jsonrpc: "2.0",
                    method: "notifications/initialized"
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`MCP server ${i} (${this.urls[i]}) unreachable: ${msg}`);
            }
        }
        this.connectErrors = errors;
        return errors;
    }

    async listAllTools(): Promise<McpTool[]> {
        const allTools: McpTool[] = [];
        this.toolErrors = [];
        for (let i = 0; i < this.urls.length; i++) {
            try {
                const response = await this.request(i, {
                    jsonrpc: "2.0",
                    id: this.nextId++,
                    method: "tools/list",
                    params: {}
                });

                if (response.error) {
                    this.toolErrors.push(`MCP server ${i} (${this.urls[i]}) tools/list failed: ${response.error.message}`);
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
                const msg = err instanceof Error ? err.message : String(err);
                this.toolErrors.push(`MCP server ${i} (${this.urls[i]}) unreachable during tools/list: ${msg}`);
            }
        }
        return allTools;
    }

    // Per-server identity captured during connect(); a non-null entry means that
    // server completed the `initialize` handshake (i.e. is connected).
    getServerInfos(): (McpServerInfo | null)[] {
        return this.serverInfos;
    }

    // Connect / tools-list failures from the most recent connect()/listAllTools(); the provider
    // logs these to the browser console when MCP falls back to LLM-only. Returns a copy so
    // callers cannot mutate the client's retained state.
    getErrors(): string[] {
        return [...this.connectErrors, ...this.toolErrors];
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

        // Normalise like the LLM apiKey path: accept a raw token or one already prefixed.
        if (this.authToken) {
            headers["Authorization"] = this.authToken.startsWith("Bearer ") ? this.authToken : `Bearer ${this.authToken}`;
        }

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(MCP_REQUEST_MS)
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
