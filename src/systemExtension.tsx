import MarkdownRenderer, { MarkdownRendererBlock } from "@rcb-plugins/markdown-renderer";
import * as React from "react";
import ChatBot, { Flow } from "react-chatbotify";
import {CHAT_STYLES, chatSettings} from "./util/extensions"
import MarkedWrapper from "./components/MarkedWrapper";
import { isTokenRequest, QueryContextImpl } from "./util/util";
import { ManageStorage } from "./util/storage"
import { ExtensionScope } from "./util/extensions"
import { Attachment, QueryProvider, QueryResponse, AssistantSettings } from "./model/provider";
import { createProvider, Provider } from "./providers/providerFactory";
import { FeatureFlags, isFeatureEnabled } from "./featureFlags";

export const SystemAssistantExtension = (props: any) => {
    console.log("Properties passed to Extension");
    console.log(props);

    const [settings, setSettings] = React.useState<AssistantSettings>(globalThis.argocdAssistantSettings ?? {provider: Provider.LLM});
    const [provider] = React.useState<QueryProvider>(createProvider(settings.provider as Provider));
    const storage = new ManageStorage(ExtensionScope.System);

    React.useEffect(() => {
        if (globalThis.argocdAssistantSettings) {
            setSettings(globalThis.argocdAssistantSettings);
        }
        console.log("Using provider: " + settings.provider);
    }, []);

    const pluginConfig = {
        autoConfig: true,
        markdownComponent: MarkedWrapper
    }
    const plugins = [MarkdownRenderer(pluginConfig)];

    const flow:Flow = {
        start: {
            message: (params) => {
                if (!storage.hasChatHistory()) {
                    params.injectMessage("How can I help you with Argo CD today?");
                }
            },
            renderMarkdown: ["BOT"],
            path: async (params) => {
                if (isTokenRequest(params.userInput) && isFeatureEnabled(FeatureFlags.ArgoCDMCP)) {
                    return "token"
                } else return "loop"
            }
        } as MarkdownRendererBlock,
        loop: {
            message: async (params) => {
                const attachments: Attachment[] = [];
                const currentSettings = globalThis.argocdAssistantSettings ?? settings;
                const context = new QueryContextImpl(undefined, storage.conversationID, storage.data, attachments, currentSettings);

                try {
                    const response: QueryResponse = await provider.query(context, params.userInput, params );
                    if (!response.success) {
                        if (response.error !== undefined) {
                            return "Unexpected Error: " + response.error.message;
                        } else {
                            return "Unexpected Failure: No additional information provided";
                        }
                    }
                    if (response.conversationID !== undefined) storage.conversationID = response.conversationID;
                    if (response.data !== undefined) storage.data = response.data;
                } catch (error) {
                    return "Unexpected Error: " + (error instanceof Error ? error.message : String(error));
                } finally {
                    await params.endStreamMessage("BOT");
                }
            },
            renderMarkdown: ["BOT"],
            path: async (params) => {
                console.log(params.userInput);
                if (isTokenRequest(params.userInput) && isFeatureEnabled(FeatureFlags.ArgoCDMCP)) {
                    return "token"
                } else return "loop"
            }
        } as MarkdownRendererBlock,
        token: {
            message: "Please enter your Argo CD token to use with an MCP server",
            function: (params) => {
                if (params.userInput?.trim()) {
                    storage.mcpToken = params.userInput.trim();
                }
            },
            path: (params) => {
                if (!params.userInput?.trim()) return "token_invalid";
                return "token_saved";
            }
        },
        token_saved: {
            message: "Token saved. I will use it for MCP server requests.",
            path: "loop"
        },
        token_invalid: {
            message: "No token was provided. Please type your token or continue with your question.",
            path: "loop"
        }
    }

    return (
        <ChatBot id="chatbot-system" plugins={plugins} settings={chatSettings(storage.chatHistoryKey)} styles={CHAT_STYLES} flow={flow} />
    );
}
