import * as React from "react";

interface ChatInputProps {
    input: string;
    handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    handleSubmit: (e?: React.SubmitEvent<HTMLFormElement>) => void;
    disabled: boolean;
}

const ChatInput = ({ input, handleInputChange, handleSubmit, disabled }: ChatInputProps) => {
    const inputRef = React.useRef<HTMLTextAreaElement>(null);

    // Focus on mount and when the box re-enables after a reply.
    React.useEffect(() => {
        if (!disabled) inputRef.current?.focus({ preventScroll: true });
    }, [disabled]);

    // Auto-grow the textarea up to a cap instead of scrolling a single row.
    React.useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }, [input]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter sends; Shift+Enter inserts a newline. Ignore Enter mid-IME-composition.
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <form onSubmit={handleSubmit} className="chat-input-form">
            <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={onKeyDown}
                disabled={disabled}
                placeholder="How can I assist you today?"
                className="chat-input"
                aria-label="Chat message"
                rows={1}
            />
            <button
                type="submit"
                disabled={disabled || !input.trim()}
                className="chat-send-button"
                aria-label="Send message"
            >
                Send
            </button>
        </form>
    );
};

export default ChatInput;
