// The pods behind a workload, read from the Application's resource tree. Argo CD returns only the
// events of the selected resource and its summary lists only managed resources, so without this a
// Deployment's answer never sees the pods where most failures show.

import { capText } from "../util/context";
import { argocdFetch, Kinds } from "../util/util";
import { summariseEvents } from "./events";

// Pods listed by name. The rest are counted, so a large workload costs the same as a small one.
export const MAX_PODS = 20;

// Events of the first unhealthy pod, which carry the probe and scheduling messages.
export const MAX_POD_EVENTS = 10;

// A pod's health message is free text from the controller, so one long message cannot crowd out the list.
const MAX_HEALTH_MESSAGE_CHARS = 300;

export interface PodState {
    name: string;
    namespace?: string;
    uid?: string;
    health?: string;
    message?: string;
    reason?: string;
    containers?: string;
    restarts: number;
}

/** Whether a resource owns pods through a pod template, which is when its pods are worth attaching. */
export function hasPods(resource: any): boolean {
    if (!resource || resource.kind === Kinds.POD || resource.kind === "Application") return false;
    return !!(resource.spec?.template?.spec?.containers || resource.spec?.jobTemplate?.spec?.template?.spec?.containers);
}

const infoValue = (node: any, name: string): string | undefined =>
    (Array.isArray(node?.info) ? node.info : []).find((i: any) => i?.name === name)?.value || undefined;

/**
 * The pods that descend from `resource` in a resource tree, through any number of owners
 * (Deployment -> ReplicaSet -> Pod, CronJob -> Job -> Pod). Unhealthy pods come first.
 */
export function podsOf(tree: any, resource: any): PodState[] {
    const nodes: any[] = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const rootUid = resource?.metadata?.uid;
    if (!rootUid) return [];

    const children = new Map<string, any[]>();
    for (const node of nodes) {
        for (const parent of Array.isArray(node?.parentRefs) ? node.parentRefs : []) {
            if (!parent?.uid) continue;
            if (!children.has(parent.uid)) children.set(parent.uid, []);
            children.get(parent.uid)!.push(node);
        }
    }

    const pods: PodState[] = [];
    const seen = new Set<string>([rootUid]);
    const queue: string[] = [rootUid];
    while (queue.length) {
        for (const node of children.get(queue.shift()!) ?? []) {
            if (!node?.uid || seen.has(node.uid)) continue;
            seen.add(node.uid);
            if (node.kind === Kinds.POD) {
                pods.push({
                    name: node.name ?? "",
                    namespace: node.namespace,
                    uid: node.uid,
                    health: node.health?.status,
                    message: node.health?.message ? capText(node.health.message, MAX_HEALTH_MESSAGE_CHARS, "the health message") : undefined,
                    reason: infoValue(node, "Status Reason"),
                    containers: infoValue(node, "Containers"),
                    // Argo CD adds "Restart Count" only when it is above zero (controller/cache/info.go).
                    restarts: Number(infoValue(node, "Restart Count") ?? 0) || 0,
                });
            } else {
                queue.push(node.uid);
            }
        }
    }

    const unhealthy = (p: PodState) => (p.health && p.health !== "Healthy" ? 0 : 1);
    return pods.sort((a, b) => unhealthy(a) - unhealthy(b) || a.name.localeCompare(b.name));
}

/** The first pod that is not Healthy, whose events are worth fetching. */
export const firstUnhealthy = (pods: PodState[]): PodState | undefined =>
    pods.find((p) => p.health && p.health !== "Healthy");

/** One line per pod, capped at `max` names, plus the events of the first unhealthy pod when given. */
export function summarisePods(owner: string, pods: PodState[], podEvents?: { pod: string; items?: any[]; error?: string }, max: number = MAX_PODS): string {
    if (pods.length === 0) return `The Argo CD resource tree shows no pods for ${owner}.`;

    const lines = pods.slice(0, Math.max(0, max)).map((p) => {
        const facts = [
            p.reason && `Status Reason: ${p.reason}`,
            p.containers && `Containers: ${p.containers}`,
            `Restart Count: ${p.restarts}`,
            p.message && `Message: ${p.message}`,
        ].filter(Boolean).join(", ");
        return `- ${p.name} ${p.health ?? "Unknown"}, ${facts}`;
    });
    const rest = pods.length - lines.length;
    if (rest > 0) lines.push(`- ${rest} more pod${rest === 1 ? "" : "s"} not listed`);

    let text = `Pods of ${owner} (${pods.length}):\n${lines.join("\n")}`;
    if (podEvents?.error) {
        text += `\n\nEvents of pod ${podEvents.pod} could not be fetched (${podEvents.error}).`;
    } else if (podEvents?.items?.length) {
        text += `\n\nEvents of pod ${podEvents.pod}, most recent first:\n${JSON.stringify(summariseEvents(podEvents.items, MAX_POD_EVENTS))}`;
    }
    return text;
}

export async function getResourceTree(application: any, signal?: AbortSignal): Promise<any> {
    const params = new URLSearchParams();
    if (application?.metadata?.namespace) params.set("appNamespace", application.metadata.namespace);
    const qs = params.toString();
    const url = `/api/v1/applications/${encodeURIComponent(application?.metadata?.name ?? "")}/resource-tree${qs ? `?${qs}` : ""}`;
    const response = await argocdFetch(url, application, "Resource tree", { signal });
    return response.json();
}

export async function getPodEvents(application: any, pod: PodState, signal?: AbortSignal): Promise<any[]> {
    const params = new URLSearchParams();
    if (application?.metadata?.namespace) params.set("appNamespace", application.metadata.namespace);
    params.set("resourceUID", pod.uid ?? "");
    params.set("resourceNamespace", pod.namespace ?? "");
    params.set("resourceName", pod.name);
    const url = `/api/v1/applications/${encodeURIComponent(application?.metadata?.name ?? "")}/events?${params.toString()}`;
    const response = await argocdFetch(url, application, "Pod events", { signal });
    // Argo CD returns `items: null` when there are no events.
    return (await response.json())?.items ?? [];
}
