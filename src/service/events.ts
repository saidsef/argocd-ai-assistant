// A compact view of a resource's Kubernetes events, like `kubectl get events`. Each event keeps what
// happened, how often, over what window, to which container and who reported it.

import { capText } from "../util/context";
import { argocdFetch } from "../util/util";

export const MAX_EVENTS = 20;

/**
 * An event `message` is free text without a length limit, and a failed admission webhook can return
 * kilobytes. Each message is capped so that one event cannot crowd out the rest.
 */
const MAX_MESSAGE_CHARS = 1000;

interface EventSummary {
    type?: string;
    reason?: string;
    message?: string;
    count?: number;
    first?: string;
    last?: string;
    object?: string;
    container?: string;
    component?: string;
    host?: string;
}

interface EventsSummary {
    total: number;
    items: EventSummary[];
}

/**
 * Best-effort recency key. Argo CD returns core/v1 Events with RFC3339 timestamps, which sort
 * chronologically as plain strings without parsing. It falls back through the timestamp fields an
 * Event may carry.
 */
function recencyKey(e: any): string {
    return e?.lastTimestamp || e?.eventTime || e?.metadata?.creationTimestamp || e?.firstTimestamp || "";
}

/**
 * The container an event concerns, which tells apart the "Container created" events of a
 * multi-container pod.
 */
function containerOf(obj: any): string | undefined {
    const match = /\{([^}]+)\}/.exec(typeof obj?.fieldPath === "string" ? obj.fieldPath : "");
    return match?.[1] || undefined;
}

/**
 * Kubernetes events distilled into a compact summary, newest first. It tolerates missing fields and
 * a non-array input, and never throws.
 */
export function summariseEvents(items: any[], max: number = MAX_EVENTS): EventsSummary {
    const all = Array.isArray(items) ? items : [];
    // Copy before sorting so the caller's array is not mutated; newest first.
    const recent = [...all]
        .sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
        .slice(0, Math.max(0, max));

    const summary: EventSummary[] = recent.map((e) => {
        const obj = e?.involvedObject;
        const object = obj?.kind && obj?.name ? `${obj.kind}/${obj.name}` : (obj?.name || obj?.kind || undefined);
        const last = recencyKey(e) || undefined;
        const first: string | undefined = e?.firstTimestamp || undefined;
        return {
            type: e?.type,
            reason: e?.reason,
            message: capText(e?.message ?? "", MAX_MESSAGE_CHARS, "event message") || undefined,
            count: typeof e?.count === "number" ? e.count : undefined,
            // Differs from `last` only on a repeated event, where the pair turns `count` into a rate.
            first: first && first !== last ? first : undefined,
            last,
            object,
            container: containerOf(obj),
            // events.k8s.io-originated events leave `source` empty and carry the reporting* pair.
            component: e?.source?.component || e?.reportingComponent || undefined,
            host: e?.source?.host || e?.reportingInstance || undefined,
        };
    });

    return { total: all.length, items: summary };
}

/** The events of one resource in the Application's tree, identified by its UID, namespace and name. */
export async function getEvents(
    application: any,
    ref: { uid?: string; namespace?: string; name: string },
    what: string,
    signal?: AbortSignal
): Promise<any[]> {
    const params = new URLSearchParams();
    if (application?.metadata?.namespace) params.set("appNamespace", application.metadata.namespace);
    params.set("resourceUID", ref.uid ?? "");
    params.set("resourceNamespace", ref.namespace ?? "");
    params.set("resourceName", ref.name);
    const url = `/api/v1/applications/${encodeURIComponent(application?.metadata?.name ?? "")}/events?${params.toString()}`;
    const response = await argocdFetch(url, application, what, { signal });
    // Argo CD returns `items: null` when there are no events.
    return (await response.json())?.items ?? [];
}
