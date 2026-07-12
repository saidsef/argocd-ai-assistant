import * as React from "react";
import { generateId } from "../util/util";

export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    parts: Array<{ type: "text"; text: string }>;
    /** UI-only message (welcome banner, flow prompts) — excluded from LLM history. */
    local?: boolean;
}

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

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

export interface UseChatHelpers {
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

        // Coalesce streaming updates to one render per frame to avoid per-token re-parses.
        let rafId: number | null = null;
        const renderAssistantText = () => {
            rafId = null;
            setMessages((prev) =>
                prev.map((m) =>
                    m.id === assistantId
                        ? { ...m, parts: [{ type: "text", text: assistantText }] }
                        : m
                )
            );
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
                    if (rafId === null) rafId = requestAnimationFrame(renderAssistantText);
                } else if (value.type === "status") {
                    setToolStatus(value.label ?? null);
                } else if (value.type === "error" && value.errorText) {
                    throw new Error(value.errorText);
                } else if (value.type === "text-end") {
                    break;
                }
            }

            setStatus("ready");
        } catch (err) {
            // AbortError is expected when stop() is called; status is already "ready".
            if (err instanceof Error && err.name === "AbortError") return;
            const errorObj = err instanceof Error ? err : new Error(String(err));
            setError(errorObj);
            setStatus("error");
        } finally {
            // Flush any pending frame so the final text always renders (end, error, or abort).
            if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
            if (assistantId) renderAssistantText();
            setToolStatus(null);
            abortControllerRef.current = null;
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
        // toolStatus is cleared by the in-flight sendMessage's finally when the abort unwinds.
    }, []);

    const clearError = React.useCallback(() => setError(undefined), []);

    return { messages, setMessages, status, toolStatus, error, sendMessage, retry, stop, clearError };
}
