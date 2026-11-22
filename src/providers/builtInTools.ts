// Tools the extension answers itself, in the browser, through the Argo CD API and the user's own
// session, so argocd-server applies the user's RBAC. Each reads only the Application the user has
// open. Each description is the tool's skill: what it returns, when to call it and what to pass.
// See docs/architecture.md#built-in-tools.

import { capText } from "../util/context";
import { errorMessage } from "../util/util";
import { getApplication } from "../service/application";
import { getManagedResourceByRef, summariseDrift } from "../service/drift";
import { getEvents, summariseEvents } from "../service/events";
import { DEFAULT_HISTORY, getChangeHistory, MAX_HISTORY } from "../service/history";
import { FILTER_WINDOW_LINES, getLogs, MAX_LINES, summariseLogs } from "../service/logs";
import { getResourceTree } from "../service/pods";
import { findNodes, getLiveResource, kindRoster, logSources, nodeAsResource, nodeLabel, redactManifest, workloadRoster } from "../service/resource";
import type { McpTool } from "./mcpClient";

/** The serverIndex of a built-in tool, which no MCP server can have. */
export const BUILT_IN_SERVER = -1;

export const isBuiltIn = (tool: Pick<McpTool, "serverIndex">): boolean => tool.serverIndex === BUILT_IN_SERVER;

/** Log lines returned when the model does not ask for a number. */
const DEFAULT_LOG_LINES = 100;

/** Events of a looked-up resource, which carry probe, scheduling and admission messages. */
const MAX_RESOURCE_EVENTS = 10;

export interface ToolContext {
    /** The Application the user has open, which authorises every request. */
    application: any;
    signal?: AbortSignal;
    /** The size the result is cut to, so a tool can keep its most useful part. */
    maxChars: number;
    /** The clock and time zone, which tests replace. */
    now?: () => Date;
    timeZone?: string;
}

const str = (description: string) => ({ type: "string", description });

export const BUILT_IN_TOOLS: McpTool[] = [
    {
        name: "get_current_datetime",
        serverIndex: BUILT_IN_SERVER,
        description: "Returns the current date and time in UTC and in the user's time zone, from the user's browser. Call it before saying how long ago something happened or whether it happened recently, because attachments and tool results carry absolute timestamps only.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "get_resource",
        serverIndex: BUILT_IN_SERVER,
        description: "Returns the live manifest and recent Kubernetes events of one resource in this Argo CD Application, such as a ConfigMap a Deployment mounts, the Service behind an Ingress or one pod of a workload. Call it when the answer depends on a resource the user did not open. Take the kind and name from the attached context or an earlier result, and do not guess them: when nothing matches, the result lists the resources of that kind. Secret values are hidden.",
        inputSchema: {
            type: "object",
            properties: {
                kind: str("Kubernetes kind, such as Deployment, ConfigMap, Service or Pod."),
                name: str("The resource's name."),
                namespace: str("The resource's namespace. Needed only when two resources share the kind and name."),
            },
            required: ["kind", "name"],
        },
    },
    {
        name: "get_logs",
        serverIndex: BUILT_IN_SERVER,
        description: `Returns recent log lines from a pod, or from every pod of a workload such as a Deployment, StatefulSet, DaemonSet or Job, in this Argo CD Application. Call it for a pod that is crashing, restarting, not ready or reporting errors, including one the user did not open. Set previous to true to read the instance before the last restart. Set filter to search the last ${FILTER_WINDOW_LINES} lines of each pod for one string, such as an error message, instead of reading every line.`,
        inputSchema: {
            type: "object",
            properties: {
                name: str("Name of a pod, or of a workload that owns pods."),
                container: str("Container name. Needed only when the pod runs more than one container."),
                previous: { type: "boolean", description: "Read the container instance before the last restart." },
                lines: { type: "integer", minimum: 1, maximum: MAX_LINES, description: `Newest lines to return, up to ${MAX_LINES}. Defaults to ${DEFAULT_LOG_LINES}.` },
                filter: str("Return only lines that contain this text, ignoring case."),
            },
            required: ["name"],
        },
    },
    {
        name: "get_change_history",
        serverIndex: BUILT_IN_SERVER,
        description: "Returns this Argo CD Application's recent deployments, newest first, with each revision's commit author, date and message, or the Helm chart's details, and the result of every resource in the last sync, hooks included. Call it when a problem may have started with a deployment, when the user asks what changed, or when the last sync failed.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY, description: `Deployments to return, up to ${MAX_HISTORY}. Defaults to ${DEFAULT_HISTORY}.` },
            },
        },
    },
    {
        name: "get_resource_diff",
        serverIndex: BUILT_IN_SERVER,
        description: "Returns the fields where a resource's live state differs from the target state in this Argo CD Application's source. Call it for an OutOfSync resource the user did not open, such as one listed under outOfSync in the Argo CD Application summary. The OutOfSync fields attachment already covers the open resource. Secret values are not shown.",
        inputSchema: {
            type: "object",
            properties: {
                kind: str("Kubernetes kind, such as Deployment or ConfigMap."),
                name: str("The resource's name."),
                namespace: str("The resource's namespace. Needed only when two resources share the kind and name."),
            },
            required: ["kind", "name"],
        },
    },
];

const BUILT_IN_NAMES = new Set(BUILT_IN_TOOLS.map((t) => t.name));

/** True when an MCP tool would share a built-in tool's name, which the built-in tool keeps. */
export const isBuiltInName = (toolName: string): boolean => BUILT_IN_NAMES.has(toolName);

// Arguments arrive as JSON from native calls and as strings from the text protocol.
const text = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
const flag = (v: unknown): boolean => v === true || v === "true";
function whole(v: unknown, fallback: number, min: number, max: number): number {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

/** The current time in UTC and in the user's time zone. */
export function currentTime(now: Date, timeZone?: string): string {
    let zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    let local: string;
    try {
        local = new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "full", timeStyle: "long" }).format(now);
    } catch (_e) {
        zone = "UTC";
        local = new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "full", timeStyle: "long" }).format(now);
    }
    return `Current time: ${now.toISOString().slice(0, 19)}Z (UTC). The user's time zone is ${zone}, where it is ${local}.`;
}

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

async function getResourceTool(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const kind = text(args.kind), resource = text(args.name), namespace = text(args.namespace);
    if (!kind || !resource) return "Not run: kind and name are both required.";

    const tree = await getResourceTree(ctx.application, ctx.signal);
    const matches = findNodes(tree, kind, resource, namespace);
    if (matches.length === 0) {
        return `This Application does not have a ${kind} named ${resource}${namespace ? ` in ${namespace}` : ""}. ${kindRoster(tree, kind)}`;
    }
    if (matches.length > 1) {
        return `Several resources match: ${matches.map(nodeLabel).join(", ")}. Call get_resource again with the namespace.`;
    }

    const node = matches[0];
    const [manifest, events] = await Promise.all([
        getLiveResource(ctx.application, node, ctx.signal),
        // Missing events should not hide the manifest.
        getEvents(ctx.application, node, "Events", ctx.signal).catch((err) => {
            if (isAbort(err)) throw err;
            return errorMessage(err);
        }),
    ]);

    const eventsText = typeof events === "string"
        ? `Events could not be fetched (${events}).`
        : events.length
            ? `Events, most recent first:\n${capText(JSON.stringify(summariseEvents(events, MAX_RESOURCE_EVENTS)), Math.floor(ctx.maxChars / 3), "the events")}`
            : "It does not have any events.";
    const head = `Live manifest of ${nodeLabel(node)}:\n`;
    const room = Math.max(1000, ctx.maxChars - head.length - eventsText.length - 100);
    return `${head}${capText(JSON.stringify(redactManifest(manifest)), room, "the manifest")}\n\n${eventsText}`;
}

async function getLogsTool(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const resource = text(args.name);
    if (!resource) return "Not run: name is required.";
    const container = text(args.container);
    const previous = flag(args.previous);
    const lines = whole(args.lines, DEFAULT_LOG_LINES, 1, MAX_LINES);
    const filter = text(args.filter);

    const tree = await getResourceTree(ctx.application, ctx.signal);
    const sources = logSources(tree, resource);
    if (sources.length === 0) return `This Application does not have a pod or workload named ${resource}. ${workloadRoster(tree)}`;
    if (sources.length > 1) return `Several resources named ${resource} own pods: ${sources.map(nodeLabel).join(", ")}.`;

    const node = sources[0];
    const entries = await getLogs(ctx.application, nodeAsResource(node), container ?? "", lines, ctx.signal, previous, filter);
    const head = [
        `Logs of ${nodeLabel(node)}`,
        filter && `, only lines containing "${filter}" (ignoring case) among the last ${Math.max(lines, FILTER_WINDOW_LINES)} of each pod`,
        ":\n",
    ].filter(Boolean).join("");
    return head + summariseLogs(entries, container, previous, Math.max(1000, ctx.maxChars - head.length - 300));
}

async function getChangeHistoryTool(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const limit = whole(args.limit, DEFAULT_HISTORY, 1, MAX_HISTORY);
    const app = await getApplication(ctx.application, ctx.signal);
    const history = await getChangeHistory(app, limit, ctx.signal);
    if (!(history.deployments as unknown[]).length && !history.lastOperation) {
        return "Argo CD does not have any deployment history or sync operation for this Application.";
    }
    return capText(JSON.stringify(history), ctx.maxChars, "the change history");
}

async function getResourceDiffTool(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const kind = text(args.kind), resource = text(args.name), namespace = text(args.namespace);
    if (!kind || !resource) return "Not run: kind and name are both required.";

    // The current sync status of every managed resource, which also names the resource's group.
    const app = await getApplication(ctx.application, ctx.signal);
    const managed: any[] = Array.isArray(app?.status?.resources) ? app.status.resources : [];
    const wanted = kind.toLowerCase();
    const matches = managed.filter((r) =>
        String(r?.kind ?? "").toLowerCase() === wanted &&
        r?.name === resource &&
        (!namespace || (r?.namespace ?? "") === namespace));

    if (matches.length === 0) {
        const outOfSync = managed.filter((r) => r?.status === "OutOfSync").map(nodeLabel);
        return `Argo CD does not manage a ${kind} named ${resource}${namespace ? ` in ${namespace}` : ""} in this Application. ${outOfSync.length ? `Its OutOfSync resources are ${outOfSync.join(", ")}.` : "None of its resources is OutOfSync."}`;
    }
    if (matches.length > 1) {
        return `Several resources match: ${matches.map(nodeLabel).join(", ")}. Call get_resource_diff again with the namespace.`;
    }

    const r = matches[0];
    if (r.status !== "OutOfSync") return `Argo CD reports ${nodeLabel(r)} as ${r.status ?? "Unknown"}, so it does not have any OutOfSync fields.`;
    const item = await getManagedResourceByRef(ctx.application, {
        kind: r.kind,
        group: r.group ?? "",
        name: r.name,
        namespace: r.namespace ?? "",
    }, ctx.signal);
    return `${nodeLabel(r)}: ${capText(summariseDrift(item, r.kind), ctx.maxChars, "the OutOfSync fields")}`;
}

/**
 * Runs one built-in tool and returns its result text. Bad arguments and unknown names come back as
 * text for the model, and an API failure throws, which the chat shows as a failed tool.
 */
export async function runBuiltInTool(toolName: string, args: Record<string, any> | undefined, ctx: ToolContext): Promise<string> {
    const a = args && typeof args === "object" ? args : {};
    switch (toolName) {
        case "get_current_datetime":
            return currentTime(ctx.now?.() ?? new Date(), ctx.timeZone);
        case "get_resource":
            return getResourceTool(a, ctx);
        case "get_logs":
            return getLogsTool(a, ctx);
        case "get_change_history":
            return getChangeHistoryTool(a, ctx);
        case "get_resource_diff":
            return getResourceDiffTool(a, ctx);
        default:
            throw new Error(`${toolName} is not a built-in tool`);
    }
}
