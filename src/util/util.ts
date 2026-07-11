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

    constructor(application: any, attachments: Attachment[], settings: AssistantSettings) {
        this._application = application;
        this._attachments = attachments;
        this._settings = settings;
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

export function isAttachRequest(input: string): boolean {
    return matchesKeyword(input, 'ATTACH');
}

export function isTokenRequest(input: string): boolean {
    return matchesKeyword(input, 'TOKEN');
}

export function isCancelRequest(input: string): boolean {
    return matchesKeyword(input, 'CANCEL', 'QUIT', 'EXIT');
}

export function getMappedHeaders(application: any): Record<string, string | null | undefined> {
    const headers: Headers = getHeaders(application);
    const mappedHeaders: Record<string, string | null | undefined> = {}
    for (const [key, value] of headers.entries()) {
        mappedHeaders[key] = value;
    }
    return mappedHeaders;
}

export function getHeaders(application: any): Headers {
    const applicationName = application?.metadata?.name || "";
    const applicationNamespace = application?.metadata?.namespace || "";
    const project = application?.spec?.project || "";

    const headers: Headers = new Headers({
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://' + location.host,
        "Argocd-Application-Name": `${applicationNamespace}:${applicationName}`,
        "Argocd-Project-Name": `${project}`,
    });
    return headers;
}
