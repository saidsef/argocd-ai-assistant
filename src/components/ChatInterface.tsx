import * as React from "react";
import { ChatTurn, QueryContext, QueryProvider } from "../model/provider";
import { ManageStorage } from "../util/storage";
import { generateId } from "../util/util";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import { useChat, type ChatMessage as ChatMessageType, type ChatChunk, type UseChatOptions } from "./useChat";

// Cap the history sent with each request so token usage stays bounded (~10 exchanges).
const MAX_HISTORY_MESSAGES = 20;

export interface ChatInterfaceProps {
    id: string;
    provider: QueryProvider;
    getContext: () => QueryContext;
    welcomeMessage?: string;
    storage: ManageStorage;
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
    onCommand,
    children
}: ChatInterfaceProps) => {
    const getContextRef = React.useRef(getContext);
    getContextRef.current = getContext;

    const providerRef = React.useRef(provider);
    providerRef.current = provider;

    const transport = React.useRef<UseChatOptions["transport"]>({
        async sendMessages({ messages, abortSignal }) {
            const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
            const prompt = lastUserMessage?.parts?.find((p) => p.type === "text")?.text || "";

            // Prior turns (everything before the just-sent message), so the model has
            // the running context. Capped to the most recent MAX_HISTORY_MESSAGES.
            const history: ChatTurn[] = messages
                .slice(0, -1)
                .filter((m) => !m.local)
                .map((m) => ({
                    role: m.role,
                    content: (m.parts || [])
                        .filter((p) => p.type === "text")
                        .map((p) => p.text)
                        .join("")
                }))
                .filter((m) => m.content.trim().length > 0)
                .slice(-MAX_HISTORY_MESSAGES);

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
                            abortSignal,
                            history
                        );

                        if (!response.success) {
                            controller.enqueue({
                                type: "error",
                                errorText: response.error?.message || "Unknown error"
                            });
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

    // Computed once per mount; the parent remounts via key={resourceID} on resource change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const initialMessages = React.useMemo(() => {
        const stored = storage.loadMessages();
        if (stored.length === 0 && welcomeMessage) {
            return [{
                id: generateId(),
                role: "assistant" as const,
                parts: [{ type: "text" as const, text: welcomeMessage }],
                local: true
            }];
        }
        return stored;
    }, []);

    const {
        messages,
        status,
        error,
        stop,
        setMessages,
        sendMessage,
        clearError
    } = useChat({
        transport: transport.current,
        messages: initialMessages
    });

    const [input, setInput] = React.useState("");
    const messagesEndRef = React.useRef<HTMLDivElement>(null);
    const listRef = React.useRef<HTMLDivElement>(null);
    // Auto-scroll only while pinned to the bottom; scrolling up disables it. Starts true.
    const stickToBottomRef = React.useRef(true);

    const handleScroll = () => {
        const el = listRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        stickToBottomRef.current = distanceFromBottom <= 40;
    };

    React.useEffect(() => {
        storage.saveMessages(messages);
    }, [messages, storage]);

    React.useEffect(() => {
        if (stickToBottomRef.current) {
            messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
        }
    }, [messages]);

    const isBusy = status === "submitted" || status === "streaming";

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
    };

    const wrappedSubmit = (e?: React.SubmitEvent<HTMLFormElement>) => {
        e?.preventDefault();
        if (!input.trim()) return;
        if (onCommand && onCommand(input.trim(), messages, setMessages)) {
            setInput("");
            return;
        }
        stickToBottomRef.current = true; // user just asked — follow the reply
        sendMessage({ text: input.trim() });
        setInput("");
    };

    return (
        <div id={id}>
            <div className="chat-message-list" ref={listRef} onScroll={handleScroll} aria-live="polite" aria-label="Chat messages">
                {messages.map((message) => (
                    <ChatMessage key={message.id} message={message} />
                ))}
                {isBusy && (
                    <div className="chat-loading" role="status" aria-live="polite">
                        {status === "submitted" && <span>Assistant is thinking...</span>}
                        <button onClick={stop} aria-label="Stop response">Stop</button>
                    </div>
                )}
                {error && (
                    <div className="chat-error" role="alert">
                        <span>{error.message}</span>
                        <button
                            className="chat-error-dismiss"
                            onClick={clearError}
                            aria-label="Dismiss error"
                        >
                            &times;
                        </button>
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
