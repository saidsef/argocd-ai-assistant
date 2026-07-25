import type { ChatMessage } from "../components/useChat";

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

// Strips managedFields + last-applied-configuration to cut tokens; returns a copy.
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

// True when `term` appears as a whole word in `text`, case-insensitive. Unlike matchesKeyword
// (whole-string equality) this matches an occurrence anywhere in the text, with word boundaries so
// "docs" matches "hey docs, search" but not "documentation"/"docside". Tolerant of names containing
// spaces/dots/hyphens (boundary = start/end or any non-alphanumeric char).
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

// MCP is active whenever at least one server URL is configured in settings.data.mcpServers.
export const mcpConfigured = (servers?: string[]): boolean =>
    Array.isArray(servers) && servers.length > 0;

// One sentence naming the configured MCP servers and how to invoke them, appended to the welcome
// message. Nothing in the UI used to say that naming a server is what enables its tools - it was
// documented only in docs/architecture.md, so the feature was effectively undiscoverable.
export function mcpWelcomeHint(names: string[]): string {
    if (names.length === 0) return "";
    const list = names.length === 1
        ? `**${names[0]}**`
        : names.slice(0, -1).map((n) => `**${n}**`).join(", ") + ` and **${names[names.length - 1]}**`;
    return ` I can also use ${names.length === 1 ? "the tool server" : "the tool servers"} ${list}` +
        ` - name one in your message (for example *${names[0]}, ...*) to use its tools.`;
}

// Normalise a token into an Authorization header value: accept a raw token or one already
// prefixed with "Bearer ". Shared by the LLM and MCP request paths. The prefix test is
// case-insensitive because the scheme is (RFC 7235) - a token pasted as "bearer abc" used to be
// double-prefixed into "Bearer bearer abc" and rejected by the backend.
export const bearer = (token: string): string =>
    /^bearer\s/i.test(token) ? token : `Bearer ${token}`;

// The message of anything thrown, for logs and user-facing errors alike. `catch` binds `unknown`,
// and every call site needs the same two-line dance to get a string out of it.
export const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

// Routing headers for every Argo CD request - the same-origin REST API and the proxy extension
// alike. Both Argocd-* headers are always emitted: the proxy rejects a request that omits either
// (400 `header "Argocd-Project-Name" must be provided`), so there is nothing to gain by dropping an
// empty one. `extra` carries the per-call Content-Type/Accept, which differ between the JSON API
// paths and the streaming chat POST. Origin is a forbidden header name - fetch() silently drops any
// attempt to set it - so it is omitted; the proxy authenticates via the argocd.token cookie.
// HTTP header names are case-insensitive, so the title-case here matches the lowercase form too.
export function argocdHeaders(application: any, extra?: Record<string, string>): Record<string, string> {
    const namespace = application?.metadata?.namespace || "";
    const name = application?.metadata?.name || "";
    return {
        "Argocd-Application-Name": `${namespace}:${name}`,
        "Argocd-Project-Name": application?.spec?.project || "",
        ...extra,
    };
}

// Headers for the same-origin Argo CD REST API (events, logs, applications).
export const argocdApiHeaders = (application: any): Record<string, string> =>
    argocdHeaders(application, { "Content-Type": "application/json", "Accept": "application/json" });

// True once an Application carries everything the proxy needs to authorise a request. All three are
// required: the proxy 400s on an empty namespace/name and 401s when the project does not match the
// named Application's own project.
export const canRouteToProxy = (application: any): boolean =>
    !!application?.metadata?.name && !!application?.metadata?.namespace && !!application?.spec?.project;

// Abort an Argo CD API request that has not completed within this window. argocd-server can stall
// (a slow repo-server, a wedged cluster cache) and none of these calls used to have a deadline, so
// the assistant would sit on a spinner - notably the log-fetch flow, which has no cancel button.
const ARGOCD_REQUEST_MS = 30000;

/**
 * GET a same-origin Argo CD API endpoint with this extension's standard auth/routing headers and a
 * deadline. Throws a message naming `what` on timeout or a non-2xx status; returns the Response
 * otherwise (streaming callers still need to check `body`).
 *
 * The timeout covers the body as well as the headers, so a streaming caller must allow for the whole
 * stream (service/logs.ts passes a longer window; its stream is bounded by `follow=false`+`tailLines`).
 */
export async function argocdFetch(
    url: string,
    application: any,
    what: string,
    timeoutMs: number = ARGOCD_REQUEST_MS
): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: argocdApiHeaders(application),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
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
