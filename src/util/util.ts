import type { ChatMessage } from "../components/useChat";
import type { McpServerConfig } from "../model/provider";

export function generateId(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export const Kinds = {
    POD: 'Pod',
}

export function getResourceIdentifier(resource: any): string {
    if (resource == undefined) return "Undefined";
    const uid = resource.metadata?.uid;
    if (uid) return uid;
    const namespace = resource.metadata?.namespace ?? "";
    const kind = resource.kind ?? "";
    const name = resource.metadata?.name ?? "";
    return kind + "-" + namespace + "-" + name;
}

export function getContainers(resource: any): string[] {
    const containers = resource?.kind === Kinds.POD
        ? resource?.spec?.containers
        : resource?.spec?.template?.spec?.containers;
    return Array.isArray(containers) ? containers.map((c: any) => c.name) : [];
}

/** A copy of a manifest without managedFields and the last-applied annotation, which only cost tokens. */
export function stripManifestNoise(resource: any): any {
    if (!resource || typeof resource !== "object" || typeof resource.metadata !== "object" || resource.metadata === null) {
        return resource;
    }
    const { managedFields, annotations, ...restMetadata } = resource.metadata;
    if (annotations && typeof annotations === "object") {
        const { ["kubectl.kubernetes.io/last-applied-configuration"]: _omit, ...restAnnotations } = annotations;
        restMetadata.annotations = restAnnotations;
    }
    return { ...resource, metadata: restMetadata };
}

/** A state updater that appends a UI-only message, which never goes to the model. */
export function injectMessage(
    msg: string,
    role: "user" | "assistant" = "assistant"
): (prev: ChatMessage[]) => ChatMessage[] {
    return (prev) => [
        ...prev,
        {
            id: generateId(),
            role,
            parts: [{ type: "text" as const, text: msg }],
            local: true
        }
    ];
}

function matchesKeyword(input: string, ...keywords: string[]): boolean {
    if (!input) return false;
    const upper = input.toUpperCase();
    return keywords.some((k) => upper.localeCompare(k, undefined, { sensitivity: 'base' }) === 0);
}

/**
 * Whether `term` appears anywhere in `text` as a whole word, in any case. "docs" matches "hey docs,
 * search" but not "documentation". Any character that is not a letter or digit is a boundary.
 */
export function containsWord(text: string, term: string): boolean {
    if (!text || !term) return false;
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])(${esc})([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

export function isAttachRequest(input: string): boolean {
    return matchesKeyword(input, 'ATTACH');
}

export function isTokenRequest(input: string): boolean {
    return matchesKeyword(input, 'TOKEN');
}

export function isCancelRequest(input: string): boolean {
    return matchesKeyword(input, 'CANCEL', 'QUIT', 'EXIT');
}

/**
 * Read `settings.data.mcpServers` into a checked shape. The setting is hand-written into a
 * ConfigMap. An entry that is neither a URL string nor an object with a string `url` is dropped,
 * and costs that one server only. See #123.
 */
export function parseMcpServers(raw: unknown): McpServerConfig[] {
    if (!Array.isArray(raw)) return [];
    const out: McpServerConfig[] = [];
    for (const entry of raw) {
        if (typeof entry === "string") {
            const url = entry.trim();
            if (url) out.push({ url });
        } else if (entry && typeof entry === "object" && typeof (entry as any).url === "string") {
            const url = (entry as any).url.trim();
            const name = typeof (entry as any).name === "string" ? (entry as any).name.trim() : undefined;
            // Only a literal `true` opts in, so a typo such as "false" never sends the token.
            const token = (entry as any).token === true;
            if (url) out.push({ url, ...(name ? { name } : {}), ...(token ? { token } : {}) });
        }
    }
    return out;
}

/** Whether at least one MCP server is configured, which is what turns MCP on. */
export const mcpConfigured = (servers?: McpServerConfig[]): boolean =>
    Array.isArray(servers) && servers.length > 0;

/**
 * One sentence for the welcome message that names the configured MCP servers and how to use them.
 * It shows handles as code spans, because the user types them, and a remote server's punctuation
 * cannot break a code span. See #123.
 */
export function mcpWelcomeHint(handles: string[]): string {
    if (handles.length === 0) return "";
    const list = handles.length === 1
        ? `\`${handles[0]}\``
        : handles.slice(0, -1).map((h) => `\`${h}\``).join(", ") + ` and \`${handles[handles.length - 1]}\``;
    return ` I can also use ${handles.length === 1 ? "the tool server" : "the tool servers"} ${list}` +
        ` - name one in your message (for example *${handles[0]}, ...*) to use its tools.`;
}

/** Handles of the servers whose entry sets `token: true`, in the order they are configured. */
export function tokenServerHandles(servers: McpServerConfig[], status: Array<{ handle: string }>): string[] {
    return servers.flatMap((s, i) => (s.token ? [status[i]?.handle || s.name || `server ${i + 1}`] : []));
}

/**
 * The message that opens the token flow and names each server that will receive a token. When no
 * entry sets `token: true`, it says why the flow cannot open.
 */
export function tokenPromptMessage(handles: string[]): string {
    if (handles.length === 0) {
        return "None of the configured MCP servers accepts an Argo CD token, so I have nowhere to send one. An administrator can add `token: true` to a server's entry in `data.mcpServers`.";
    }
    const list = handles.map((h) => `\`${h}\``).join(", ");
    return `Please enter your Argo CD token. I will send it only to ${handles.length === 1 ? "the MCP server" : "the MCP servers"} ${list}.`;
}

/**
 * A token as an Authorization header value, with "Bearer " added unless it is already there. The
 * prefix test ignores case, because the scheme is case-insensitive (RFC 7235). See #119.
 */
export const bearer = (token: string): string =>
    /^bearer\s/i.test(token) ? token : `Bearer ${token}`;

/** The message of anything thrown, for logs and user-facing errors, because `catch` binds `unknown`. */
export const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

/**
 * Routing headers for every Argo CD request, to the REST API and the proxy extension alike. Both
 * Argocd-* headers are always sent, because the proxy rejects a request without either. `extra`
 * carries the Content-Type and Accept of each call. A page cannot set Origin, and the proxy
 * authenticates with the argocd.token cookie instead.
 */
export function argocdHeaders(application: any, extra?: Record<string, string>): Record<string, string> {
    const namespace = application?.metadata?.namespace || "";
    const name = application?.metadata?.name || "";
    return {
        "Argocd-Application-Name": `${namespace}:${name}`,
        "Argocd-Project-Name": application?.spec?.project || "",
        ...extra,
    };
}

/** Headers for the same-origin Argo CD REST API, which serves events, logs and applications. */
export const argocdApiHeaders = (application: any): Record<string, string> =>
    argocdHeaders(application, { "Content-Type": "application/json", "Accept": "application/json" });

/**
 * Whether an Application carries the name, namespace and project that the proxy needs. The proxy
 * returns 400 for an empty name or namespace, and 401 when the project does not match.
 */
export const canRouteToProxy = (application: any): boolean =>
    !!application?.metadata?.name && !!application?.metadata?.namespace && !!application?.spec?.project;

/**
 * Deadline for an Argo CD API request, because argocd-server can stall on a slow repo-server or a
 * wedged cluster cache. See #123.
 */
const ARGOCD_REQUEST_MS = 30000;

/**
 * GET a same-origin Argo CD API endpoint with the routing headers and a deadline. It throws a
 * message naming `what` on a timeout or a non-2xx status, and otherwise returns the Response.
 *
 * A streaming caller passes a longer `timeoutMs`, because the deadline covers the body as well as
 * the headers. `options.signal` drops the request when the caller cancels, which unwinds as an
 * AbortError for the caller to filter.
 */
export async function argocdFetch(
    url: string,
    application: any,
    what: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? ARGOCD_REQUEST_MS;
    const signal = options?.signal;
    let response: Response;
    try {
        const deadline = AbortSignal.timeout(timeoutMs);
        response = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: argocdApiHeaders(application),
            signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
    } catch (err) {
        // AbortSignal.any adopts the reason of whichever signal fired first, so a caller cancel is an
        // AbortError and the deadline a TimeoutError. The `signal?.aborted` test is what keeps the
        // no-signal behaviour byte-identical for callers that pass none.
        if (err instanceof Error && err.name === "AbortError" && signal?.aborted) throw err;
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
            throw new Error(`${what} request timed out after ${Math.round(timeoutMs / 1000)}s. The Argo CD API may be unreachable or overloaded.`);
        }
        throw err;
    }
    if (!response.ok) {
        throw new Error(`${what} API returned ${response.status} ${response.statusText}`);
    }
    return response;
}
