import * as React from "react";

export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    parts: Array<{ type: "text"; text: string }>;
}

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export interface ChatChunk {
    type: string;
    id?: string;
    delta?: string;
    errorText?: string;
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
    error: Error | undefined;
    sendMessage: (message: { text: string }) => Promise<void>;
    stop: () => void;
}

export function useChat(options: UseChatOptions): UseChatHelpers {
    const [messages, setMessages] = React.useState<ChatMessage[]>(options.messages);
    const [status, setStatus] = React.useState<ChatStatus>("ready");
    const [error, setError] = React.useState<Error | undefined>(undefined);
    const abortControllerRef = React.useRef<AbortController | null>(null);

    // Refs so sendMessage never captures stale values in its closure.
    const messagesRef = React.useRef(messages);
    messagesRef.current = messages;
    const transportRef = React.useRef(options.transport);
    transportRef.current = options.transport;

    const sendMessage = React.useCallback(async (message: { text: string }) => {
        const userMessage: ChatMessage = {
            id: crypto.randomUUID?.() || Math.random().toString(36).slice(2),
            role: "user",
            parts: [{ type: "text", text: message.text }]
        };

        const newMessages = [...messagesRef.current, userMessage];
        setMessages(newMessages);
        setStatus("submitted");
        setError(undefined);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            const stream = await transportRef.current.sendMessages({
                messages: newMessages,
                abortSignal: controller.signal
            });

            const reader = stream.getReader();
            let assistantText = "";
            let assistantId = "";

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
                    setMessages((prev) =>
                        prev.map((m) =>
                            m.id === assistantId
                                ? { ...m, parts: [{ type: "text", text: assistantText }] }
                                : m
                        )
                    );
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
            abortControllerRef.current = null;
        }
    }, []); // stable - reads messages/transport via refs

    const stop = React.useCallback(() => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setStatus("ready");
    }, []);

    return { messages, setMessages, status, error, sendMessage, stop };
}
