import type { ChatMessage } from "../components/useChat";
import { AssistantSettings, Attachment, AttachmentType, QueryContext } from "../model/provider";

export function generateId(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export const Kinds = {
    POD: 'Pod',
    REPLICA_SET: 'ReplicaSet',
    DEPLOYMENT: 'Deployment',
    STATEFUL_SET: 'StatefulSet',
    JOB: 'Job',
    ROLLOUT: 'Rollout'
}

export const ContentType = {
    APPLICATION_JSON: 'application/json',
    APPLICATION_XML: 'application/xml',
    TEXT_PLAIN: 'text/plain',
    TEXT_HTML: 'text/html',
    APPLICATION_FORM_URLENCODED: 'application/x-www-form-urlencoded',
    MULTIPART_FORM_DATA: 'multipart/form-data',
} as const;

export class QueryContextImpl implements QueryContext {
    private _application: any;
    private _conversationID: string;
    private _data: string;
    private _attachments: Attachment[];
    private _settings: AssistantSettings;

    constructor(application: any, conversationID: string, data: string, attachments: Attachment[], settings: AssistantSettings) {
        this._application = application;
        this._conversationID = conversationID;
        this._data = data;
        this._attachments = attachments;
        this._settings = settings;
    }

    get application(): any {
        return this._application;
    }

    get conversationID(): string {
        return this._conversationID;
    }

    get data(): any {
        return this._data;
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

// Strips managedFields and the last-applied-configuration annotation to cut token bloat.
// Returns a new object; the original is never mutated.
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
            parts: [{ type: "text" as const, text: msg }]
        }
    ];
}

export function isAttachRequest(input: string): boolean {
    if (input === undefined || input === "") return false;
    return input.toUpperCase().localeCompare('ATTACH', undefined, { sensitivity: 'base' }) == 0;
}

export function isTokenRequest(input: string): boolean {
    if (input === undefined || input === "") return false;
    return input.toUpperCase().localeCompare('TOKEN', undefined, { sensitivity: 'base' }) == 0;
}

export function isCancelRequest(input: string): boolean {
    if (input === undefined || input === "") return false;
    return input.toUpperCase().localeCompare('CANCEL', undefined, { sensitivity: 'base' }) == 0 ||
        input.toUpperCase().localeCompare('QUIT', undefined, { sensitivity: 'base' }) == 0 ||
        input.toUpperCase().localeCompare('EXIT', undefined, { sensitivity: 'base' }) == 0;
}

export function getFilename(attachment: Attachment): string {
    switch (attachment.type) {
        case AttachmentType.LOG: return "logs.json"
        case AttachmentType.EVENTS: return "events.json"
        case AttachmentType.MANIFEST: return "manifest.json"
    }
}

export function getMappedHeaders(application: any): Record<string, string | null | undefined> {
    const headers: Headers = getHeaders(application);
    var mappedHeaders: Record<string, string | null | undefined> = {}
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
        'Content-Type': ContentType.APPLICATION_JSON,
        'Accept': ContentType.APPLICATION_JSON,
        'Origin': 'https://' + location.host,
        "Argocd-Application-Name": `${applicationNamespace}:${applicationName}`,
        "Argocd-Project-Name": `${project}`,
    });
    return headers;
}
