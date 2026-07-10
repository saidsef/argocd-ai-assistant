import * as React from "react";
import ChatInterface from "./components/ChatInterface";
import { injectMessage, isTokenRequest, QueryContextImpl } from "./util/util";
import { ManageStorage } from "./util/storage";
import { ExtensionScope } from "./util/extensions";
import { AssistantSettings } from "./model/provider";
import { createProvider, Provider } from "./providers/providerFactory";
import { FeatureFlags, isFeatureEnabled } from "./featureFlags";
import { type ChatMessage } from "./components/useChat";
import { submitToken, TokenFlowNode, TokenPrompt } from "./components/TokenFlow";

type FlowNode = "start" | "loop" | TokenFlowNode;

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
            const next = submitToken(input, storageRef.current, setMessages);
            if (next === "token_saved") setForm({});
            setFlowNode(next);
        },
        []
    );

    const handleClearFlow = React.useCallback(() => {
        setFlowNode("start");
        setForm({});
    }, []);

    const flowUI = React.useCallback(
        (setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            if (flowNode === "token" || flowNode === "token_invalid") {
                return (
                    <TokenPrompt
                        value={form.token || ""}
                        onChange={(v) => setForm({ token: v })}
                        onSubmit={() => handleTokenSubmit(form.token || "", setMessages)}
                    />
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
            onClear={handleClearFlow}
        >
            {(helpers) => flowUI(helpers.setMessages)}
        </ChatInterface>
    );
};
