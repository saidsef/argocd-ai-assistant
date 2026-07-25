import type { ChatMessage } from "../components/useChat";
import { ExtensionScope } from "./extensions";

// Every key this extension owns starts with this, so a quota failure can prune its own leftovers
// (one set of keys accumulates per resource visited in the session) without touching Argo CD's.
const KEY_MARKER = "argocd-assistant";

export class ManageStorage {
    private CHAT_HISTORY_KEY: string;
    private LOGS_KEY: string;
    private ARGOCD_MCP_TOKEN: string;
    private _namespace?: string;

    constructor(scope: ExtensionScope, namespace?: string) {
        this._namespace = namespace;
        const prefix = namespace ? `${scope}-${namespace}` : scope;
        this.CHAT_HISTORY_KEY = `${prefix}-${KEY_MARKER}-chat-history-v2`;
        // v2: logs are now stored distilled (see service/logs.ts summariseLogs) rather than as the
        // raw API envelope, so a session carrying the old shape must not be read back.
        this.LOGS_KEY = `${prefix}-${KEY_MARKER}-logs-v2`;
        this.ARGOCD_MCP_TOKEN = `${prefix}-argocd-mcp-token`;
    }

    public loadMessages(): ChatMessage[] {
        const raw = this.read(this.CHAT_HISTORY_KEY);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed as ChatMessage[] : [];
        } catch (_e) {
            return [];
        }
    }

    public saveMessages(messages: ChatMessage[]) {
        // A conversation with an attached log can exceed the ~5MB session quota, and an unguarded
        // setItem throws out of the caller's effect - which unmounts the whole assistant tab. Shed
        // the oldest turns and prune stale keys from other resources before giving up.
        if (this.write(this.CHAT_HISTORY_KEY, JSON.stringify(messages))) return;
        this.pruneOtherKeys();
        for (const keep of [Math.ceil(messages.length / 2), 4, 1]) {
            if (this.write(this.CHAT_HISTORY_KEY, JSON.stringify(messages.slice(-keep)))) return;
        }
        console.warn("Chat history could not be persisted: session storage is full or unavailable.");
    }

    get namespace(): string | undefined {
        return this._namespace;
    }

    get logs(): string | null {
        return this.read(this.LOGS_KEY);
    }

    set logs(value: string) {
        this.write(this.LOGS_KEY, value);
    }

    get mcpToken(): string | null {
        return this.read(this.ARGOCD_MCP_TOKEN);
    }

    set mcpToken(value: string) {
        this.write(this.ARGOCD_MCP_TOKEN, value);
    }

    // sessionStorage throws rather than returning null when storage is disabled or partitioned
    // (private windows, strict cookie policies), so every access is guarded.
    private read(key: string): string | null {
        try {
            return sessionStorage.getItem(key);
        } catch (_e) {
            return null;
        }
    }

    private write(key: string, value: string): boolean {
        try {
            sessionStorage.setItem(key, value);
            return true;
        } catch (_e) {
            return false;
        }
    }

    // Drop this extension's keys for other resources - they belong to slide-outs the user has since
    // closed, and reclaiming them is what makes room for the conversation in front of them.
    private pruneOtherKeys(): void {
        try {
            const mine = [this.CHAT_HISTORY_KEY, this.LOGS_KEY, this.ARGOCD_MCP_TOKEN];
            for (const key of Object.keys(sessionStorage)) {
                if (key.includes(KEY_MARKER) && !mine.includes(key)) sessionStorage.removeItem(key);
            }
        } catch (_e) {
            // Nothing to do: we are already on the failure path.
        }
    }
}
