import * as React from "react";
import type { ChatMessage } from "./useChat";
import { injectMessage } from "../util/util";
import { ManageStorage } from "../util/storage";

// Shared flow states for collecting an Argo CD token (MCP feature). Both the resource-
// and system-level extensions fold these into their own FlowNode unions.
export type TokenFlowNode = "token" | "token_saved" | "token_invalid";

// Store the token (or flag it invalid) and post a status message. Returns the next flow
// node so the caller can drive its own state machine.
export function submitToken(
    input: string,
    storage: ManageStorage,
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
): TokenFlowNode {
    if (!input?.trim()) {
        setMessages(
            injectMessage("No token was provided. Please type your token or continue with your question.")
        );
        return "token_invalid";
    }
    storage.mcpToken = input.trim();
    setMessages(injectMessage("Token saved. I will use it for MCP server requests."));
    return "token_saved";
}

interface TokenPromptProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
}

// Password input + Save button shown while collecting the token (states "token" / "token_invalid").
export const TokenPrompt = ({ value, onChange, onSubmit }: TokenPromptProps) => (
    <div className="chat-flow-ui">
        <input
            type="password"
            placeholder="Enter token"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    onSubmit();
                }
            }}
            className="chat-flow-input"
            aria-label="Argo CD token"
        />
        <button onClick={onSubmit} className="chat-flow-button">
            Save
        </button>
    </div>
);
