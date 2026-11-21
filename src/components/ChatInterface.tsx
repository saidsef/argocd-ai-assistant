import * as React from "react";
import { ChatTurn, McpServerStatus, mcpState, QueryContext, QueryProvider } from "../model/provider";
import { ManageStorage } from "../util/storage";
import { errorMessage, generateId, injectMessage } from "../util/util";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import { useChat, type ChatMessage as ChatMessageType, type ChatChunk, type UseChatOptions } from "./useChat";

/** Cap the history sent with each request so token usage stays bounded (~10 exchanges). */
const MAX_HISTORY_MESSAGES = 20;

const pluralTools = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;

/**
 * The welcome bubble as a UI-only message, or an empty list without welcome text. First-mount
 * seeding and the "New chat" reset share it.
 */
const buildWelcome = (welcomeMessage?: string): ChatMessageType[] =>
    welcomeMessage
        ? [{
            id: generateId(),
            role: "assistant",
            parts: [{ type: "text", text: welcomeMessage }],
            local: true
        }]
        : [];

/** How a user turns a configured server into a usable one, for the MCP chip's tooltip and label. */
const ADDRESSING_HINT = "Name a server in your message to use its tools.";

/** State dot for a header chip: neutral, healthy, or failing. */
export type ChipState = "idle" | "on" | "error";

/**
 * One compact header chip: icon, ellipsising label, state dot.
 *
 * `role="img"` lets the chip carry an accessible name, which the `generic` role of a bare `<span>`
 * does not allow. `title` and `aria-label` differ because the tooltip spans several lines.
 */
const Chip = React.memo(({ icon, label, state, title, ariaLabel }: {
    icon: string;
    label: string;
    state: ChipState;
    title: string;
    ariaLabel: string;
}) => (
    <span className="chat-mcp-badge" role="img" title={title} aria-label={ariaLabel}>
        <span className="chat-mcp-icon" aria-hidden="true">{icon}</span>
        <span className="chat-mcp-label">{label}</span>
        <span
            className={`chat-mcp-dot${state === "on" ? " chat-mcp-dot-on" : state === "error" ? " chat-mcp-dot-error" : ""}`}
            aria-hidden="true"
        />
    </span>
));

/** What is grounding the current answer, for the header chip. */
export interface ContextStatus {
    /** Short inventory of attached sources, e.g. "manifest · app · events". */
    label: string;
    state: ChipState;
    /** Full sentence for the tooltip and the accessible name. */
    detail: string;
}

/**
 * The MCP chip, shown left of "New chat" when servers are configured. Its dot turns green when a
 * server connects, and red when a server has failed and none has connected.
 */
const McpBadge = React.memo(({ servers }: { servers: McpServerStatus[] }) => {
    const anyConnected = servers.some((s) => s.connected && !s.error);
    const anyFailed = servers.some((s) => s.error);
    const totalTools = servers.reduce((n, s) => n + s.toolCount, 0);
    // The label shows each handle, because it is the string a user types, and a tooltip is out of
    // reach of keyboard and touch users.
    const handles = servers.map((s) => s.handle).join(" · ");
    const label = totalTools > 0 ? `${handles} · ${pluralTools(totalTools)}` : handles;
    // The reported name is worth showing when it differs, so a server whose handle was shortened (or
    // forced to its hostname by a collision) is still identifiable.
    const describe = (s: McpServerStatus) =>
        `${s.handle}${s.name && s.name !== s.handle ? ` (${s.name})` : ""} — ${mcpState(s)} — ${pluralTools(s.toolCount)}${s.error ? `\n${s.error}` : ""}`;
    const tooltip = `${servers.map(describe).join("\n")}\n\n${ADDRESSING_HINT}`;
    const ariaLabel = `${servers.length === 1 ? "MCP server" : `${servers.length} MCP servers`}: ${servers.map((s) => describe(s).replace(/\n/g, ". ")).join("; ")}. ${ADDRESSING_HINT}`;
    const state: ChipState = anyFailed && !anyConnected ? "error" : anyConnected ? "on" : "idle";
    return <Chip icon={"\u{1F50C}"} label={label} state={state} title={tooltip} ariaLabel={ariaLabel} />;
});

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
    /** What is grounding the answer, for the header chip. Omitted where there is no context (the
     *  system-level page attaches none). */
    contextStatus?: ContextStatus;
    /** One-off message posted into the transcript when it becomes non-null, such as a failed context
     *  source. The parent's effects cannot reach this component's messages any other way. */
    notice?: string | null;
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
    contextStatus,
    notice,
    children
}: ChatInterfaceProps) => {
    const getContextRef = React.useRef(getContext);
    getContextRef.current = getContext;

    const providerRef = React.useRef(provider);
    providerRef.current = provider;

    // Built once, because this component re-renders every animation frame while a reply streams.
    // The closure reads getContextRef and providerRef at call time, and always sees the latest
    // values.
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
                    // text-start waits for the first visible token. Until then the thinking
                    // indicator stays up instead of an empty bubble.
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
                                errorText: errorMessage(err)
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

    // Computed once per mount (empty deps deliberately); the parent remounts via
    // key={resourceID} on resource change.
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

    // Server handles are known only once the mount-time connection finishes, after the welcome was
    // written. The welcome is refreshed while it is the whole conversation, and never once a real
    // turn exists.
    const welcomeRef = React.useRef(welcomeMessage);
    React.useEffect(() => {
        if (welcomeRef.current === welcomeMessage) return;
        welcomeRef.current = welcomeMessage;
        setMessages((prev) =>
            prev.length <= 1 && prev.every((m) => m.local) ? buildWelcome(welcomeMessage) : prev
        );
    }, [welcomeMessage, setMessages]);

    // Keyed on the notice text, because a different failure must still be posted and a re-render
    // must not repeat one. It starts at null, because a notice present at mount must be posted too.
    // See #124.
    const noticeRef = React.useRef<string | null | undefined>(null);
    React.useEffect(() => {
        if (noticeRef.current === notice) return;
        noticeRef.current = notice;
        if (notice) setMessages(injectMessage(notice));
    }, [notice, setMessages]);

    const [input, setInput] = React.useState("");
    // Mirrored so the (stable) submit callback reads the current draft without re-creating itself on
    // every keystroke, which would re-render the memoised composer.
    const inputRef = React.useRef(input);
    inputRef.current = input;
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

    // Saving waits for a streamed reply to finish, because `messages` changes every animation frame
    // while it streams. The user's own message still saves at once.
    React.useEffect(() => {
        if (status === "streaming") return;
        storage.saveMessages(messages);
    }, [messages, status, storage]);

    // Follows the list's size rather than `messages`, because MarkedWrapper re-parses on a trailing
    // timer and the bubble grows after the last state update. The observers are built once, and the
    // children are observed again only when one is added or removed. See #123.
    React.useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const follow = () => { if (stickToBottomRef.current) el.scrollTop = el.scrollHeight; };
        const resize = new ResizeObserver(follow);
        const observeAll = () => {
            resize.disconnect(); // also drops detached children ("New chat" replaces the whole list)
            resize.observe(el);
            for (const child of Array.from(el.children)) resize.observe(child);
        };
        observeAll();
        follow();
        const mutation = new MutationObserver(observeAll);
        mutation.observe(el, { childList: true });
        return () => { resize.disconnect(); mutation.disconnect(); };
    }, []);

    const isBusy = status === "submitted" || status === "streaming";

    // Announce a reply once, when it finishes. Only for replies that completed in this session -
    // seeding it from restored history would read the previous conversation aloud on mount.
    const [announcement, setAnnouncement] = React.useState("");
    const wasBusyRef = React.useRef(false);
    React.useEffect(() => {
        if (wasBusyRef.current && !isBusy) {
            // Only the newest message counts, because a reply stopped before its first token does
            // not leave a bubble, and the previous answer must not be announced again.
            const last = messages[messages.length - 1];
            const done = last && last.role === "assistant" && !last.local && status !== "error" ? last : undefined;
            // Only the word count is announced, because a live region reads its whole text aloud and
            // the user cannot stop it. The reply itself stays in the role="log" transcript.
            const words = done
                ? (done.parts || []).map((p) => p.text).join("").trim().split(/\s+/).filter(Boolean).length
                : 0;
            const count = `${words} ${words === 1 ? "word" : "words"}`;
            setAnnouncement(!done ? "" : done.stopped ? `Response stopped after ${count}.` : `Response ready, ${count}.`);
        }
        wasBusyRef.current = isBusy;
    }, [isBusy, messages, status]);

    // Escape stops a running reply. The listener sits on this subtree rather than on window, because
    // Argo CD also closes its panels on Escape. The composer stays enabled during a reply, which
    // keeps focus inside the subtree. See #123.
    const rootRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (!isBusy) return;
        const el = rootRef.current;
        if (!el) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            stop();
        };
        el.addEventListener("keydown", onKeyDown);
        return () => el.removeEventListener("keydown", onKeyDown);
    }, [isBusy, stop]);

    const handleInputChange = React.useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
    }, []);

    // The send path runs a parent onCommand before the model, and always follows the reply. It
    // reads messages and isBusy from a ref, which keeps the memoised composer from re-rendering
    // while a reply streams.
    const sendStateRef = React.useRef({ messages, isBusy });
    sendStateRef.current = { messages, isBusy };
    const wrappedSubmit = React.useCallback((e?: React.SubmitEvent<HTMLFormElement>) => {
        e?.preventDefault();
        const { messages: current, isBusy: busy } = sendStateRef.current;
        const text = inputRef.current.trim();
        if (!text) return;
        // The composer stays usable while a reply streams so a follow-up can be drafted, but the
        // draft must not be dispatched until that reply is done.
        if (busy) return;
        if (onCommand && onCommand(text, current, setMessages)) {
            setInput("");
            return;
        }
        scrollToBottom(); // user just asked - follow the reply
        sendMessage({ text });
        setInput("");
    }, [onCommand, setMessages, scrollToBottom, sendMessage]);

    // A retry follows the reply as a fresh send does, which also hides "↓ Latest".
    const handleRetry = React.useCallback(() => {
        scrollToBottom();
        retry();
    }, [scrollToBottom, retry]);

    // Reset the conversation: abort any in-flight reply, drop history back to the welcome
    // message (the storage effect persists it), and let the parent reset its flow state.
    const handleClear = React.useCallback(() => {
        stop();
        setMessages(buildWelcome(welcomeMessage));
        scrollToBottom();
        onClear?.();
    }, [stop, setMessages, welcomeMessage, onClear, scrollToBottom]);

    // Recomputed when a query settles, which is when the provider has new names and tools to report,
    // rather than on every streamed frame.
    const mcpStatus = React.useMemo(() => getMcpStatus?.(), [getMcpStatus, status]);

    return (
        <div id={id} ref={rootRef}>
            <div className="chat-header">
                {contextStatus && (
                    <Chip
                        icon={"\u{1F4CE}"}
                        label={contextStatus.label}
                        state={contextStatus.state}
                        title={contextStatus.detail}
                        ariaLabel={contextStatus.detail}
                    />
                )}
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
            {/* aria-live is off because role="log" implies "polite", and a streaming bubble changes
                several times a second. The region below the composer announces each reply once.
                tabIndex lets keyboard users scroll the list (WCAG 2.1.1). */}
            <div
                className="chat-message-list"
                ref={listRef}
                onScroll={handleScroll}
                role="log"
                aria-live="off"
                aria-label="Chat messages"
                tabIndex={0}
            >
                {messages.map((message) => (
                    <ChatMessage key={message.id} message={message} />
                ))}
            </div>
            {/* Progress and errors sit outside the scroller, so Stop and the failure reason stay on
                screen when the user scrolls back through a long reply. */}
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
                    <button type="button" className="chat-stop-button" onClick={stop} aria-label="Stop response">
                        Stop
                    </button>
                </div>
            )}
            {error && (
                <div className="chat-error" role="alert">
                    <span className="chat-error-text">{error.message}</span>
                    <button
                        type="button"
                        className="chat-error-retry"
                        onClick={handleRetry}
                        aria-label="Retry request"
                    >
                        Retry
                    </button>
                    <button
                        type="button"
                        className="chat-error-dismiss"
                        onClick={clearError}
                        aria-label="Dismiss error"
                    >
                        &times;
                    </button>
                </div>
            )}
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
            <ChatInput
                input={input}
                handleInputChange={handleInputChange}
                handleSubmit={wrappedSubmit}
                busy={isBusy}
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
