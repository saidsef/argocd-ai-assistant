import * as React from "react";
import ChatInterface from "./components/ChatInterface";
import { getLogs, hasLogs, MAX_LINES, summariseLogs } from "./service/logs";
import { ApplicationSummary, getApplicationSummary, summariseApplication } from "./service/application";
import {
    argocdFetch,
    errorMessage,
    getContainers,
    getResourceIdentifier,
    injectMessage,
    isAttachRequest,
    isCancelRequest,
    isTokenRequest,
    mcpConfigured,
    mcpWelcomeHint,
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

// Upper bound on the configurable log-line count, whatever the settings ConfigMap asks for. Every
// attached line is also re-sent with each subsequent question, so this is a cost ceiling too.
const MAX_LOG_LINES_CEILING = 5000;

export const ResourceAssistantExtension = (props: any) => {
    const storageRef = React.useRef<ManageStorage | null>(null);
    // The stored token, so the MCP warm-up can authenticate. Null on the first render - the storage
    // is created in an effect below - which is why useAssistantSettings re-runs the warm-up when it
    // changes.
    const { settings, provider, mcpServers, getMcpStatus } = useAssistantSettings(storageRef.current?.mcpToken ?? undefined);

    const { resource, application } = props;

    const [form, setForm] = React.useState<{ container?: string; lines?: string; token?: string }>({});
    const [events, setEvents] = React.useState<Events>({ items: [] });
    const [flowNode, setFlowNode] = React.useState<FlowNode>("start");
    const [flowError, setFlowError] = React.useState<string | null>(null);
    const [appSummary, setAppSummary] = React.useState<ApplicationSummary | null>(null);
    // Why the events fetch failed, or null. This used to be a console.warn and nothing else, which
    // is the worst failure mode a troubleshooting assistant has: with no Events block in the prompt
    // the model happily answers "no events indicate a problem" about a resource whose events simply
    // did not load. Now it reaches the model, the header chip and a one-off notice.
    const [eventsError, setEventsError] = React.useState<string | null>(null);
    // Mirrors storageRef.current.logs so the header chip re-renders when a log is attached or
    // detached; sessionStorage is not reactive.
    const [logsAttached, setLogsAttached] = React.useState(false);
    const linesInputRef = React.useRef<HTMLInputElement>(null);
    // The in-flight log fetch, so Cancel / "cancel" / unmount can actually drop it. Without this the
    // request ran to its 60s deadline with no way to stop it.
    const logAbortRef = React.useRef<AbortController | null>(null);

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
    // Clamped, not trusted: the value comes from a hand-edited ConfigMap, and a 0/negative/NaN made
    // every input unsatisfiable ("needs to be more than 0 and 0 or less"). Also capped, so a typo
    // cannot ask argocd-server for a million lines.
    const configuredLogLines = Number(settings.maximumLogLines);
    const maxLogLines: number = Number.isInteger(configuredLogLines) && configuredLogLines > 0
        ? Math.min(configuredLogLines, MAX_LOG_LINES_CEILING)
        : MAX_LINES;

    const [chatKey, setChatKey] = React.useState<string | null>(null);

    // On resource change, reset storage and (re)mount ChatInterface via chatKey.
    React.useEffect(() => {
        if (resourceID === "Undefined") return;
        if (!storageRef.current || storageRef.current.namespace !== resourceID) {
            storageRef.current = new ManageStorage(ExtensionScope.Resource, resourceID);
        }
        setFlowNode("start");
        setForm({});
        // A resource visited earlier in this session may already carry an attached log.
        setLogsAttached(!!storageRef.current.logs);
        setChatKey(resourceID);
    }, [resourceID]);

    // Distilled Argo CD Application summary (the `argocd app get` review view). Fetched into state
    // asynchronously; until it lands we fall back to summarising an Application object we already
    // hold, so grounding is never empty on first paint. The fallback only ever summarises an actual
    // Application (the resource when it is one, else the owning `application` prop) - never a child
    // resource, which would yield a misleading, mostly-empty "Application" summary.
    //
    // Lifted out of getContext so the header chip reads the *same* value: derived separately, the
    // chip could claim an Application summary the prompt never carried, which is exactly the kind of
    // quiet inaccuracy the chip exists to prevent.
    const isApplication = resource?.kind === "Application";
    const summary = React.useMemo(
        () => appSummary ?? summariseApplication(isApplication ? (application ?? resource) : application),
        [appSummary, isApplication, application, resource]
    );

    const getContext = React.useCallback(() => {
        const attachments: Attachment[] = [];

        // Every attachment is capped by size as well as by item count: the distillers bound how many
        // entries go in, these bound how large a single entry can be (see util/context.ts).
        //
        // capText slices the serialised string, so an over-cap attachment is cut mid-token and is no
        // longer parseable - report it as text/plain rather than telling the model a fragment is
        // valid JSON. The truncation itself is already announced inside the text by capText.
        const json = (value: any, max: number, what: string) => {
            const full = JSON.stringify(value);
            const content = capText(full, max, what);
            return { content, mimeType: content.length === full.length ? "application/json" : "text/plain" };
        };

        if (isApplication && summary) {
            // For an Application resource the compact summary supersedes the full manifest (which
            // carries the entire resource tree/history) - large token saving, same review signal.
            attachments.push({
                ...json(summary, MAX_APP_SUMMARY_CHARS, "the application summary"),
                type: AttachmentType.APP_SUMMARY
            });
        } else if (resource) {
            attachments.push({
                ...json(stripManifestNoise(resource), MAX_MANIFEST_CHARS, "the resource manifest"),
                type: AttachmentType.MANIFEST
            });
            // Ground a child resource (Deployment, Pod, ...) in its owning Application's GitOps state.
            if (summary) {
                attachments.push({
                    ...json(summary, MAX_APP_SUMMARY_CHARS, "the application summary"),
                    type: AttachmentType.APP_SUMMARY
                });
            }
        }

        // An events *failure* has to be stated, not just omitted. Silence is indistinguishable from
        // "this resource has no events", and the model reasonably answers that nothing is wrong.
        // Reuses the EVENTS attachment slot, so there is no new attachment type to label.
        if (eventsError) {
            attachments.push({
                content: `Kubernetes events for this resource could not be fetched from the Argo CD API (${eventsError}). No event data is available for this conversation. Do not state or imply that there are no events, or that the events show nothing wrong - say that events could not be retrieved.`,
                mimeType: "text/plain",
                type: AttachmentType.EVENTS
            });
        } else if (events?.items?.length > 0) {
            // Cap + distil to the most recent MAX_EVENTS (kubectl-style signal only), so events -
            // previously the one unbounded context source - can't blow up the prompt on a busy resource.
            attachments.push({
                ...json(summariseEvents(events.items, MAX_EVENTS), MAX_EVENTS_CHARS, "the events"),
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
    }, [application, resource, isApplication, summary, events, eventsError, settings]);

    // Memoised because getMcpStatus allocates a status object per server and re-derives every
    // handle (up to three `new URL()` each), and the Argo CD host hands down fresh resource and
    // application objects on every poll - so calling it inline re-ran all of that on every poll.
    // getMcpStatus is a stable useCallback whose identity changes only when a probe completes,
    // which is exactly when there is something new to report.
    const mcpHint = React.useMemo(
        () => mcpWelcomeHint((getMcpStatus?.() ?? []).map((s) => s.handle)),
        [getMcpStatus]
    );

    const welcomeMessage =
        "How can I help you with the resource **" +
        resource_name +
        "** of type " +
        resource_kind +
        "?" +
        (hasLogs(resource)
            ? " I notice this resource has logs available, to attach one or more container logs type *Attach* at any time."
            : "") +
        mcpHint;

    // What is actually grounding the answer, for the header chip. Each branch mirrors the matching
    // attachment branch in getContext and reads the same `summary`/`events`/`eventsError` values, so
    // the chip cannot advertise context the prompt does not carry.
    const contextStatus = React.useMemo(() => {
        const sources: string[] = [];
        if (isApplication && summary) sources.push("app");
        else if (resource) {
            sources.push("manifest");
            if (summary) sources.push("app");
        }
        if (!eventsError && events?.items?.length > 0) sources.push(`events (${events.items.length})`);
        if (logsAttached) sources.push("logs");

        const attached = sources.length ? sources.join(", ") : "nothing yet";
        return {
            label: (eventsError ? [...sources, "events unavailable"] : sources).join(" · ") || "no context",
            state: (eventsError ? "error" : "on") as "error" | "on",
            detail: eventsError
                ? `Answers are grounded in ${attached}. Kubernetes events could not be fetched (${eventsError}), so recent events are not included.`
                : `Answers are grounded in ${attached}.`,
        };
    }, [isApplication, summary, resource, events, eventsError, logsAttached]);

    // Said once, in the transcript, the first time events fail - the chip alone is easy to miss when
    // the answer reads confidently.
    const notice = React.useMemo(
        () => eventsError
            ? `I could not load Kubernetes events for this resource (${eventsError}), so my answers will not include them.`
            : null,
        [eventsError]
    );

    const handleCancel = React.useCallback(() => {
        logAbortRef.current?.abort();
        logAbortRef.current = null;
        setFlowNode("loop");
        setForm({});
        setFlowError(null);
    }, []);

    // Drop an in-flight log fetch when the slide-out closes; mirrors useChat's unmount abort.
    React.useEffect(() => () => logAbortRef.current?.abort(), []);

    // "New chat" must also detach the attached log. It is up to MAX_LOG_CHARS that the user believes
    // they discarded, and it rode along on every request for the rest of the session.
    const handleClear = React.useCallback(() => {
        storageRef.current?.clearLogs();
        setLogsAttached(false);
        handleCancel();
    }, [handleCancel]);

    const handleCommand = React.useCallback(
        (input: string, _messages: ChatMessage[], setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
            if (flowNode !== "start" && flowNode !== "loop" && flowNode !== "token_saved") {
                if (isCancelRequest(input)) {
                    // Delegated rather than repeated inline: this branch used to duplicate
                    // handleCancel's body without the abort, so typing "cancel" during a log fetch
                    // left the request running and still injected "Attached N log lines" when it landed.
                    handleCancel();
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
        [flowNode, resource, mcpServers, handleCancel]
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
            // Capture the storage instance now. storageRef is replaced whenever the user opens a
            // different resource, so resolving the ref inside the callback wrote this resource's log
            // under the *next* resource's key - and it was then attached to every question about it.
            const storage = storageRef.current!;
            // Drop any previous fetch before taking the slot, so an earlier one cannot land later and
            // announce "Attached N log lines" for a container the user has moved on from.
            logAbortRef.current?.abort();
            const controller = new AbortController();
            logAbortRef.current = controller;
            getLogs(application, resource, container, lines, controller.signal)
                .then((result: LogEntry[]) => {
                    if (storageRef.current !== storage) return; // superseded by a resource switch
                    logAbortRef.current = null;
                    // Store the distilled text, not the raw stream envelopes: this string is
                    // re-sent verbatim with every subsequent question, so its size is paid for
                    // on every request.
                    const attached = storage.setLogs(summariseLogs(result, container));
                    setLogsAttached(attached);
                    setMessages(injectMessage(attached
                        ? `Attached ${result.length} log line${result.length === 1 ? "" : "s"} from **${container}**. Start a new chat to detach them.`
                        : "The logs could not be stored for this session, so they will not be attached. Session storage may be full or disabled."));
                    setFlowNode("loop");
                })
                .catch((error) => {
                    if (storageRef.current !== storage) return;
                    logAbortRef.current = null;
                    // Cancel already returned the flow to "loop" and is not a failure to report;
                    // without this it injected "Could not fetch the logs: signal is aborted...".
                    if (error instanceof Error && error.name === "AbortError") return;
                    setMessages(injectMessage("Could not fetch the logs: " + errorMessage(error)));
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
        // An AbortController rather than a `cancelled` flag: ignoring a superseded response still
        // left the request running against argocd-server for up to its full deadline.
        const controller = new AbortController();
        // Clear the previous resource's events on switch. Clearing the error is required, not
        // cosmetic: without it a failure follows the user to every resource they open next.
        setEvents({ items: [] });
        setEventsError(null);
        // Guard against a transient undefined resource so the effect never throws before fetch
        // (the sibling mount effect already skips via getResourceIdentifier === "Undefined").
        if (!resource?.metadata) return;
        // Encode the path + query params (names/namespaces may contain characters that need
        // escaping). appNamespace names which Application is meant on an "applications in any
        // namespace" install - service/application.ts and service/logs.ts both send it, and omitting
        // it here resolved against the wrong app (or 404'd) for an Application outside the default
        // controller namespace.
        const params = new URLSearchParams();
        if (application?.metadata?.namespace) params.set("appNamespace", application.metadata.namespace);
        if (resource.kind !== "Application") {
            params.set("resourceUID", resource.metadata.uid ?? "");
            params.set("resourceNamespace", resource.metadata.namespace ?? "");
            params.set("resourceName", resource.metadata.name ?? "");
        }
        const qs = params.toString();
        const url = `/api/v1/applications/${encodeURIComponent(application_name)}/events${qs ? `?${qs}` : ""}`;
        argocdFetch(url, application, "Events", { signal: controller.signal })
            .then((response) => response.json())
            .then((data) => setEvents({ items: data?.items ?? [] }))
            .catch((err) => {
                // A resource switch or unmount is not a failure.
                if (err instanceof Error && err.name === "AbortError") return;
                // Non-fatal for the assistant, but the user and the model both have to be told -
                // see the eventsError branch in getContext.
                console.warn("Failed to fetch events, answering without them:", err);
                setEventsError(errorMessage(err));
            });
        return () => controller.abort();
        // Keyed on the stable resource identity, not the `application`/`resource` object identities:
        // the Argo CD host hands down fresh objects as it polls, which re-ran this effect (and so
        // re-fetched, after blanking the events) on every poll. This matches both the sibling
        // app-summary effect below and the documented "cached, not continuously updated" behaviour.
    }, [resourceID, application_name]);

    // Fetch the owning Application's distilled summary (chart/source, sync, health, resource
    // rollup) once per application, mirroring the events effect's cancellation guard. Keyed on the
    // stable app name (not the object identity) so a snapshot is fetched once and not re-fetched on
    // every host re-render. getApplicationSummary never rejects (it falls back to props internally),
    // so a failure just yields null.
    React.useEffect(() => {
        const controller = new AbortController();
        setAppSummary(null);
        if (!application_name) return;
        // getApplicationSummary deliberately never rejects (it falls back to the props object), so a
        // guard is still needed here - but the signal is what actually drops the in-flight request.
        getApplicationSummary(application, controller.signal).then((summary) => {
            if (!controller.signal.aborted) setAppSummary(summary);
        });
        return () => controller.abort();
        // Keyed on the stable app name, not the object identity - see the events effect above.
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
                                    type="button"
                                    onClick={() => handleContainerSelect(c)}
                                    className="chat-flow-button"
                                    aria-label={`Select container ${c}`}
                                >
                                    {c}
                                </button>
                            ))}
                            <button type="button" onClick={handleCancel} className="chat-flow-button-cancel">
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
                                type="button"
                                onClick={() => handleLinesSubmit(setMessages)}
                                className="chat-flow-button"
                            >
                                OK
                            </button>
                            <button type="button" onClick={handleCancel} className="chat-flow-button-cancel">
                                Cancel
                            </button>
                            {flowError && <span className="chat-flow-error" role="alert">{flowError}</span>}
                        </div>
                    );
                case "get_logs":
                    // Fetching a container log takes a visible moment; without this the flow UI
                    // vanished on submit and left the user with no sign anything was happening.
                    // Cancel is here because the fetch has a 60s deadline: this was the only node in
                    // the flow with no way out.
                    return (
                        <div className="chat-flow-ui" role="status">
                            <span className="chat-typing" aria-hidden="true"><span /><span /><span /></span>
                            <span className="chat-tool-status">Fetching logs from {form.container}…</span>
                            <button type="button" onClick={handleCancel} className="chat-flow-button-cancel">
                                Cancel
                            </button>
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
            onClear={handleClear}
            getMcpStatus={getMcpStatus}
            contextStatus={contextStatus}
            notice={notice}
        >
            {(helpers) => flowUI(helpers.setMessages)}
        </ChatInterface>
    );
};
