import * as React from "react";
import { ChatTurn, McpServerStatus, QueryContext, QueryProvider } from "../model/provider";
import { ManageStorage } from "../util/storage";
import { generateId } from "../util/util";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import { useChat, type ChatMessage as ChatMessageType, type ChatChunk, type UseChatOptions } from "./useChat";

// Cap the history sent with each request so token usage stays bounded (~10 exchanges).
const MAX_HISTORY_MESSAGES = 20;

const pluralTools = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;

// The initial assistant welcome bubble (a UI-only message), or none when there is no welcome text.
// Shared by first-mount seeding and the "New chat" reset so the two stay in sync.
const buildWelcome = (welcomeMessage?: string): ChatMessageType[] =>
    welcomeMessage
        ? [{
            id: generateId(),
            role: "assistant",
            parts: [{ type: "text", text: welcomeMessage }],
            local: true
        }]
        : [];

// Compact indicator that MCP is active, shown left of "New chat" when servers are
// configured. Starts as the configured hostname (grey dot), then upgrades to the
// server-reported name + tool count + green dot once the provider has connected.
const McpBadge = ({ servers }: { servers: McpServerStatus[] }) => {
    const anyConnected = servers.some((s) => s.connected);
    const single = servers.length === 1 ? servers[0] : null;
    const label = single
        ? (single.toolCount > 0 ? `${single.name} · ${pluralTools(single.toolCount)}` : single.name)
        : `${servers.length} MCP servers`;
    const tooltip = servers
        .map((s) => `${s.name} — ${s.connected ? "connected" : "configured"} — ${pluralTools(s.toolCount)}`)
        .join("\n");
    const ariaLabel = single
        ? `MCP server ${single.name}, ${single.connected ? "connected" : "configured"}, ${pluralTools(single.toolCount)}`
        : `${servers.length} MCP servers, ${anyConnected ? "at least one connected" : "configured"}`;
    return (
        <span className="chat-mcp-badge" title={tooltip} aria-label={ariaLabel}>
            <span className="chat-mcp-icon" aria-hidden="true">&#128268;</span>
            <span className="chat-mcp-label">{label}</span>
            <span className={`chat-mcp-dot${anyConnected ? " chat-mcp-dot-on" : ""}`} aria-hidden="true" />
        </span>
    );
};

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
    /** Reset any parent-owned flow state when the conversation is cleared. */
    onClear?: () => void;
    /** Live MCP server status for the header badge; omitted when MCP is disabled/unconfigured. */
    getMcpStatus?: () => McpServerStatus[];
    children?: React.ReactNode | ((helpers: { setMessages: React.Dispatch<React.SetStateAction<ChatMessageType[]>> }) => React.ReactNode);
}

const ChatInterface = ({
    id,
    provider,
    getContext,
    welcomeMessage,
    storage,
    onCommand,
    onClear,
    getMcpStatus,
    children
}: ChatInterfaceProps) => {
    const getContextRef = React.useRef(getContext);
    getContextRef.current = getContext;

    const providerRef = React.useRef(provider);
    providerRef.current = provider;

    // Lazy-init (??=) so the transport object and its async closure are built once, not re-allocated on
    // every render — during streaming this component re-renders each animation frame. The closure reads
    // getContextRef/providerRef at call time, so one stable instance always sees the latest values.
    const transportRef = React.useRef<UseChatOptions["transport"] | null>(null);
    transportRef.current ??= {
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

                    let lastText = "";
                    // Emit text-start lazily, on the first visible token, so status stays "submitted"
                    // (the thinking indicator) during the wait for the model's first output instead of
                    // flipping to "streaming" against an empty bubble. Tool-status labels still surface
                    // independently via the onStatus channel while a tool runs.
                    let started = false;
                    const ensureStarted = () => {
                        if (!started) {
                            started = true;
                            controller.enqueue({ type: "text-start", id: msgId });
                        }
                    };

                    try {
                        const response = await providerRef.current.query(
                            getContextRef.current(),
                            prompt,
                            (text) => {
                                const delta = text.slice(lastText.length);
                                lastText = text;
                                if (delta) {
                                    ensureStarted();
                                    controller.enqueue({ type: "text-delta", id: msgId, delta });
                                }
                            },
                            abortSignal,
                            history,
                            (label) => {
                                controller.enqueue({ type: "status", label: label ?? undefined });
                            }
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
                        // Only end a bubble that was actually started (no visible text => no bubble).
                        if (started) controller.enqueue({ type: "text-end", id: msgId });
                        controller.close();
                    }
                }
            });

            return stream;
        }
    };

    // Computed once per mount; the parent remounts via key={resourceID} on resource change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const initialMessages = React.useMemo(() => {
        const stored = storage.loadMessages();
        return stored.length === 0 ? buildWelcome(welcomeMessage) : stored;
    }, []);

    const {
        messages,
        status,
        toolStatus,
        error,
        stop,
        setMessages,
        sendMessage,
        retry,
        clearError
    } = useChat({
        transport: transportRef.current!,
        messages: initialMessages
    });

    const [input, setInput] = React.useState("");
    const listRef = React.useRef<HTMLDivElement>(null);
    // Auto-scroll only while pinned to the bottom; scrolling up disables it. Starts true.
    const stickToBottomRef = React.useRef(true);

    const handleScroll = () => {
        const el = listRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        stickToBottomRef.current = distanceFromBottom <= 40;
    };

    // Persist on settle, not on every streamed frame: during streaming `messages` updates
    // once per animation frame, so serialising the whole conversation to sessionStorage each
    // time is pure waste. The just-sent user turn still saves promptly (status "submitted"),
    // and the final reply persists when status leaves "streaming".
    React.useEffect(() => {
        if (status === "streaming") return;
        storage.saveMessages(messages);
    }, [messages, status, storage]);

    React.useEffect(() => {
        const el = listRef.current;
        if (el && stickToBottomRef.current) {
            el.scrollTop = el.scrollHeight;
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

    // Reset the conversation: abort any in-flight reply, drop history back to the welcome
    // message (the storage effect persists it), and let the parent reset its flow state.
    const handleClear = React.useCallback(() => {
        stop();
        setMessages(buildWelcome(welcomeMessage));
        stickToBottomRef.current = true;
        onClear?.();
    }, [stop, setMessages, welcomeMessage, onClear]);

    // Recomputed each render so it upgrades to live names/tools once a query connects.
    const mcpStatus = getMcpStatus?.();

    return (
        <div id={id}>
            <div className="chat-header">
                {mcpStatus && mcpStatus.length > 0 && <McpBadge servers={mcpStatus} />}
                <button
                    type="button"
                    className="chat-clear-button"
                    onClick={handleClear}
                    disabled={isBusy}
                    aria-label="Start a new conversation"
                >
                    New chat
                </button>
            </div>
            <div className="chat-message-list" ref={listRef} onScroll={handleScroll} aria-live="polite" aria-label="Chat messages">
                {messages.map((message) => (
                    <ChatMessage key={message.id} message={message} />
                ))}
                {isBusy && (
                    <div className="chat-loading" role="status" aria-live="polite">
                        {(status === "submitted" || toolStatus) && (
                            <>
                                <span className="chat-typing" aria-hidden="true"><span /><span /><span /></span>
                                {toolStatus
                                    ? <span className="chat-tool-status">{toolStatus}</span>
                                    : <span className="sr-only">Assistant is thinking</span>}
                            </>
                        )}
                        <button onClick={stop} aria-label="Stop response">Stop</button>
                    </div>
                )}
                {error && (
                    <div className="chat-error" role="alert">
                        <span>{error.message}</span>
                        <button
                            className="chat-error-retry"
                            onClick={() => { stickToBottomRef.current = true; retry(); }}
                            aria-label="Retry request"
                        >
                            Retry
                        </button>
                        <button
                            className="chat-error-dismiss"
                            onClick={clearError}
                            aria-label="Dismiss error"
                        >
                            &times;
                        </button>
                    </div>
                )}
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
