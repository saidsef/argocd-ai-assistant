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

    const [settings] = React.useState<AssistantSettings>(globalThis.argocdAssistantSettings != undefined ? globalThis.argocdAssistantSettings: {provider: Provider.LLM});
    const [provider] = React.useState<QueryProvider>(createProvider(settings.provider as Provider));
    const storage = new ManageStorage(ExtensionScope.System);

    React.useEffect(() => {
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
                const context = new QueryContextImpl(undefined, storage.conversationID, storage.data, attachments, settings);

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
                    return "Unexpected Error: " + error.message + "";
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
                storage.mcpToken = params.userInput;
            },
            path: "loop"
        }
    }

    return (
        <ChatBot id="chatbot-system" plugins={plugins} settings={chatSettings(storage.chatHistoryKey)} styles={CHAT_STYLES} flow={flow} />
    );
}
