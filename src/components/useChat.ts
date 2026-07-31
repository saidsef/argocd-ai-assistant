import * as React from "react";
import { generateId } from "../util/util";

export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    parts: Array<{ type: "text"; text: string }>;
    /** UI-only message (welcome banner, flow prompts) — excluded from LLM history. */
    local?: boolean;
    /**
     * The reply was cut short by Stop. Unlike `local` this is still a real turn that counts as
     * history — it is just a truncated one, so it is marked rather than passed off as a complete
     * answer. Deliberately a flag and not appended text: the partial reply is genuine history that
     * flows into the next request, and a synthetic "_Stopped._" would be re-sent to the model as
     * something the assistant actually said.
     */
    stopped?: boolean;
}

type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export interface ChatChunk {
    type: string;
    id?: string;
    delta?: string;
    errorText?: string;
    /** Transient status label (e.g. "Running docs_fetch_docs…"); null/absent clears it. */
    label?: string;
}

export interface UseChatOptions {
    messages: ChatMessage[];
    transport: {
        sendMessages(options: {
            messages: ChatMessage[];
            abortSignal: AbortSignal;
        }): Promise<ReadableStream<ChatChunk>>;
    };
}

interface UseChatHelpers {
    messages: ChatMessage[];
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    status: ChatStatus;
    /** Transient tool-execution label shown while an MCP tool runs, else null. */
    toolStatus: string | null;
    error: Error | undefined;
    sendMessage: (message: { text: string }) => Promise<void>;
    /** Re-run the last user turn (used by the error banner) without duplicating it. */
    retry: () => void;
    stop: () => void;
    clearError: () => void;
}

export function useChat(options: UseChatOptions): UseChatHelpers {
    const [messages, setMessages] = React.useState<ChatMessage[]>(options.messages);
    const [status, setStatus] = React.useState<ChatStatus>("ready");
    const [toolStatus, setToolStatus] = React.useState<string | null>(null);
    const [error, setError] = React.useState<Error | undefined>(undefined);
    const abortControllerRef = React.useRef<AbortController | null>(null);

    // Refs so sendMessage never captures stale values in its closure.
    const messagesRef = React.useRef(messages);
    messagesRef.current = messages;
    const transportRef = React.useRef(options.transport);
    transportRef.current = options.transport;

    const sendMessage = React.useCallback(async (message: { text: string }) => {
        const userMessage: ChatMessage = {
            id: generateId(),
            role: "user",
            parts: [{ type: "text", text: message.text }]
        };

        const newMessages = [...messagesRef.current, userMessage];
        setMessages(newMessages);
        setStatus("submitted");
        setToolStatus(null);
        setError(undefined);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        let assistantText = "";
        let assistantId = "";
        // Mirror of the current tool/progress label so we clear it exactly once per phase
        // (on the first answer token) instead of dispatching setToolStatus(null) per delta.
        let toolLabel: string | null = null;
        // True while this invocation still owns the abort controller. Stop-then-send, and a resource
        // switch mid-reply, interleave two invocations: without this, the older one's unwinding
        // `finally` nulled the newer one's controller (disabling Stop, Escape and the unmount abort)
        // and its `setStatus("ready")` landed after the newer "submitted", freeing the composer for a
        // second concurrent send.
        const isCurrent = () => abortControllerRef.current === controller;

        // Coalesce streaming updates to one render per frame to avoid per-token re-parses.
        let rafId: number | null = null;
        const renderAssistantText = () => {
            rafId = null;
            setMessages((prev) => {
                // The bubble can be gone (e.g. "New chat" mid-stream); don't rebuild the array for it.
                if (!prev.some((m) => m.id === assistantId)) return prev;
                return prev.map((m) =>
                    m.id === assistantId
                        ? { ...m, parts: [{ type: "text", text: assistantText }] }
                        : m
                );
            });
        };

        try {
            const stream = await transportRef.current.sendMessages({
                messages: newMessages,
                abortSignal: controller.signal
            });

            const reader = stream.getReader();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                if (value.type === "text-start" && value.id) {
                    assistantId = value.id;
                    const assistantMsg: ChatMessage = {
                        id: assistantId,
                        role: "assistant",
                        parts: [{ type: "text", text: "" }]
                    };
                    setMessages((prev) => [...prev, assistantMsg]);
                    setStatus("streaming");
                } else if (value.type === "text-delta" && value.delta) {
                    assistantText += value.delta;
                    // Visible answer text is now flowing, so drop any progress label (e.g.
                    // "Analysing results…"). Guarded so it fires once per label phase, not per token.
                    if (toolLabel !== null) { toolLabel = null; setToolStatus(null); }
                    if (rafId === null) rafId = requestAnimationFrame(renderAssistantText);
                } else if (value.type === "status") {
                    toolLabel = value.label ?? null;
                    setToolStatus(toolLabel);
                } else if (value.type === "error" && value.errorText) {
                    throw new Error(value.errorText);
                } else if (value.type === "text-end") {
                    break;
                }
            }

            if (isCurrent()) setStatus("ready");
        } catch (err) {
            // AbortError is expected when stop() is called; status is already "ready".
            if (err instanceof Error && err.name === "AbortError") return;
            if (!isCurrent()) return; // a newer send owns the UI now
            const errorObj = err instanceof Error ? err : new Error(String(err));
            setError(errorObj);
            setStatus("error");
        } finally {
            // Flush any pending frame so the final text always renders (end, error, or abort).
            if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
            if (assistantId) renderAssistantText();
            if (isCurrent()) {
                setToolStatus(null);
                abortControllerRef.current = null;
            }
        }
    }, []); // stable - reads messages/transport via refs

    // Re-run generation for the most recent user turn after a failure. Drops the failed
    // exchange (the trailing user message + any partial assistant bubble) and resubmits the
    // same prompt. messagesRef is trimmed first so sendMessage appends onto that base;
    // sendMessage then commits the truncated list and clears the error itself.
    const retry = React.useCallback(() => {
        const msgs = messagesRef.current;
        let i = msgs.length - 1;
        while (i >= 0 && msgs[i].role !== "user") i--;
        if (i < 0) return;
        const text = msgs[i].parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
        if (!text.trim()) return;
        messagesRef.current = msgs.slice(0, i);
        sendMessage({ text });
    }, [sendMessage]);

    const stop = React.useCallback(() => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setStatus("ready");
        // Cleared here rather than in the aborted invocation's finally: releasing ownership above is
        // what stops that invocation writing over a newer send's state, so it no longer clears this.
        setToolStatus(null);
        // Mark the bubble as truncated. Done here rather than in sendMessage's finally because this
        // is the only path that knows a *user* cancelled - the unmount effect below aborts the
        // controller directly and must not mark anything on a tree that is going away.
        setMessages((prev) => {
            const i = prev.length - 1;
            // Only a bubble that actually started: Stop pressed before the first token leaves the
            // user's own turn last, and there is nothing truncated to mark.
            if (i < 0 || prev[i].role !== "assistant" || prev[i].local) return prev;
            return [...prev.slice(0, i), { ...prev[i], stopped: true }];
        });
    }, []);

    const clearError = React.useCallback(() => setError(undefined), []);

    // Abort any in-flight reply when the hook unmounts. The resource extension remounts this tree
    // (key={chatKey}) whenever the user opens a different resource, so without this, switching
    // resources mid-reply leaves the fetch, the SSE reader loop and its setMessages calls running
    // against a dead tree - burning tokens for output nobody will ever see.
    React.useEffect(() => () => abortControllerRef.current?.abort(), []);

    return { messages, setMessages, status, toolStatus, error, sendMessage, retry, stop, clearError };
}
