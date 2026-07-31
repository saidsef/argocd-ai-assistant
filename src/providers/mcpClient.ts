import { readLines, sseData } from "../util/stream";
import { bearer, errorMessage } from "../util/util";

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

interface McpServerInfo {
    name?: string;
}

// Abort a JSON-RPC request that gets no response within this window, so a hung MCP server
// surfaces as a tracked error / LLM-only fallback instead of freezing the assistant.
const MCP_REQUEST_MS = 30000;

// A user Stop is not a server failure, and the two arrive through the same channel: `AbortSignal.any`
// propagates the reason of whichever signal fired first, so a caller cancel surfaces as AbortError
// and the MCP_REQUEST_MS deadline as TimeoutError. Recording the former as `unreachable` painted
// every configured server red on the badge - and, because those errors feed the MCP roster, told the
// model in the system prompt that every server was down.
const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

export class McpClient {
    private urls: string[];
    private sessionIds: (string | null)[];
    // Optional Argo CD token (from the token flow) sent as a Bearer header on every request.
    private authToken?: string;
    // Per-server identity from the `initialize` handshake; null until connected.
    private serverInfos: (McpServerInfo | null)[];
    // Failures from the most recent connect() / listAllTools(), indexed by server so the UI can
    // attribute one. Kept separate so each is reset by its own method and never compounds.
    private connectErrors: (string | undefined)[];
    private toolErrors: (string | undefined)[];
    private nextId = 1;

    constructor(urls: string[]) {
        this.urls = urls;
        this.sessionIds = new Array(urls.length).fill(null);
        this.serverInfos = new Array(urls.length).fill(null);
        this.connectErrors = new Array(urls.length).fill(undefined);
        this.toolErrors = new Array(urls.length).fill(undefined);
    }

    // Set/replace the Bearer token used to authenticate MCP requests. Called per query so a token
    // entered mid-session applies to subsequent requests; undefined clears it (no header sent).
    setAuthToken(token?: string): void {
        this.authToken = token?.trim() || undefined;
    }

    async connect(signal?: AbortSignal): Promise<void> {
        // Connect all servers concurrently so first-query latency is the slowest server, not their sum.
        // Errors are written to a fixed-size slot per index (completion order is non-deterministic) so
        // per-server messages stay deterministic and attributable.
        const errs = new Array<string | undefined>(this.urls.length).fill(undefined);
        await Promise.all(this.urls.map(async (_url, i) => {
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
                }, signal);

                if (response.error) {
                    errs[i] = `initialization failed: ${response.error.message}`;
                    return;
                }

                this.serverInfos[i] = response.result?.serverInfo ?? {};

                // Sequential within a server: this follow-up must come after the initialize response.
                await this.request(i, {
                    jsonrpc: "2.0",
                    method: "notifications/initialized"
                }, signal);
            } catch (err) {
                // Let a cancel reject the whole probe (see isAbort); a TimeoutError is still recorded.
                if (isAbort(err)) throw err;
                errs[i] = `unreachable: ${errorMessage(err)}`;
            }
        }));
        this.connectErrors = errs;
    }

    async listAllTools(signal?: AbortSignal): Promise<McpTool[]> {
        // Query every server's tools concurrently. Results are collected per index and flattened in
        // server order at the end so the aggregate list stays server-major (consumers key by
        // serverIndex/name, so order is not load-bearing - this just keeps output stable).
        const perServer = Array.from({ length: this.urls.length }, () => [] as McpTool[]);
        const errs = new Array<string | undefined>(this.urls.length).fill(undefined);
        await Promise.all(this.urls.map(async (_url, i) => {
            try {
                const response = await this.request(i, {
                    jsonrpc: "2.0",
                    id: this.nextId++,
                    method: "tools/list",
                    params: {}
                }, signal);

                if (response.error) {
                    errs[i] = `tools/list failed: ${response.error.message}`;
                    return;
                }

                const tools = response.result?.tools || [];
                perServer[i] = tools.map((tool: any) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    serverIndex: i
                }));
            } catch (err) {
                if (isAbort(err)) throw err;
                errs[i] = `unreachable during tools/list: ${errorMessage(err)}`;
            }
        }));
        this.toolErrors = errs;
        return perServer.flat();
    }

    // Per-server identity captured during connect(); a non-null entry means that server completed
    // the `initialize` handshake (i.e. is connected). A copy, so callers cannot mutate retained
    // state (this is called on every render by the UI badge).
    getServerInfos(): (McpServerInfo | null)[] {
        return this.serverInfos.slice();
    }

    // Connect / tools-list failure per server index (undefined where the server is healthy), from
    // the most recent connect()/listAllTools(). The provider logs these and surfaces them on the UI
    // badge when MCP falls back to LLM-only. Returns a copy so callers cannot mutate retained state.
    getErrors(): (string | undefined)[] {
        return this.urls.map((_url, i) => this.connectErrors[i] ?? this.toolErrors[i]);
    }

    async callTool(serverIndex: number, name: string, args: any, signal?: AbortSignal): Promise<string> {
        const response = await this.request(serverIndex, {
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "tools/call",
            params: {
                name,
                arguments: args
            }
        }, signal);

        if (response.error) {
            throw new Error(`Tool call failed: ${response.error.message}`);
        }

        const result = response.result;
        if (result?.isError) {
            throw new Error(`Tool execution error: ${this.extractTextContent(result.content)}`);
        }

        return this.extractTextContent(result?.content);
    }

    private async request(serverIndex: number, body: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
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
            headers["Authorization"] = bearer(this.authToken);
        }

        // Compose the caller's signal with the request timeout so pressing Stop mid tool call
        // actually cancels it, instead of leaving it in flight for up to MCP_REQUEST_MS.
        const timeout = AbortSignal.timeout(MCP_REQUEST_MS);
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout
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
        if (!response.body) {
            throw new Error("No response body for SSE stream");
        }

        for await (const line of readLines(response.body)) {
            const data = sseData(line);
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
