import type { ChatMessage } from "../components/useChat";
import { ExtensionScope } from "./extensions";

export class ManageStorage {
    private CHAT_HISTORY_KEY: string;
    private LOGS_KEY: string;
    private ARGOCD_MCP_TOKEN: string;
    private _namespace?: string;

    constructor(scope: ExtensionScope, namespace?: string) {
        this._namespace = namespace;
        const prefix = namespace ? `${scope}-${namespace}` : scope;
        this.CHAT_HISTORY_KEY = `${prefix}-argocd-assistant-chat-history-v2`;
        this.LOGS_KEY = `${prefix}-argocd-assistant-logs`;
        this.ARGOCD_MCP_TOKEN = `${prefix}-argocd-mcp-token`;
    }

    public loadMessages(): ChatMessage[] {
        const raw = sessionStorage.getItem(this.CHAT_HISTORY_KEY);
        if (!raw) return [];
        try {
            return JSON.parse(raw) as ChatMessage[];
        } catch (_e) {
            return [];
        }
    }

    public saveMessages(messages: ChatMessage[]) {
        sessionStorage.setItem(this.CHAT_HISTORY_KEY, JSON.stringify(messages));
    }

    get namespace(): string | undefined {
        return this._namespace;
    }

    get logs(): string | null {
        return sessionStorage.getItem(this.LOGS_KEY);
    }

    set logs(value: string) {
        sessionStorage.setItem(this.LOGS_KEY, value);
    }

    public hasLogs(): boolean {
        return this.logs !== null;
    }

    get mcpToken(): string | null {
        return sessionStorage.getItem(this.ARGOCD_MCP_TOKEN);
    }

    set mcpToken(value: string) {
        sessionStorage.setItem(this.ARGOCD_MCP_TOKEN, value);
    }
}
