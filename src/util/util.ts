import type { ChatMessage } from "../components/useChat";
import { AssistantSettings, Attachment, QueryContext } from "../model/provider";

export function generateId(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export const Kinds = {
    POD: 'Pod',
}

export class QueryContextImpl implements QueryContext {
    private _application: any;
    private _attachments: Attachment[];
    private _settings: AssistantSettings;
    private _mcpToken?: string;

    constructor(application: any, attachments: Attachment[], settings: AssistantSettings, mcpToken?: string) {
        this._application = application;
        this._attachments = attachments;
        this._settings = settings;
        this._mcpToken = mcpToken;
    }

    get application(): any {
        return this._application;
    }

    get attachments(): Attachment[] {
        return this._attachments;
    }

    get settings(): AssistantSettings {
        return this._settings;
    }

    get mcpToken(): string | undefined {
        return this._mcpToken;
    }
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

// Normalise a token into an Authorization header value: accept a raw token or one already
// prefixed with "Bearer ". Shared by the LLM and MCP request paths.
export const bearer = (token: string): string =>
    token.startsWith("Bearer ") ? token : `Bearer ${token}`;

// Argo CD proxy routing headers only (no Content-Type/Accept), for requests where those are set
// separately - e.g. the LLM chat-completion POST. Matches what getHeaders() emitted for these two
// keys: Argocd-Application-Name is always present ("namespace:name"), Argocd-Project-Name only when
// the project is non-empty. HTTP header names are case-insensitive, so the title-case here is
// equivalent to the lowercase Headers previously produced.
export function argocdProxyHeaders(application: any): Record<string, string> {
    const applicationName = application?.metadata?.name || "";
    const applicationNamespace = application?.metadata?.namespace || "";
    const project = application?.spec?.project || "";

    const headers: Record<string, string> = {
        "Argocd-Application-Name": `${applicationNamespace}:${applicationName}`,
    };
    if (project) {
        headers["Argocd-Project-Name"] = project;
    }
    return headers;
}

export function getHeaders(application: any): Headers {
    // Reuse argocdProxyHeaders for the Argocd-* routing pair (single source of truth for how the
    // app/namespace/project are extracted) and add the JSON Content-Type/Accept the API paths need.
    // Origin is a forbidden header name: fetch() silently drops any attempt to set it, so it is
    // omitted here. The proxy authenticates via the argocd.token cookie and the Argocd-* headers.
    const headers: Headers = new Headers({
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...argocdProxyHeaders(application),
    });
    // getHeaders has always emitted Argocd-Project-Name even when empty (argocdProxyHeaders omits
    // it for the chat POST path); preserve that byte-for-byte for the same-origin API paths.
    if (!headers.has('Argocd-Project-Name')) headers.set('Argocd-Project-Name', '');
    return headers;
}
