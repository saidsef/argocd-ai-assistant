import * as React from "react";
import MarkedWrapper from "./MarkedWrapper";
import { copyText, useCopyState } from "./useCopy";
import { type ChatMessage } from "./useChat";

interface ChatMessageProps {
    message: ChatMessage;
}

const ChatMessage = ({ message }: ChatMessageProps) => {
    const isUser = message.role === "user";
    const className = isUser ? "chat-message-user" : "chat-message-assistant";

    const textParts = message.parts?.filter((p) => p.type === "text") || [];
    const [copyState, announceCopy] = useCopyState();

    // Copy the whole answer, not just a fenced block: an explanation with the commands interleaved is
    // the thing people paste into a ticket, and only the code blocks were copyable before.
    const fullText = textParts.map((p) => p.text).join("");
    const onCopy = React.useCallback(() => {
        copyText(fullText).then(announceCopy);
    }, [fullText, announceCopy]);

    return (
        <div className={`chat-message ${className}`}>
            {textParts.map((part, i) =>
                isUser
                    // pre-wrap in CSS: the user's own Shift+Enter newlines used to collapse on submit.
                    ? <span key={`${message.id}-${i}`}>{part.text}</span>
                    : <MarkedWrapper key={`${message.id}-${i}`}>{part.text}</MarkedWrapper>
            )}
            {/* A cut-short reply must not read as a finished one - the truncated half of a
                remediation step looks exactly like complete advice. */}
            {!isUser && message.stopped && <span className="chat-message-stopped">Stopped</span>}
            {!isUser && fullText.length > 0 && (
                <button
                    type="button"
                    className="chat-message-copy"
                    onClick={onCopy}
                    // The accessible name always contains the visible label (WCAG 2.5.3), so the two
                    // never drift the way the code-block button's fixed label used to.
                    aria-label={copyState === "copied" ? "Copied message" : copyState === "failed" ? "Copy failed" : "Copy message"}
                >
                    {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
                </button>
            )}
        </div>
    );
};

// Memoized so a streaming reply only re-renders its own bubble each frame,
// not every message in the list. useChat keeps stable references for
// unchanged messages, so shallow prop comparison is safe here.
export default React.memo(ChatMessage);
