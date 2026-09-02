// Curated, token-efficient view of a resource's Kubernetes events - the essence of
// `kubectl get events`. Dumping raw core/v1 Events wastes tokens on managedFields, a full
// involvedObject ref and several overlapping timestamps, and buries the signal a reviewer wants:
// what happened, how often, over what window, to which container, reported by what. This distils
// each event to that signal and caps the list to the most recent `max`.

import { capText } from "../util/context";

export const MAX_EVENTS = 20;

// An event `message` is free text with no length limit (a failed admission webhook can return
// kilobytes), so cap the longest ones individually rather than letting one event crowd out the rest.
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

// Best-effort recency key. Argo CD returns core/v1 Events whose timestamps are RFC3339 strings,
// which sort lexicographically in chronological order, so a plain string compare orders them
// correctly without parsing. Falls back through the timestamp fields an Event may carry.
function recencyKey(e: any): string {
    return e?.lastTimestamp || e?.eventTime || e?.metadata?.creationTimestamp || e?.firstTimestamp || "";
}

// Without this a multi-container pod yields several indistinguishable "Container created" events.
function containerOf(obj: any): string | undefined {
    const match = /\{([^}]+)\}/.exec(typeof obj?.fieldPath === "string" ? obj.fieldPath : "");
    return match?.[1] || undefined;
}

// Distil a list of Kubernetes events into a compact, most-recent-first summary. Pure and defensive:
// tolerates missing fields and a non-array input, and never throws.
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
