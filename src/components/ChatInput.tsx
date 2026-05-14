import * as React from "react";

interface ChatInputProps {
    input: string;
    handleInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    handleSubmit: (e?: React.FormEvent<HTMLFormElement>) => void;
    disabled: boolean;
}

const ChatInput = ({ input, handleInputChange, handleSubmit, disabled }: ChatInputProps) => {
    return (
        <form onSubmit={handleSubmit} className="chat-input-form">
            <input
                value={input}
                onChange={handleInputChange}
                disabled={disabled}
                placeholder="Type a message..."
                className="chat-input"
            />
            <button
                type="submit"
                disabled={disabled || !input.trim()}
                className="chat-send-button"
            >
                Send
            </button>
        </form>
    );
};

export default ChatInput;
