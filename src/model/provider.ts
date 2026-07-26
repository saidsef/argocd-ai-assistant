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

/**
 * One configured MCP server. `data.mcpServers` accepts a bare URL string or this object form, so a
 * deployment can pin a short name rather than depending on whatever the server reports about itself
 * (or on what can be derived from its hostname).
 */
export interface McpServerConfig {
    url: string;
    /** Overrides the derived handle. Optional; omit and one is derived from the server or hostname. */
    name?: string;
}

/** Live view of a configured MCP server, surfaced in the assistant UI. */
export type McpServerStatus = {
    url: string;
    /** Server-reported name once connected; falls back to the URL hostname before then. */
    name: string;
    /**
     * The short, unique string a user types to address this server. Derived once, in getMcpStatus,
     * and used by every surface - badge, welcome message, prompt roster, tool block, error fallback -
     * so none of them can advertise a different name from the one the matcher accepts. Sanitised,
     * so it is safe to render and safe to put in the system prompt.
     */
    handle: string;
    /** True once the `initialize` handshake has completed for this server. */
    connected: boolean;
    /** Number of tools discovered from this server (0 until connected). */
    toolCount: number;
    /** Why this server is unusable (connect / tools-list failure), else undefined. */
    error?: string;
}

/**
 * A server's one-word state. Defined here rather than in the UI because both the header badge and
 * the MCP roster in the system prompt report it, and they must not disagree - a model telling the
 * user a server is "connected" while the badge says "unavailable" is worse than either alone.
 *
 * Error beats connected deliberately: the real case is a server that completed the `initialize`
 * handshake and then failed `tools/list`, which is connected but unusable.
 */
export const mcpState = (s: McpServerStatus): "unavailable" | "connected" | "configured" =>
    s.error ? "unavailable" : s.connected ? "connected" : "configured";

export interface QueryProvider {
    query(context: QueryContext, prompt: string, onStreamUpdate: (text: string) => void, signal?: AbortSignal, history?: ChatTurn[], onStatus?: (label: string | null) => void): Promise<QueryResponse>;
    /** Optional: live status of the given configured MCP servers, for UI display. */
    getMcpStatus?(servers: McpServerConfig[]): McpServerStatus[];
}
