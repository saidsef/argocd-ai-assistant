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

// A server's one-word state, which also picks the dot colour. A failure used to be logged to the
// console only, leaving the user with a silently tool-free answer and no way to know why.
const mcpState = (s: McpServerStatus) => s.error ? "unavailable" : s.connected ? "connected" : "configured";

// Compact indicator that MCP is active, shown left of "New chat" when servers are
// configured. Starts as the configured hostname (grey dot), then upgrades to the
// server-reported name + tool count + green dot once the provider has connected, or a red dot
// with the reason in the tooltip if the server could not be reached.
const McpBadge = ({ servers }: { servers: McpServerStatus[] }) => {
    const anyConnected = servers.some((s) => s.connected && !s.error);
    const anyFailed = servers.some((s) => s.error);
    const single = servers.length === 1 ? servers[0] : null;
    const label = single
        ? (single.toolCount > 0 ? `${single.name} · ${pluralTools(single.toolCount)}` : single.name)
        : `${servers.length} MCP servers`;
    const describe = (s: McpServerStatus) =>
        `${s.name} — ${mcpState(s)} — ${pluralTools(s.toolCount)}${s.error ? `\n${s.error}` : ""}`;
    const tooltip = servers.map(describe).join("\n");
    const ariaLabel = single
        ? `MCP server ${describe(single).replace(/\n/g, ". ")}`
        : `${servers.length} MCP servers, ${anyFailed ? "at least one unavailable" : anyConnected ? "at least one connected" : "configured"}`;
    const dotClass = anyFailed && !anyConnected ? " chat-mcp-dot-error" : anyConnected ? " chat-mcp-dot-on" : "";
    return (
        <span className="chat-mcp-badge" title={tooltip} aria-label={ariaLabel}>
            <span className="chat-mcp-icon" aria-hidden="true">&#128268;</span>
            <span className="chat-mcp-label">{label}</span>
            <span className={`chat-mcp-dot${dotClass}`} aria-hidden="true" />
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
    /** One-click starter prompts shown only on a fresh conversation, to make common asks discoverable. */
    suggestions?: string[];
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
    suggestions,
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
    // Mirrors stickToBottomRef for rendering the "jump to latest" affordance. Kept as a ref *and*
    // state because the scroll path must not re-render on every scroll event.
    const [pinned, setPinned] = React.useState(true);

    const scrollToBottom = React.useCallback(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        stickToBottomRef.current = true;
        setPinned(true);
    }, []);

    // Reading scrollHeight/scrollTop forces a synchronous layout, and the streaming path writes
    // scrollTop on this same element every frame - so coalesce to one measurement per frame.
    const scrollRafRef = React.useRef<number | null>(null);
    const handleScroll = React.useCallback(() => {
        if (scrollRafRef.current !== null) return;
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = null;
            const el = listRef.current;
            if (!el) return;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
            stickToBottomRef.current = atBottom;
            setPinned(atBottom);
        });
    }, []);

    React.useEffect(() => () => {
        if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    }, []);

    // Persist on settle, not on every streamed frame: during streaming `messages` updates
    // once per animation frame, so serialising the whole conversation to sessionStorage each
    // time is pure waste. The just-sent user turn still saves promptly (status "submitted"),
    // and the final reply persists when status leaves "streaming".
    React.useEffect(() => {
        if (status === "streaming") return;
        storage.saveMessages(messages);
    }, [messages, status, storage]);

    // Follow the content, not the message list.
    //
    // A `messages`-keyed effect is not enough: MarkedWrapper re-parses on a trailing 120ms timer, so
    // the bubble grows *after* the last state update lands and the final paragraph of every reply
    // ends up below the fold. Observing the list's own size catches every growth, whatever caused it.
    React.useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const follow = () => { if (stickToBottomRef.current) el.scrollTop = el.scrollHeight; };
        follow();
        const observer = new ResizeObserver(follow);
        observer.observe(el);
        for (const child of Array.from(el.children)) observer.observe(child);
        return () => observer.disconnect();
    }, [messages]);

    const isBusy = status === "submitted" || status === "streaming";

    // Announce a reply once, when it finishes. Only for replies that completed in this session -
    // seeding it from restored history would read the previous conversation aloud on mount.
    const [announcement, setAnnouncement] = React.useState("");
    const wasBusyRef = React.useRef(false);
    React.useEffect(() => {
        if (wasBusyRef.current && !isBusy) {
            const last = [...messages].reverse().find((m) => m.role === "assistant" && !m.local);
            setAnnouncement(last ? (last.parts || []).map((p) => p.text).join("") : "");
        }
        wasBusyRef.current = isBusy;
    }, [isBusy, messages]);

    // Escape stops a running reply - the same action as the Stop button, without reaching for it.
    React.useEffect(() => {
        if (!isBusy) return;
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") stop(); };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isBusy, stop]);

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
    };

    // Shared send path for the composer and the suggestion chips. Honours a parent onCommand
    // (guided flows) before dispatching to the model, and always follows the reply.
    const submitText = (raw: string) => {
        const text = raw.trim();
        if (!text) return;
        if (onCommand && onCommand(text, messages, setMessages)) {
            setInput("");
            return;
        }
        scrollToBottom(); // user just asked — follow the reply
        sendMessage({ text });
        setInput("");
    };

    const wrappedSubmit = (e?: React.SubmitEvent<HTMLFormElement>) => {
        e?.preventDefault();
        submitText(input);
    };

    // Starter chips: only on a genuinely fresh conversation (welcome bubble only, all UI-only),
    // idle, no error, and before the user starts typing. They vanish once a real turn begins or a
    // guided flow injects a message, so they never clutter an active chat.
    const showSuggestions =
        !!suggestions?.length &&
        !isBusy &&
        !error &&
        !input.trim() &&
        messages.length <= 1 &&
        messages.every((m) => m.local);

    // Reset the conversation: abort any in-flight reply, drop history back to the welcome
    // message (the storage effect persists it), and let the parent reset its flow state.
    const handleClear = React.useCallback(() => {
        stop();
        setMessages(buildWelcome(welcomeMessage));
        scrollToBottom();
        onClear?.();
    }, [stop, setMessages, welcomeMessage, onClear, scrollToBottom]);

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
            {/* No aria-live here: the streaming bubble's subtree is replaced several times a second,
                which makes a live region re-announce the whole growing reply. Completion is
                announced once, from the dedicated region below the composer. */}
            <div className="chat-message-list" ref={listRef} onScroll={handleScroll} role="log" aria-label="Chat messages">
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
            {!pinned && (
                <button
                    type="button"
                    className="chat-jump-latest"
                    onClick={scrollToBottom}
                    aria-label="Jump to the latest message"
                >
                    ↓ Latest
                </button>
            )}
            {typeof children === "function" ? children({ setMessages }) : children}
            {showSuggestions && (
                <div className="chat-suggestions" role="group" aria-label="Suggested questions">
                    {suggestions!.map((s) => (
                        <button
                            key={s}
                            type="button"
                            className="chat-suggestion"
                            onClick={() => submitText(s)}
                        >
                            {s}
                        </button>
                    ))}
                </div>
            )}
            <ChatInput
                input={input}
                handleInputChange={handleInputChange}
                handleSubmit={wrappedSubmit}
                disabled={isBusy}
            />
            {/* The single live region for reply progress: one announcement per reply, rather than
                the message list re-reading itself on every streamed frame. */}
            <span className="sr-only" role="status" aria-live="polite">
                {isBusy ? "" : announcement}
            </span>
        </div>
    );
};

export default ChatInterface;
