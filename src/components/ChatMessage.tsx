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
            {textParts.map((part, i) =>
                isUser
                    ? <span key={`${message.id}-${i}`}>{part.text}</span>
                    : <MarkedWrapper key={`${message.id}-${i}`}>{part.text}</MarkedWrapper>
            )}
        </div>
    );
};

// Memoized so a streaming reply only re-renders its own bubble each frame,
// not every message in the list. useChat keeps stable references for
// unchanged messages, so shallow prop comparison is safe here.
export default React.memo(ChatMessage);
