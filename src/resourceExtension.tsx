import * as React from "react";
import ChatInterface from "./components/ChatInterface";
import { getLogs, hasLogs, MAX_LINES } from "./service/logs";
import {
    getContainers,
    getResourceIdentifier,
    injectMessage,
    isAttachRequest,
    isCancelRequest,
    isTokenRequest,
    mcpConfigured,
    QueryContextImpl,
    stripManifestNoise
} from "./util/util";
import { ManageStorage } from "./util/storage";
import { ExtensionScope } from "./util/extensions";
import { Events, LogEntry } from "./model/argocd";
import {
    Attachment,
    AttachmentType,
    QueryProvider,
    AssistantSettings
} from "./model/provider";
import { createProvider } from "./providers/providerFactory";
import { type ChatMessage } from "./components/useChat";
import { submitToken, TokenFlowNode, TokenPrompt } from "./components/TokenFlow";

type FlowNode =
    | "start"
    | "loop"
    | "attach"
    | "ask_lines"
    | "get_logs"
    | TokenFlowNode;

export const ResourceAssistantExtension = (props: any) => {
    const [settings, setSettings] = React.useState<AssistantSettings>(
        globalThis.argocdAssistantSettings ?? { provider: "LLM" }
    );
    const [provider] = React.useState<QueryProvider>(createProvider());
    const storageRef = React.useRef<ManageStorage | null>(null);

    React.useEffect(() => {
        if (globalThis.argocdAssistantSettings) {
            setSettings(globalThis.argocdAssistantSettings);
        }
    }, []);

    const { resource, application } = props;

    const [form, setForm] = React.useState<{ container?: string; lines?: string; token?: string }>({});
    const [events, setEvents] = React.useState<Events>({
        apiVersion: "v1",
        items: []
    });
    const [flowNode, setFlowNode] = React.useState<FlowNode>("start");
    const [flowError, setFlowError] = React.useState<string | null>(null);

    const containers: string[] = hasLogs(resource) ? getContainers(resource) : [];
    const application_name = application?.metadata?.name || "";
    const resource_name = resource?.metadata?.name || "";
    const resource_kind = resource?.kind || "";
    const resourceID = getResourceIdentifier(resource);
    const maxLogLines: number =
        settings.maximumLogLines != undefined ? settings.maximumLogLines : MAX_LINES;

    const mcpServers: string[] | undefined = settings.data?.mcpServers;
    const mcpEnabled = mcpConfigured(mcpServers);
    const getMcpStatus = mcpEnabled
        ? () => provider.getMcpStatus?.(mcpServers!) ?? []
        : undefined;

    const [chatKey, setChatKey] = React.useState<string | null>(null);

    // On resource change, reset storage and (re)mount ChatInterface via chatKey.
    React.useEffect(() => {
        if (resourceID === "Undefined") return;
        if (!storageRef.current || storageRef.current.namespace !== resourceID) {
            storageRef.current = new ManageStorage(ExtensionScope.Resource, resourceID);
        }
        setFlowNode("start");
        setForm({});
        setChatKey(resourceID);
    }, [resourceID]);

    const getContext = React.useCallback(() => {
        const attachments: Attachment[] = [];

        if (resource) {
            attachments.push({
                content: JSON.stringify(stripManifestNoise(resource)),
                mimeType: "application/json",
                type: AttachmentType.MANIFEST
            });
        }

        if (events?.items?.length > 0) {
            attachments.push({
                content: JSON.stringify({ ...events, items: events.items.map(stripManifestNoise) }),
                mimeType: "application/json",
                type: AttachmentType.EVENTS
            });
        }

        if (storageRef.current!.hasLogs()) {
            attachments.push({
                content: storageRef.current!.logs,
                mimeType: "application/json",
                type: AttachmentType.LOG
            });
        }

        const currentSettings = globalThis.argocdAssistantSettings ?? settings;
        return new QueryContextImpl(
            application,
            attachments,
            currentSettings
        );
    }, [application, resource, events, settings]);

    const welcomeMessage =
        "How can I help you with the resource **" +
        resource_name +
        "** of type " +
        resource_kind +
        "?" +
        (hasLogs(resource)
            ? " I notice this resource has logs available, to attach one or more container logs type *Attach* at any time."
            : "");

    const handleCancel = React.useCallback(() => {
        setFlowNode("loop");
        setForm({});
        setFlowError(null);
    }, []);

    const handleCommand = React.useCallback(
        (input: string, _messages: ChatMessage[], setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            if (flowNode !== "start" && flowNode !== "loop" && flowNode !== "token_saved") {
                if (isCancelRequest(input)) {
                    setFlowNode("loop");
                    setForm({});
                    setFlowError(null);
                    return true;
                }
                if (!isAttachRequest(input) && !isTokenRequest(input)) {
                    setFlowNode("loop");
                    return false;
                }
            }
            if (isAttachRequest(input) && hasLogs(resource)) {
                setMessages(injectMessage("Select the single container for which to attach the logs:"));
                setFlowNode("attach");
                setFlowError(null);
                return true;
            }
            if (isAttachRequest(input) && !hasLogs(resource)) {
                setMessages(
                    injectMessage(
                        "Sorry, logs can only be attached for resources with logs (Deployment, StatefulSet, Pod, etc)."
                    )
                );
                return true;
            }
            if (isTokenRequest(input) && mcpConfigured(mcpServers)) {
                setMessages(
                    injectMessage("Please enter your Argo CD token to use with an MCP server")
                );
                setFlowNode("token");
                setForm({});
                setFlowError(null);
                return true;
            }
            return false;
        },
        [flowNode, resource, mcpServers]
    );

    const handleContainerSelect = React.useCallback((container: string) => {
        setForm({ container });
        setFlowNode("ask_lines");
        setFlowError(null);
    }, []);

    const handleLinesSubmit = React.useCallback(
        (setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            const lines = Number(form.lines);
            if (isNaN(lines)) {
                setFlowError("The number of lines needs to be a valid number.");
                return;
            }
            if (lines === 0 || lines > maxLogLines) {
                setFlowError(
                    "The number of lines needs to be more than 0 and " + maxLogLines + " or less"
                );
                return;
            }
            setFlowError(null);
            setFlowNode("get_logs");
            getLogs(application, resource, form.container, lines)
                .then((result: LogEntry[]) => {
                    storageRef.current!.logs = JSON.stringify(result);
                    setMessages(injectMessage("Requested logs have been attached"));
                    setFlowNode("loop");
                })
                .catch((error) => {
                    setMessages(
                        injectMessage(
                            "Unexpected Error: " +
                                (error instanceof Error ? error.message : String(error))
                        )
                    );
                    setFlowNode("loop");
                });
        },
        [form, maxLogLines, application, resource]
    );

    const handleTokenSubmit = React.useCallback(
        (input: string, setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            const next = submitToken(input, storageRef.current!, setMessages);
            if (next === "token_saved") setForm({});
            setFlowNode(next);
        },
        []
    );

    React.useEffect(() => {
        let cancelled = false;
        // Clear the previous resource's events and ignore superseded responses on switch.
        setEvents({ apiVersion: "v1", items: [] });
        let url = `/api/v1/applications/${application_name}/events?resourceUID=${resource.metadata.uid}&resourceNamespace=${resource.metadata.namespace}&resourceName=${resource.metadata.name}`;
        if (resource.kind === "Application") {
            url = `/api/v1/applications/${application_name}/events`;
        }
        fetch(url)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Events API returned ${response.status} ${response.statusText}`);
                }
                return response.json();
            })
            .then((data) => {
                if (!cancelled) {
                    setEvents({ apiVersion: "v1", items: data.items ?? [] });
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    console.error("Failed to fetch events:", err);
                }
            });
        return () => { cancelled = true; };
    }, [application, resource, application_name]);

    const flowUI = React.useCallback(
        (setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            switch (flowNode) {
                case "attach":
                    return (
                        <div className="chat-flow-ui">
                            {containers.map((c) => (
                                <button
                                    key={c}
                                    onClick={() => handleContainerSelect(c)}
                                    className="chat-flow-button"
                                    aria-label={`Select container ${c}`}
                                >
                                    {c}
                                </button>
                            ))}
                            <button onClick={handleCancel} className="chat-flow-button-cancel">
                                Cancel
                            </button>
                        </div>
                    );
                case "ask_lines":
                    return (
                        <div className="chat-flow-ui">
                            <input
                                type="number"
                                placeholder={`Max ${maxLogLines}`}
                                value={form.lines || ""}
                                onChange={(e) => {
                                    const value = e.target.value;
                                    setForm((prev) => ({ ...prev, lines: value }));
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        handleLinesSubmit(setMessages);
                                    }
                                }}
                                className="chat-flow-input"
                                aria-label="Number of log lines"
                            />
                            <button
                                onClick={() => handleLinesSubmit(setMessages)}
                                className="chat-flow-button"
                            >
                                OK
                            </button>
                            <button onClick={handleCancel} className="chat-flow-button-cancel">
                                Cancel
                            </button>
                            {flowError && <span className="chat-flow-error" role="alert">{flowError}</span>}
                        </div>
                    );
                case "token":
                case "token_invalid":
                    return (
                        <TokenPrompt
                            value={form.token || ""}
                            onChange={(v) => setForm({ token: v })}
                            onSubmit={() => handleTokenSubmit(form.token || "", setMessages)}
                        />
                    );
                default:
                    return null;
            }
        },
        [flowNode, containers, form, maxLogLines, flowError, handleCancel, handleContainerSelect, handleLinesSubmit, handleTokenSubmit]
    );

    if (chatKey === null) return null;

    return (
        <ChatInterface
            key={chatKey}
            id="chatbot-resource"
            provider={provider}
            getContext={getContext}
            welcomeMessage={welcomeMessage}
            storage={storageRef.current!}
            onCommand={handleCommand}
            onClear={handleCancel}
            getMcpStatus={getMcpStatus}
        >
            {(helpers) => flowUI(helpers.setMessages)}
        </ChatInterface>
    );
};
