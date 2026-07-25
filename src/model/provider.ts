export type AssistantSettings = {
    model?: string;
    /** Accepted for backwards compatibility with existing settings ConfigMaps; ignored. */
    provider?: string;
    data?: any;
    maximumLogLines?: number;
    /** Overrides the built-in assistant persona/instructions. Falls back to the default when unset or blank. */
    systemPrompt?: string;
}

export enum AttachmentType {
    EVENTS = 0,
    LOG = 1,
    MANIFEST = 2,
    APP_SUMMARY = 3
}

export type Attachment = {
    content: string;
    mimeType: string;
    type: AttachmentType;
}

export type ChatTurn = {
    role: "user" | "assistant";
    content: string;
}

export type QueryContext = {
    /** Argo CD Application used to authorise the proxied LLM request; undefined until resolved. */
    application?: any;
    attachments: Attachment[];
    settings: AssistantSettings;
    /** User-provided Argo CD token (via the token flow) sent as a Bearer header to MCP servers; undefined when unset. */
    mcpToken?: string;
}

export type QueryError = {
    status: number;
    message: string;
}

export type QueryResponse = {
    success: boolean;
    data?: string
    error?: QueryError;
}

/** Live view of a configured MCP server, surfaced in the assistant UI. */
export type McpServerStatus = {
    url: string;
    /** Server-reported name once connected; falls back to the URL hostname before then. */
    name: string;
    /** True once the `initialize` handshake has completed for this server. */
    connected: boolean;
    /** Number of tools discovered from this server (0 until connected). */
    toolCount: number;
    /** Why this server is unusable (connect / tools-list failure), else undefined. */
    error?: string;
}

export interface QueryProvider {
    query(context: QueryContext, prompt: string, onStreamUpdate: (text: string) => void, signal?: AbortSignal, history?: ChatTurn[], onStatus?: (label: string | null) => void): Promise<QueryResponse>;
    /** Optional: live status of the given configured MCP server URLs, for UI display. */
    getMcpStatus?(urls: string[]): McpServerStatus[];
}
