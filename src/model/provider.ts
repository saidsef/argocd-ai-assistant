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

export type ChatTurn = {
    role: "user" | "assistant";
    content: string;
}

export interface QueryContext {
    get application(): any;
    get attachments(): Attachment[];
    get settings(): AssistantSettings;
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

export interface QueryProvider {
    query(context: QueryContext, prompt: string, onStreamUpdate: (text: string) => void, signal?: AbortSignal, history?: ChatTurn[]): Promise<QueryResponse>;
}
