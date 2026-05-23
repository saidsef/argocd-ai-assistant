import * as React from "react";

interface ChatInputProps {
    input: string;
    handleInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    handleSubmit: (e?: React.SubmitEvent<HTMLFormElement>) => void;
    disabled: boolean;
}

const ChatInput = ({ input, handleInputChange, handleSubmit, disabled }: ChatInputProps) => {
    return (
        <form onSubmit={handleSubmit} className="chat-input-form">
            <input
                value={input}
                onChange={handleInputChange}
                disabled={disabled}
                placeholder="How can I assist you today?"
                className="chat-input"
                aria-label="Chat message"
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
