export type AssistantSettings = {
    model?: string;
    provider: string;
    data?: any;
    maximumLogLines?: number;
}

export interface Logs {
    container: string;
    entries: string;
}

export type Events = {
    apiVersion: string,
    items: any[]
}

export enum AttachmentType {
    EVENTS = 0,
    LOG = 1,
    MANIFEST = 2
}

export type Attachment = {
    content: string;
    mimeType: string;
    type: AttachmentType;
}

export interface QueryContext {
    get application(): any;
    get conversationID(): string;
    get data(): string;
    get attachments(): Attachment[];
    get settings(): AssistantSettings;
}

export type QueryError = {
    status: number;
    message: string;
}

export type QueryResponse = {
    success: boolean;
    conversationID?: string,
    data?: string
    error?: QueryError;
}

export interface QueryProvider {
    setContext(context: QueryContext): void;
    query(context: QueryContext, prompt: string, onStreamUpdate: (text: string) => void, signal?: AbortSignal): Promise<QueryResponse>
}
