import * as React from "react";

interface ChatInputProps {
    input: string;
    handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    handleSubmit: (e?: React.SubmitEvent<HTMLFormElement>) => void;
    /** A reply is in flight: Send is disabled and Enter does not submit, but typing stays available. */
    busy: boolean;
}

const ChatInput = ({ input, handleInputChange, handleSubmit, busy }: ChatInputProps) => {
    const inputRef = React.useRef<HTMLTextAreaElement>(null);

    // Focus on mount. The textarea is never disabled, so focus is never taken away and never needs
    // restoring: disabling it while a reply streamed moved focus to <body> for the whole reply, which
    // lost the user's place and stopped them drafting a follow-up.
    React.useEffect(() => {
        inputRef.current?.focus({ preventScroll: true });
    }, []);

    // Auto-grow the textarea up to a cap instead of scrolling a single row.
    React.useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }, [input]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter sends; Shift+Enter inserts a newline. Ignore Enter mid-IME-composition, and while a
        // reply is streaming (the draft is kept, it just does not submit yet).
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!busy) handleSubmit();
        }
    };

    return (
        <form onSubmit={handleSubmit} className="chat-input-form">
            <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={onKeyDown}
                placeholder={busy ? "Draft your next question…" : "How can I assist you today?"}
                className="chat-input"
                aria-label="Chat message"
                rows={1}
            />
            <button
                type="submit"
                disabled={busy || !input.trim()}
                className="chat-send-button"
                aria-label="Send message"
            >
                Send
            </button>
        </form>
    );
};

// Memoised: this sits beside a bubble that re-renders every animation frame while streaming, and
// nothing here changes between frames.
export default React.memo(ChatInput);
