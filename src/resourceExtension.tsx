import * as React from "react";
import ChatInterface from "./components/ChatInterface";
import { getLogs, hasLogs, MAX_LINES, summariseLogs } from "./service/logs";
import { ApplicationSummary, getApplicationSummary, summariseApplication } from "./service/application";
import {
    argocdApiHeaders,
    getContainers,
    getResourceIdentifier,
    injectMessage,
    isAttachRequest,
    isCancelRequest,
    isTokenRequest,
    mcpConfigured,
    stripManifestNoise
} from "./util/util";
import { capText, MAX_APP_SUMMARY_CHARS, MAX_EVENTS_CHARS, MAX_MANIFEST_CHARS } from "./util/context";
import { MAX_EVENTS, summariseEvents } from "./service/events";
import { ManageStorage } from "./util/storage";
import { ExtensionScope } from "./util/extensions";
import { Events, LogEntry } from "./model/argocd";
import { Attachment, AttachmentType } from "./model/provider";
import { type ChatMessage } from "./components/useChat";
import { useAssistantSettings } from "./components/useAssistantSettings";
import { submitToken, TokenFlowNode, TokenPrompt } from "./components/TokenFlow";

type FlowNode =
    | "start"
    | "loop"
    | "attach"
    | "ask_lines"
    | "get_logs"
    | TokenFlowNode;

export const ResourceAssistantExtension = (props: any) => {
    const { settings, provider, mcpServers, getMcpStatus } = useAssistantSettings();
    const storageRef = React.useRef<ManageStorage | null>(null);

    const { resource, application } = props;

    const [form, setForm] = React.useState<{ container?: string; lines?: string; token?: string }>({});
    const [events, setEvents] = React.useState<Events>({
        apiVersion: "v1",
        items: []
    });
    const [flowNode, setFlowNode] = React.useState<FlowNode>("start");
    const [flowError, setFlowError] = React.useState<string | null>(null);
    const [appSummary, setAppSummary] = React.useState<ApplicationSummary | null>(null);
    const linesInputRef = React.useRef<HTMLInputElement>(null);

    // Focus the log-lines field when its flow node appears, mirroring TokenPrompt/ChatInput.
    // preventScroll matches those paths so bringing the field into focus never jumps the page.
    React.useEffect(() => {
        if (flowNode === "ask_lines") linesInputRef.current?.focus({ preventScroll: true });
    }, [flowNode]);

    const containers: string[] = hasLogs(resource) ? getContainers(resource) : [];
    const application_name = application?.metadata?.name || "";
    const resource_name = resource?.metadata?.name || "";
    const resource_kind = resource?.kind || "";
    const resourceID = getResourceIdentifier(resource);
    const maxLogLines: number =
        settings.maximumLogLines != undefined ? settings.maximumLogLines : MAX_LINES;

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

        // Distilled Argo CD Application summary (the `argocd app get` review view). Fetched into
        // state asynchronously; until it lands we fall back to summarising an Application object we
        // already hold, so grounding is never empty on first paint. The fallback only ever summarises
        // an actual Application (the resource when it is one, else the owning `application` prop) -
        // never a child resource, which would yield a misleading, mostly-empty "Application" summary.
        const isApplication = resource?.kind === "Application";
        const appObject = isApplication ? (application ?? resource) : application;
        const summary = appSummary ?? summariseApplication(appObject);

        // Every attachment is capped by size as well as by item count: the distillers bound how many
        // entries go in, these bound how large a single entry can be (see util/context.ts).
        const json = (value: any, max: number, what: string) =>
            capText(JSON.stringify(value), max, what);

        if (isApplication && summary) {
            // For an Application resource the compact summary supersedes the full manifest (which
            // carries the entire resource tree/history) - large token saving, same review signal.
            attachments.push({
                content: json(summary, MAX_APP_SUMMARY_CHARS, "the application summary"),
                mimeType: "application/json",
                type: AttachmentType.APP_SUMMARY
            });
        } else if (resource) {
            attachments.push({
                content: json(stripManifestNoise(resource), MAX_MANIFEST_CHARS, "the resource manifest"),
                mimeType: "application/json",
                type: AttachmentType.MANIFEST
            });
            // Ground a child resource (Deployment, Pod, ...) in its owning Application's GitOps state.
            if (summary) {
                attachments.push({
                    content: json(summary, MAX_APP_SUMMARY_CHARS, "the application summary"),
                    mimeType: "application/json",
                    type: AttachmentType.APP_SUMMARY
                });
            }
        }

        if (events?.items?.length > 0) {
            // Cap + distil to the most recent MAX_EVENTS (kubectl-style signal only), so events -
            // previously the one unbounded context source - can't blow up the prompt on a busy resource.
            attachments.push({
                content: json(summariseEvents(events.items, MAX_EVENTS), MAX_EVENTS_CHARS, "the events"),
                mimeType: "application/json",
                type: AttachmentType.EVENTS
            });
        }

        const cachedLogs = storageRef.current?.logs;
        if (cachedLogs) {
            // Already distilled and capped when it was fetched (service/logs.ts summariseLogs).
            attachments.push({
                content: cachedLogs,
                mimeType: "text/plain",
                type: AttachmentType.LOG
            });
        }

        return {
            application,
            attachments,
            settings: globalThis.argocdAssistantSettings ?? settings,
            mcpToken: storageRef.current?.mcpToken ?? undefined
        };
    }, [application, resource, events, settings, appSummary]);

    const welcomeMessage =
        "How can I help you with the resource **" +
        resource_name +
        "** of type " +
        resource_kind +
        "?" +
        (hasLogs(resource)
            ? " I notice this resource has logs available, to attach one or more container logs type *Attach* at any time."
            : "");

    // Starter prompts tailored to the resource, surfaced only on a fresh conversation. For an
    // Application they target the Helm/GitOps review flow the summary context now grounds.
    const suggestions: string[] =
        resource_kind === "Application"
            ? [
                "Is this application synced and healthy?",
                "What Helm chart and version is deployed?",
                "Summarise the most recent sync",
                "Any out-of-sync or degraded resources?"
            ]
            : hasLogs(resource)
                ? [
                    "Why might this resource be unhealthy?",
                    "Summarise the recent events",
                    "Is the owning Argo CD application healthy?"
                ]
                : [
                    "Explain what this resource does",
                    "Summarise the recent events",
                    "Is the owning Argo CD application healthy?"
                ];

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
            const container = form.container;
            if (!container) {
                setFlowError("Select a container first.");
                return;
            }
            const lines = Number(form.lines);
            if (isNaN(lines)) {
                setFlowError("The number of lines needs to be a valid number.");
                return;
            }
            // Reject zero, negatives, and fractional counts: any of these produce an invalid tailLines
            // for the logs API (a negative count also makes getLogs' read loop return nothing silently).
            if (lines < 1 || lines > maxLogLines || !Number.isInteger(lines)) {
                setFlowError(
                    "The number of lines needs to be more than 0 and " + maxLogLines + " or less"
                );
                return;
            }
            setFlowError(null);
            setFlowNode("get_logs");
            getLogs(application, resource, container, lines)
                .then((result: LogEntry[]) => {
                    // Store the distilled text, not the raw stream envelopes: this string is
                    // re-sent verbatim with every subsequent question, so its size is paid for
                    // on every request.
                    storageRef.current!.logs = summariseLogs(result, container);
                    // Session storage can be full or unavailable, in which case the write is dropped
                    // - say so rather than claiming an attachment that will not be sent.
                    const attached = storageRef.current!.logs !== null;
                    setMessages(injectMessage(attached
                        ? `Attached ${result.length} log line${result.length === 1 ? "" : "s"} from **${container}**.`
                        : "The logs could not be stored for this session, so they will not be attached. Session storage may be full or disabled."));
                    setFlowNode("loop");
                })
                .catch((error) => {
                    setMessages(
                        injectMessage(
                            "Could not fetch the logs: " +
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
        // Guard against a transient undefined resource so the effect never throws before fetch
        // (the sibling mount effect already skips via getResourceIdentifier === "Undefined").
        if (!resource?.metadata) return;
        // Encode the path + query params (names/namespaces may contain characters that need
        // escaping) and send the same-origin auth/routing headers every other Argo CD call uses
        // (argocdApiHeaders + credentials:'include', matching service/application.ts and
        // service/logs.ts), so a project-scoped proxy authorises this request rather than
        // silently rejecting it.
        let url = `/api/v1/applications/${encodeURIComponent(application_name)}/events`;
        if (resource.kind !== "Application") {
            const params = new URLSearchParams();
            params.set("resourceUID", resource.metadata.uid ?? "");
            params.set("resourceNamespace", resource.metadata.namespace ?? "");
            params.set("resourceName", resource.metadata.name ?? "");
            url += `?${params.toString()}`;
        }
        fetch(url, { credentials: "include", headers: argocdApiHeaders(application) })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Events API returned ${response.status} ${response.statusText}`);
                }
                return response.json();
            })
            .then((data) => {
                if (!cancelled) {
                    setEvents({ apiVersion: "v1", items: data?.items ?? [] });
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    console.error("Failed to fetch events:", err);
                }
            });
        return () => { cancelled = true; };
        // Keyed on the stable resource identity, not the `application`/`resource` object identities:
        // the Argo CD host hands down fresh objects as it polls, which re-ran this effect (and so
        // re-fetched, after blanking the events) on every poll. This matches both the sibling
        // app-summary effect below and the documented "cached, not continuously updated" behaviour.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resourceID, application_name]);

    // Fetch the owning Application's distilled summary (chart/source, sync, health, resource
    // rollup) once per application, mirroring the events effect's cancellation guard. Keyed on the
    // stable app name (not the object identity) so a snapshot is fetched once and not re-fetched on
    // every host re-render. getApplicationSummary never rejects (it falls back to props internally),
    // so a failure just yields null.
    React.useEffect(() => {
        let cancelled = false;
        setAppSummary(null);
        if (!application_name) return;
        getApplicationSummary(application).then((summary) => {
            if (!cancelled) setAppSummary(summary);
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [application_name]);

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
                                ref={linesInputRef}
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
                case "get_logs":
                    // Fetching a container log takes a visible moment; without this the flow UI
                    // vanished on submit and left the user with no sign anything was happening.
                    return (
                        <div className="chat-flow-ui" role="status">
                            <span className="chat-typing" aria-hidden="true"><span /><span /><span /></span>
                            <span className="chat-tool-status">Fetching logs from {form.container}…</span>
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
            suggestions={suggestions}
        >
            {(helpers) => flowUI(helpers.setMessages)}
        </ChatInterface>
    );
};
