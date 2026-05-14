import * as React from "react";
import { QueryContext, QueryProvider, QueryResponse } from "../model/provider";
import { ManageStorage } from "../util/storage";
import { generateId } from "../util/util";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import { useChat, type ChatMessage as ChatMessageType, type ChatChunk, type UseChatOptions } from "./useChat";

export interface ChatInterfaceProps {
    id: string;
    provider: QueryProvider;
    getContext: () => QueryContext;
    welcomeMessage?: string;
    storage: ManageStorage;
    onQueryComplete?: (response: QueryResponse) => void;
    onCommand?: (
        input: string,
        messages: ChatMessageType[],
        setMessages: React.Dispatch<React.SetStateAction<ChatMessageType[]>>
    ) => boolean;
    children?: React.ReactNode | ((helpers: { setMessages: React.Dispatch<React.SetStateAction<ChatMessageType[]>> }) => React.ReactNode);
}

const ChatInterface = ({
    id,
    provider,
    getContext,
    welcomeMessage,
    storage,
    onQueryComplete,
    onCommand,
    children
}: ChatInterfaceProps) => {
    const getContextRef = React.useRef(getContext);
    getContextRef.current = getContext;

    const providerRef = React.useRef(provider);
    providerRef.current = provider;

    const onQueryCompleteRef = React.useRef(onQueryComplete);
    onQueryCompleteRef.current = onQueryComplete;

    const transport = React.useRef<UseChatOptions["transport"]>({
        async sendMessages({ messages, abortSignal }) {
            const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
            const prompt = lastUserMessage?.parts?.find((p) => p.type === "text")?.text || "";

            const stream = new ReadableStream<ChatChunk>({
                async start(controller) {
                    const msgId = generateId();
                    controller.enqueue({ type: "text-start", id: msgId });

                    let lastText = "";

                    try {
                        const response = await providerRef.current.query(
                            getContextRef.current(),
                            prompt,
                            (text) => {
                                const delta = text.slice(lastText.length);
                                lastText = text;
                                if (delta) {
                                    controller.enqueue({ type: "text-delta", id: msgId, delta });
                                }
                            },
                            abortSignal
                        );

                        if (!response.success) {
                            controller.enqueue({
                                type: "error",
                                errorText: response.error?.message || "Unknown error"
                            });
                        } else {
                            onQueryCompleteRef.current?.(response);
                        }
                    } catch (err) {
                        // Don't surface AbortError - stop() already set status to "ready".
                        if (!(err instanceof Error && err.name === "AbortError")) {
                            controller.enqueue({
                                type: "error",
                                errorText: err instanceof Error ? err.message : String(err)
                            });
                        }
                    } finally {
                        controller.enqueue({ type: "text-end", id: msgId });
                        controller.close();
                    }
                }
            });

            return stream;
        }
    });

    const {
        messages,
        status,
        error,
        stop,
        setMessages,
        sendMessage
    } = useChat({
        transport: transport.current,
        messages: storage.loadMessages()
    });

    const [input, setInput] = React.useState("");
    const messagesEndRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        storage.saveMessages(messages);
    }, [messages, storage]);

    React.useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }, [messages]);

    React.useEffect(() => {
        if (messages.length === 0 && welcomeMessage) {
            setMessages([
                {
                    id: generateId(),
                    role: "assistant",
                    parts: [{ type: "text" as const, text: welcomeMessage }]
                }
            ]);
        }
    }, [messages.length, welcomeMessage, setMessages]);

    const isBusy = status === "submitted" || status === "streaming";

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setInput(e.target.value);
    };

    const wrappedSubmit = (e?: React.FormEvent<HTMLFormElement>) => {
        e?.preventDefault();
        if (!input.trim()) return;
        if (onCommand && onCommand(input.trim(), messages, setMessages)) {
            setInput("");
            return;
        }
        sendMessage({ text: input.trim() });
        setInput("");
    };

    return (
        <div id={id}>
            <div className="chat-message-list" aria-live="polite" aria-label="Chat messages">
                {messages.map((message) => (
                    <ChatMessage key={message.id} message={message} />
                ))}
                {isBusy && (
                    <div className="chat-loading">
                        <span>Assistant is thinking...</span>
                        <button onClick={stop} aria-label="Stop response">Stop</button>
                    </div>
                )}
                {error && (
                    <div className="chat-error" role="alert">
                        <span>{error.message}</span>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>
            {typeof children === "function" ? children({ setMessages }) : children}
            <ChatInput
                input={input}
                handleInputChange={handleInputChange}
                handleSubmit={wrappedSubmit}
                disabled={isBusy}
            />
        </div>
    );
};

export default ChatInterface;
