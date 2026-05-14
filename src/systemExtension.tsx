import * as React from "react";
import ChatInterface from "./components/ChatInterface";
import { generateId, isTokenRequest, QueryContextImpl } from "./util/util";
import { ManageStorage } from "./util/storage";
import { ExtensionScope } from "./util/extensions";
import { AssistantSettings } from "./model/provider";
import { createProvider, Provider } from "./providers/providerFactory";
import { FeatureFlags, isFeatureEnabled } from "./featureFlags";
import { type ChatMessage } from "./components/useChat";

type FlowNode = "start" | "loop" | "token" | "token_saved" | "token_invalid";

export const SystemAssistantExtension = (props: any) => {
    console.log("Properties passed to Extension");
    console.log(props);

    const [settings, setSettings] = React.useState<AssistantSettings>(
        globalThis.argocdAssistantSettings ?? { provider: Provider.LLM }
    );
    const [provider] = React.useState(
        createProvider(settings.provider as Provider)
    );
    const storage = new ManageStorage(ExtensionScope.System);

    React.useEffect(() => {
        if (globalThis.argocdAssistantSettings) {
            setSettings(globalThis.argocdAssistantSettings);
        }
        console.log("Using provider: " + settings.provider);
    }, []);

    const [form, setForm] = React.useState<{ token?: string }>({});
    const [flowNode, setFlowNode] = React.useState<FlowNode>("start");

    const getContext = React.useCallback(() => {
        const currentSettings = globalThis.argocdAssistantSettings ?? settings;
        return new QueryContextImpl(
            undefined,
            storage.conversationID,
            storage.data,
            [],
            currentSettings
        );
    }, [settings, storage]);

    const welcomeMessage = "How can I help you with Argo CD today?";

    const injectMessage = React.useCallback(
        (msg: string, role: "user" | "assistant" = "assistant") => {
            return (prev: ChatMessage[]) => [
                ...prev,
                {
                    id: generateId(),
                    role,
                    parts: [{ type: "text" as const, text: msg }]
                } as ChatMessage
            ];
        },
        []
    );

    const handleCommand = React.useCallback(
        (input: string, _messages: ChatMessage[], setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            if (flowNode !== "start" && flowNode !== "loop" && flowNode !== "token_saved") {
                if (!isTokenRequest(input)) {
                    setFlowNode("loop");
                    return false;
                }
            }
            if (isTokenRequest(input) && isFeatureEnabled(FeatureFlags.ArgoCDMCP)) {
                setMessages(
                    injectMessage("Please enter your Argo CD token to use with an MCP server")
                );
                setFlowNode("token");
                return true;
            }
            return false;
        },
        [flowNode, injectMessage]
    );

    const handleTokenSubmit = (
        input: string,
        setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
    ) => {
        if (!input?.trim()) {
            setMessages(
                injectMessage(
                    "No token was provided. Please type your token or continue with your question."
                )
            );
            setFlowNode("token_invalid");
            return;
        }
        storage.mcpToken = input.trim();
        setMessages(injectMessage("Token saved. I will use it for MCP server requests."));
        setFlowNode("token_saved");
    };

    const flowUI = (setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
        if (flowNode === "token" || flowNode === "token_invalid") {
            return (
                <div className="chat-flow-ui">
                    <input
                        type="password"
                        placeholder="Enter token"
                        onChange={(e) => setForm({ token: e.target.value })}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                handleTokenSubmit(form.token || "", setMessages);
                            }
                        }}
                        className="chat-flow-input"
                    />
                    <button
                        onClick={() => handleTokenSubmit(form.token || "", setMessages)}
                        className="chat-flow-button"
                    >
                        Save
                    </button>
                </div>
            );
        }
        return null;
    };

    return (
        <ChatInterface
            id="chatbot-system"
            provider={provider}
            getContext={getContext}
            welcomeMessage={welcomeMessage}
            storage={storage}
            onCommand={handleCommand}
        >
            {(helpers) => flowUI(helpers.setMessages)}
        </ChatInterface>
    );
};
