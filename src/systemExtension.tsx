import * as React from "react";
import ChatInterface from "./components/ChatInterface";
import { injectMessage, isTokenRequest, QueryContextImpl } from "./util/util";
import { ManageStorage } from "./util/storage";
import { ExtensionScope } from "./util/extensions";
import { AssistantSettings } from "./model/provider";
import { createProvider, Provider } from "./providers/providerFactory";
import { FeatureFlags, isFeatureEnabled } from "./featureFlags";
import { type ChatMessage } from "./components/useChat";

type FlowNode = "start" | "loop" | "token" | "token_saved" | "token_invalid";

export const SystemAssistantExtension = (props: any) => {
    const [settings, setSettings] = React.useState<AssistantSettings>(
        globalThis.argocdAssistantSettings ?? { provider: Provider.LLM }
    );
    const [provider] = React.useState(
        createProvider(settings.provider as Provider)
    );
    const storageRef = React.useRef(new ManageStorage(ExtensionScope.System));

    React.useEffect(() => {
        if (globalThis.argocdAssistantSettings) {
            setSettings(globalThis.argocdAssistantSettings);
        }
    }, []);

    const [form, setForm] = React.useState<{ token?: string }>({});
    const [flowNode, setFlowNode] = React.useState<FlowNode>("start");

    const getContext = React.useCallback(() => {
        const currentSettings = globalThis.argocdAssistantSettings ?? settings;
        return new QueryContextImpl(
            undefined,
            [],
            currentSettings
        );
    }, [settings]);

    const welcomeMessage = "How can I help you with Argo CD today?";

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
                setForm({});
                return true;
            }
            return false;
        },
        [flowNode]
    );

    const handleTokenSubmit = React.useCallback(
        (input: string, setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            if (!input?.trim()) {
                setMessages(
                    injectMessage(
                        "No token was provided. Please type your token or continue with your question."
                    )
                );
                setFlowNode("token_invalid");
                return;
            }
            storageRef.current.mcpToken = input.trim();
            setMessages(injectMessage("Token saved. I will use it for MCP server requests."));
            setForm({});
            setFlowNode("token_saved");
        },
        []
    );

    const flowUI = React.useCallback(
        (setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            if (flowNode === "token" || flowNode === "token_invalid") {
                return (
                    <div className="chat-flow-ui">
                        <input
                            type="password"
                            placeholder="Enter token"
                            value={form.token || ""}
                            onChange={(e) => setForm({ token: e.target.value })}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    handleTokenSubmit(form.token || "", setMessages);
                                }
                            }}
                            className="chat-flow-input"
                            aria-label="Argo CD token"
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
        },
        [flowNode, form, handleTokenSubmit]
    );

    return (
        <ChatInterface
            id="chatbot-system"
            provider={provider}
            getContext={getContext}
            welcomeMessage={welcomeMessage}
            storage={storageRef.current}
            onCommand={handleCommand}
        >
            {(helpers) => flowUI(helpers.setMessages)}
        </ChatInterface>
    );
};
