import * as React from "react";
import ChatInterface from "./components/ChatInterface";
import { injectMessage, isTokenRequest, mcpConfigured, mcpWelcomeHint } from "./util/util";
import { ManageStorage } from "./util/storage";
import { ExtensionScope } from "./util/extensions";
import { type ChatMessage } from "./components/useChat";
import { useAssistantSettings } from "./components/useAssistantSettings";
import { submitToken, TokenFlowNode, TokenPrompt } from "./components/TokenFlow";
import { getProxyApplication } from "./service/routing";

type FlowNode = "start" | "loop" | TokenFlowNode;

export const SystemAssistantExtension = (_props: any) => {
    const storageRef = React.useRef(new ManageStorage(ExtensionScope.System));
    const { settings, provider, mcpServers, getMcpStatus } = useAssistantSettings(storageRef.current?.mcpToken ?? undefined);

    const [form, setForm] = React.useState<{ token?: string }>({});
    const [flowNode, setFlowNode] = React.useState<FlowNode>("start");
    // The Argo CD proxy authorises LLM traffic per Application, and this page has none of its own,
    // so it borrows one purely for routing. Without it every request is rejected with
    // "400 Invalid headers: invalid value for namespace". Nothing about it reaches the model.
    const [routingApp, setRoutingApp] = React.useState<any | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        getProxyApplication().then((app) => {
            if (!cancelled) setRoutingApp(app);
        });
        return () => { cancelled = true; };
    }, []);

    const getContext = React.useCallback(() => ({
        application: routingApp,
        attachments: [],
        settings: globalThis.argocdAssistantSettings ?? settings,
        mcpToken: storageRef.current?.mcpToken ?? undefined
    }), [settings, routingApp]);

    const welcomeMessage = "How can I help you with Argo CD today?" +
        mcpWelcomeHint((getMcpStatus?.() ?? []).map((s) => s.handle));

    const handleCommand = React.useCallback(
        (input: string, _messages: ChatMessage[], setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            if (flowNode !== "start" && flowNode !== "loop" && flowNode !== "token_saved") {
                if (!isTokenRequest(input)) {
                    setFlowNode("loop");
                    return false;
                }
            }
            if (isTokenRequest(input) && mcpConfigured(mcpServers)) {
                setMessages(
                    injectMessage("Please enter your Argo CD token to use with an MCP server")
                );
                setFlowNode("token");
                setForm({});
                return true;
            }
            return false;
        },
        [flowNode, mcpServers]
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
            getMcpStatus={getMcpStatus}
        >
            {(helpers) => flowUI(helpers.setMessages)}
        </ChatInterface>
    );
};
