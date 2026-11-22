// Tools the extension answers itself, in the browser, through the Argo CD API and the user's own
// session, so argocd-server applies the user's RBAC. In the resource tab each reads the Application
// the user has open, and on the /assistant page each names the Application it reads. Each
// description is the tool's skill: what it returns, when to call it and what to pass.
// See docs/architecture.md#built-in-tools.

import type { BuiltInScope } from "../model/provider";
import { capText } from "../util/context";
import { errorMessage } from "../util/util";
import { getApplication, listApplications } from "../service/application";
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
    /** The open Application in the resource tab. On the /assistant page, the one that routes the proxy. */
    application: any;
    scope: BuiltInScope;
    signal?: AbortSignal;
    /** The size the result is cut to, so a tool can keep its most useful part. */
    maxChars: number;
    /** The clock and time zone, which tests replace. */
    now?: () => Date;
    timeZone?: string;
}

const str = (description: string) => ({ type: "string", description });
const noArguments = { type: "object", properties: {} };

/** One scope's tools. Only the /assistant page asks for an Application, because it has none open. */
function definitions(scope: BuiltInScope): McpTool[] {
    const any = scope === "any-application";
    const app = any ? "the named Argo CD Application" : "this Argo CD Application";
    const named = (schema: any) => any
        ? {
            ...schema,
            properties: { application: str("The Argo CD Application, as name or namespace/name. Take it from the conversation or from list_applications."), ...schema.properties },
            required: ["application", ...(schema.required ?? [])],
        }
        : schema;
    const tool = (name: string, description: string, inputSchema: any): McpTool => ({ name, serverIndex: BUILT_IN_SERVER, description, inputSchema });
    const resourceRef = (kinds: string) => named({
        type: "object",
        properties: {
            kind: str(`Kubernetes kind, such as ${kinds}.`),
            name: str("The resource's name."),
            namespace: str("The resource's namespace. Needed only when two resources share the kind and name."),
        },
        required: ["kind", "name"],
    });

    return [
        tool("get_current_datetime",
            "Returns the current date and time in UTC and in the user's time zone, from the user's browser. Call it before saying how long ago something happened or whether it happened recently, because attachments and tool results carry absolute timestamps only.",
            noArguments),
        ...(any ? [tool("list_applications",
            "Returns every Argo CD Application the user can read, with its project, sync status and health, OutOfSync or unhealthy ones first. Call it when the user asks about Applications in general, such as which are degraded or OutOfSync, and to find the exact name another tool needs.",
            noArguments)] : []),
        tool("get_resource",
            `Returns the live manifest and recent Kubernetes events of one resource in ${app}, such as a ConfigMap a Deployment mounts, the Service behind an Ingress or one pod of a workload. ${any ? "Call it when the answer depends on a resource's live state or events." : "Call it when the answer depends on a resource the user did not open."} Take the kind and name from the conversation or an earlier result, and do not guess them: when nothing matches, the result lists the resources of that kind. Secret values are hidden.`,
            resourceRef("Deployment, ConfigMap, Service or Pod")),
        tool("get_logs",
            `Returns recent log lines from a pod, or from every pod of a workload such as a Deployment, StatefulSet, DaemonSet or Job, in ${app}. Call it for a pod that is crashing, restarting, not ready or reporting errors${any ? "" : ", including one the user did not open"}. Set previous to true to read the instance before the last restart. Set filter to search the last ${FILTER_WINDOW_LINES} lines of each pod for one string, such as an error message, instead of reading every line.`,
            named({
                type: "object",
                properties: {
                    name: str("Name of a pod, or of a workload that owns pods."),
                    container: str("Container name. Needed only when the pod runs more than one container."),
                    previous: { type: "boolean", description: "Read the container instance before the last restart." },
                    lines: { type: "integer", minimum: 1, maximum: MAX_LINES, description: `Newest lines to return, up to ${MAX_LINES}. Defaults to ${DEFAULT_LOG_LINES}.` },
                    filter: str("Return only lines that contain this text, ignoring case."),
                },
                required: ["name"],
            })),
        tool("get_change_history",
            `Returns ${any ? "an Argo CD Application's" : "this Argo CD Application's"} recent deployments, newest first, with each revision's commit author, date and message, or the Helm chart's details, and the result of every resource in the last sync, hooks included. Call it when a problem may have started with a deployment, when the user asks what changed, or when the last sync failed.`,
            named({
                type: "object",
                properties: {
                    limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY, description: `Deployments to return, up to ${MAX_HISTORY}. Defaults to ${DEFAULT_HISTORY}.` },
                },
            })),
        tool("get_resource_diff",
            any
                ? "Returns the fields where a resource's live state differs from the target state in the named Argo CD Application's source. Call it for a resource of an OutOfSync Application. When the kind and name match nothing, the result lists the Application's OutOfSync resources. Secret values are not shown."
                : "Returns the fields where a resource's live state differs from the target state in this Argo CD Application's source. Call it for an OutOfSync resource the user did not open, such as one listed under outOfSync in the Argo CD Application summary. The OutOfSync fields attachment already covers the open resource. Secret values are not shown.",
            resourceRef("Deployment or ConfigMap")),
    ];
}

const DEFINITIONS: Record<BuiltInScope, McpTool[]> = {
    "open-application": definitions("open-application"),
    "any-application": definitions("any-application"),
};

/** One scope's tools, in the order they are offered. */
export const builtInToolsOf = (scope: BuiltInScope): McpTool[] => DEFINITIONS[scope];

/** The built-in tools a query offers. The resource tab offers none until its Application resolves. */
export function builtInTools(context: { builtInTools?: BuiltInScope; application?: any }): McpTool[] {
    if (context.builtInTools === "any-application") return DEFINITIONS["any-application"];
    if (context.builtInTools === "open-application" && context.application?.metadata?.name) return DEFINITIONS["open-application"];
    return [];
}

const BUILT_IN_NAMES = new Set(Object.values(DEFINITIONS).flat().map((t) => t.name));

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

const appLabel = (a: any): string => `${a?.metadata?.namespace ? `${a.metadata.namespace}/` : ""}${a?.metadata?.name ?? ""}`;

/** The Application a call reads. `fresh` is set when resolving it already fetched the current object. */
interface Target {
    app: any;
    fresh?: any;
}

/**
 * The open Application, or the one a call names on the /assistant page. Text is the reason the call
 * cannot run, for the model to act on.
 */
async function target(args: Record<string, any>, ctx: ToolContext): Promise<Target | string> {
    if (ctx.scope === "open-application") return { app: ctx.application };
    const ref = text(args.application);
    if (!ref) return "Not run: application is required. Call list_applications for the names.";
    const slash = ref.indexOf("/");
    const metadata = slash > 0 ? { namespace: ref.slice(0, slash), name: ref.slice(slash + 1) } : { name: ref };
    try {
        const fresh = await getApplication({ metadata }, ctx.signal);
        return { app: fresh, fresh };
    } catch (err) {
        if (isAbort(err)) throw err;
        // Argo CD answers 403 for an Application that does not exist, as for one the user cannot read.
        if (/API returned 40[34]\b/.test(errorMessage(err))) {
            return `The user cannot read an Argo CD Application named ${ref}, or it does not exist. Call list_applications for the names.`;
        }
        throw err;
    }
}

async function listApplicationsTool(ctx: ToolContext): Promise<string> {
    const apps = await listApplications(ctx.signal);
    if (apps.length === 0) return "The user cannot read any Argo CD Application.";
    const sync = (a: any): string => a?.status?.sync?.status ?? "Unknown";
    const health = (a: any): string => a?.status?.health?.status ?? "Unknown";
    const attention = (a: any): boolean => sync(a) !== "Synced" || health(a) !== "Healthy";
    const sorted = [...apps].sort((a, b) => Number(attention(b)) - Number(attention(a)) || appLabel(a).localeCompare(appLabel(b)));
    const lines = sorted.map((a) => `- ${appLabel(a)} (project ${a?.spec?.project ?? "unknown"}): ${sync(a)}, ${health(a)}`);
    const flagged = apps.filter(attention).length;
    return capText(`${apps.length} Applications, ${flagged} of them OutOfSync or not Healthy, listed first:\n${lines.join("\n")}`, ctx.maxChars, "the Application list");
}

async function getResourceTool(args: Record<string, any>, ctx: ToolContext, t: Target): Promise<string> {
    const kind = text(args.kind), resource = text(args.name), namespace = text(args.namespace);
    if (!kind || !resource) return "Not run: kind and name are both required.";

    const tree = await getResourceTree(t.app, ctx.signal);
    const matches = findNodes(tree, kind, resource, namespace);
    if (matches.length === 0) {
        return `${appLabel(t.app)} does not have a ${kind} named ${resource}${namespace ? ` in ${namespace}` : ""}. ${kindRoster(tree, kind)}`;
    }
    if (matches.length > 1) {
        return `Several resources match: ${matches.map(nodeLabel).join(", ")}. Call get_resource again with the namespace.`;
    }

    const node = matches[0];
    const [manifest, events] = await Promise.all([
        getLiveResource(t.app, node, ctx.signal),
        // Missing events should not hide the manifest.
        getEvents(t.app, node, "Events", ctx.signal).catch((err) => {
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

async function getLogsTool(args: Record<string, any>, ctx: ToolContext, t: Target): Promise<string> {
    const resource = text(args.name);
    if (!resource) return "Not run: name is required.";
    const container = text(args.container);
    const previous = flag(args.previous);
    const lines = whole(args.lines, DEFAULT_LOG_LINES, 1, MAX_LINES);
    const filter = text(args.filter);

    const tree = await getResourceTree(t.app, ctx.signal);
    const sources = logSources(tree, resource);
    if (sources.length === 0) return `${appLabel(t.app)} does not have a pod or workload named ${resource}. ${workloadRoster(tree)}`;
    if (sources.length > 1) return `Several resources named ${resource} own pods: ${sources.map(nodeLabel).join(", ")}.`;

    const node = sources[0];
    const entries = await getLogs(t.app, nodeAsResource(node), container ?? "", lines, ctx.signal, previous, filter);
    const head = [
        `Logs of ${nodeLabel(node)}`,
        filter && `, only lines containing "${filter}" (ignoring case) among the last ${Math.max(lines, FILTER_WINDOW_LINES)} of each pod`,
        ":\n",
    ].filter(Boolean).join("");
    return head + summariseLogs(entries, container, previous, Math.max(1000, ctx.maxChars - head.length - 300));
}

async function getChangeHistoryTool(args: Record<string, any>, ctx: ToolContext, t: Target): Promise<string> {
    const limit = whole(args.limit, DEFAULT_HISTORY, 1, MAX_HISTORY);
    const app = t.fresh ?? await getApplication(t.app, ctx.signal);
    const history = await getChangeHistory(app, limit, ctx.signal);
    if (!(history.deployments as unknown[]).length && !history.lastOperation) {
        return `Argo CD does not have any deployment history or sync operation for ${appLabel(app)}.`;
    }
    return capText(JSON.stringify(history), ctx.maxChars, "the change history");
}

async function getResourceDiffTool(args: Record<string, any>, ctx: ToolContext, t: Target): Promise<string> {
    const kind = text(args.kind), resource = text(args.name), namespace = text(args.namespace);
    if (!kind || !resource) return "Not run: kind and name are both required.";

    // The current sync status of every managed resource, which also names the resource's group.
    const app = t.fresh ?? await getApplication(t.app, ctx.signal);
    const managed: any[] = Array.isArray(app?.status?.resources) ? app.status.resources : [];
    const wanted = kind.toLowerCase();
    const matches = managed.filter((r) =>
        String(r?.kind ?? "").toLowerCase() === wanted &&
        r?.name === resource &&
        (!namespace || (r?.namespace ?? "") === namespace));

    if (matches.length === 0) {
        const outOfSync = managed.filter((r) => r?.status === "OutOfSync").map(nodeLabel);
        return `Argo CD does not manage a ${kind} named ${resource}${namespace ? ` in ${namespace}` : ""} in ${appLabel(app)}. ${outOfSync.length ? `Its OutOfSync resources are ${outOfSync.join(", ")}.` : "None of its resources is OutOfSync."}`;
    }
    if (matches.length > 1) {
        return `Several resources match: ${matches.map(nodeLabel).join(", ")}. Call get_resource_diff again with the namespace.`;
    }

    const r = matches[0];
    if (r.status !== "OutOfSync") return `Argo CD reports ${nodeLabel(r)} as ${r.status ?? "Unknown"}, so it does not have any OutOfSync fields.`;
    const item = await getManagedResourceByRef(app, {
        kind: r.kind,
        group: r.group ?? "",
        name: r.name,
        namespace: r.namespace ?? "",
    }, ctx.signal);
    return `${nodeLabel(r)}: ${capText(summariseDrift(item, r.kind), ctx.maxChars, "the OutOfSync fields")}`;
}

type AppTool = (args: Record<string, any>, ctx: ToolContext, t: Target) => Promise<string>;

const APP_TOOLS: Record<string, AppTool> = {
    get_resource: getResourceTool,
    get_logs: getLogsTool,
    get_change_history: getChangeHistoryTool,
    get_resource_diff: getResourceDiffTool,
};

/**
 * Runs one built-in tool and returns its result text. Bad arguments and unknown names come back as
 * text for the model, and an API failure throws, which the chat shows as a failed tool.
 */
export async function runBuiltInTool(toolName: string, args: Record<string, any> | undefined, ctx: ToolContext): Promise<string> {
    const a = args && typeof args === "object" ? args : {};
    if (toolName === "get_current_datetime") return currentTime(ctx.now?.() ?? new Date(), ctx.timeZone);
    if (toolName === "list_applications" && ctx.scope === "any-application") return listApplicationsTool(ctx);
    const run = APP_TOOLS[toolName];
    if (!run) throw new Error(`${toolName} is not a built-in tool`);
    const t = await target(a, ctx);
    return typeof t === "string" ? t : run(a, ctx, t);
}
