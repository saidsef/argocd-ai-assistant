import type { ChatMessage } from "../components/useChat";
import { ExtensionScope } from "./extensions";

/**
 * Every key this extension owns starts with this. A quota failure can then prune the extension's
 * own leftovers, one set per resource visited, without touching Argo CD's keys.
 */
const KEY_MARKER = "argocd-assistant";

/** The conversation, attached log and MCP token of one resource, kept in the tab's sessionStorage. */
export class ManageStorage {
    private CHAT_HISTORY_KEY: string;
    private LOGS_KEY: string;
    private ARGOCD_MCP_TOKEN: string;
    private _namespace?: string;

    constructor(scope: ExtensionScope, namespace?: string) {
        this._namespace = namespace;
        const prefix = namespace ? `${scope}-${namespace}` : scope;
        this.CHAT_HISTORY_KEY = `${prefix}-${KEY_MARKER}-chat-history-v2`;
        // The v2 key holds distilled log text. Raw API envelopes stored under the old key are never
        // read back. See #119.
        this.LOGS_KEY = `${prefix}-${KEY_MARKER}-logs-v2`;
        // Carries KEY_MARKER like every other key, because pruneOtherKeys must be able to reclaim a
        // stale token.
        this.ARGOCD_MCP_TOKEN = `${prefix}-${KEY_MARKER}-mcp-token`;
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
        // Each `keep` must be >= 1: slice(-0) returns the *whole* array, so a 0 here would retry the
        // write that just failed. Halving first, then hard floors.
        for (const keep of [Math.ceil(messages.length / 2), 4, 1]) {
            if (keep < 1) continue;
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

    // Methods rather than a setter, because setLogs reports a dropped write, and "New chat" needs a
    // way to detach the log. See #123.
    setLogs(value: string): boolean {
        return this.write(this.LOGS_KEY, value);
    }

    clearLogs(): void {
        this.remove(this.LOGS_KEY);
    }

    get mcpToken(): string | null {
        return this.read(this.ARGOCD_MCP_TOKEN);
    }

    setMcpToken(value: string): boolean {
        return this.write(this.ARGOCD_MCP_TOKEN, value);
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

    private remove(key: string): void {
        try {
            sessionStorage.removeItem(key);
        } catch (_e) {
            // Storage is unavailable, so there is nothing stored to remove.
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
