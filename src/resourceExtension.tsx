import MarkdownRenderer, { MarkdownRendererBlock } from "@rcb-plugins/markdown-renderer";
import * as React from "react";
import ChatBot, { Flow } from "react-chatbotify";
import {CHAT_STYLES, chatSettings} from "./util/extensions"
import MarkedWrapper from "./components/MarkedWrapper";
import {getLogs, hasLogs, MAX_LINES} from "./service/logs";
import { getContainers, getResourceIdentifier, isAttachRequest, isCancelRequest, isTokenRequest, QueryContextImpl } from "./util/util";
import { ManageStorage } from "./util/storage"
import { ExtensionScope } from "./util/extensions"
import { Events, LogEntry } from "./model/argocd";
import { Attachment, AttachmentType, QueryProvider, QueryResponse, AssistantSettings } from "./model/provider";
import { createProvider, Provider } from "./providers/providerFactory";
import { FeatureFlags, isFeatureEnabled } from "./featureFlags";

export const ResourceAssistantExtension = (props: any) => {
    console.log("Properties passed to Extension");
    console.log(props);

    const [settings, setSettings] = React.useState<AssistantSettings>(globalThis.argocdAssistantSettings ?? {provider: Provider.LLM});
    const [provider] = React.useState<QueryProvider>(createProvider(settings.provider as Provider));
    const storage = new ManageStorage(ExtensionScope.Resource);

    React.useEffect(() => {
        if (globalThis.argocdAssistantSettings) {
            setSettings(globalThis.argocdAssistantSettings);
        }
        console.log("Using provider: " + settings.provider);
    }, []);

    const { resource, application } = props;

    const pluginConfig = {
        autoConfig: true,
        markdownComponent: MarkedWrapper
    }
    const plugins = [MarkdownRenderer(pluginConfig)];

    const [form, setForm] = React.useState({});
    const [events, setEvents] = React.useState<Events>({
        apiVersion: "v1",
        items: []
    });

    const containers:string[] = hasLogs(resource) ? getContainers(resource) : [];
    const application_name = application?.metadata?.name || "";
    const resource_name = resource?.metadata?.name || "";
    const resource_kind = resource?.kind || "";

    const currentResourceID = storage.resourceID;
    const resourceID = getResourceIdentifier(resource);
    const maxLogLines:number = (settings.maximumLogLines != undefined ? settings.maximumLogLines : MAX_LINES);

    if (currentResourceID !== resourceID) {
        storage.clear();
        storage.resourceID = resourceID;
    }

    const flow:Flow = {
        start: {
            message: (params) => {
                if (!storage.hasChatHistory()) {
                    params.injectMessage("How can I help you with the resource **" +
                                          resource_name +
                                          "** of type " +
                                          resource_kind + "?" +
                                          ( hasLogs(resource) ? " I notice this resource has logs available, to attach one or more container logs type *Attach* at any time.": ""));
                }
            },
            renderMarkdown: ["BOT"],
            path: async (params) => {
                if (isAttachRequest(params.userInput) && hasLogs(resource)) {
                    return "attach"
                } else if (isAttachRequest(params.userInput)) {
                    return "no_attach"
                } else if (isTokenRequest(params.userInput) && isFeatureEnabled(FeatureFlags.ArgoCDMCP)) {
                    return "token"
                } else return "loop"
            }
        } as MarkdownRendererBlock,
        loop: {
            message: async (params) => {
                const attachments: Attachment[] = [];

                if (resource) {
                    attachments.push(
                        {
                            content: JSON.stringify(resource),
                            mimeType: "application/json",
                            type: AttachmentType.MANIFEST
                        }
                    )
                }

                if (events?.items?.length > 0) {
                    attachments.push(
                        {
                            content: JSON.stringify(events),
                            mimeType: "application/json",
                            type: AttachmentType.EVENTS
                        }
                    )
                }

                if (storage.hasLogs() ) {
                    attachments.push(
                        {
                            content: storage.logs,
                            mimeType: "application/json",
                            type: AttachmentType.LOG
                        }
                    )
                }

                const currentSettings = globalThis.argocdAssistantSettings ?? settings;
                const context = new QueryContextImpl(application, storage.conversationID, storage.data, attachments, currentSettings);

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
                }
            },
            renderMarkdown: ["BOT"],
            path: async (params) => {
                console.log(params.userInput);
                if (isAttachRequest(params.userInput) && hasLogs(resource)) {
                    return "attach"
                } else if (isAttachRequest(params.userInput)) {
                    return "no_attach"
                } else if (isTokenRequest(params.userInput) && isFeatureEnabled(FeatureFlags.ArgoCDMCP)) {
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
        },
        no_attach: {
            message: "Sorry, logs can only be attached for resources with logs (Deployment, StatefulSet, Pod, etc).",
            path: "loop"
        },
        attach: {
            message: "Select the single container for which to attach the logs:",
            checkboxes: {items: containers, min: 1, max: 1},
            chatDisabled: true,
            function: (params) => setForm({...form, container: params.userInput}),
            path: "ask_lines"
        },
        ask_lines: {
            message: "How many lines of the log did you want to attach (max " + maxLogLines + ")?",
            function: (params) => {
                setForm({...form, lines: params.userInput});
            },
            path: async (params) => {
                if (params.userInput)
                if (isNaN(Number(params.userInput))) {
                    await params.injectMessage("The number of lines needs to be a valid number.");
                    return;
                }
                if (Number(params.userInput) == 0 || Number(params.userInput) > maxLogLines ) {
                    await params.injectMessage("The number of lines needs to be more then 0 and " + maxLogLines + " or less");
                    return;
                }
                if (isCancelRequest(params.userInput)) return "start";
                return "get_logs";
            }
        },
        get_logs: {
            message: async(params) => {
                try {
                    const result:LogEntry[] = await getLogs(application, resource, form["container"], form["lines"]);
                    storage.logs = JSON.stringify(result);
                    return "Requested logs have been attached";
                } catch (error) {
                    return "Unexpected Error: " + (error instanceof Error ? error.message : String(error));
                }
            },
            path: "loop"
        }
    }

    React.useEffect(() => {
        let url = `/api/v1/applications/${application_name}/events?resourceUID=${resource.metadata.uid}&resourceNamespace=${resource.metadata.namespace}&resourceName=${resource.metadata.name}`;
        if (resource.kind === "Application") {
          url = `/api/v1/applications/${application_name}/events`;
        }
        fetch(url)
          .then(response => {
              if (!response.ok) {
                  throw new Error(`Events API returned ${response.status} ${response.statusText}`);
              }
              return response.json();
          })
          .then(data => {
            setEvents({
                apiVersion: "v1",
                items: data.items
            });
          })
          .catch(err => {
            console.error("Failed to fetch events:", err);
          });
      }, [application, resource, application_name]);

    return (
        <ChatBot id="chatbot-resource" plugins={plugins} settings={chatSettings(storage.chatHistoryKey)} styles={CHAT_STYLES} flow={flow} />
    );
}
