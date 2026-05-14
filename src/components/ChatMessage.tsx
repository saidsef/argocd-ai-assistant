import * as React from "react";
import MarkedWrapper from "./MarkedWrapper";
import { type ChatMessage } from "./useChat";

interface ChatMessageProps {
    message: ChatMessage;
}

const ChatMessage = ({ message }: ChatMessageProps) => {
    const isUser = message.role === "user";
    const className = isUser ? "chat-message-user" : "chat-message-assistant";

    const textParts = message.parts?.filter((p) => p.type === "text") || [];

    return (
        <div className={`chat-message ${className}`}>
            {textParts.map((part, i) => {
                if (part.type === "text") {
                    if (isUser) {
                        return <span key={i}>{part.text}</span>;
                    }
                    return <MarkedWrapper key={i}>{part.text}</MarkedWrapper>;
                }
                return null;
            })}
        </div>
    );
};

export default ChatMessage;
