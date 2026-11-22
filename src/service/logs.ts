import { LogEntry } from "../model/argocd";
import { capText, MAX_LOG_CHARS } from "../util/context";
import { readLines } from "../util/stream";
import { argocdFetch, Kinds } from "../util/util";

export const MAX_LINES = 250;

/**
 * This deadline covers the whole read, because the logs endpoint is a stream. `follow=false` and
 * `tailLines` bound the read to `tailLines` entries per pod, which leaves it generous.
 */
const LOGS_REQUEST_MS = 60000;

export function hasLogs(resource: any): boolean {
    return !!(resource?.spec?.template?.spec?.containers || resource?.kind === Kinds.POD);
}

/** How often a Pod's container has restarted, from its status. 0 when the status does not say. */
export function restartCount(pod: any, container: string): number {
    const statuses = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : [];
    return Number(statuses.find((s: any) => s?.name === container)?.restartCount) || 0;
}

/**
 * The API group of an apiVersion: "apps/v1" gives "apps", and "v1" gives "", because core
 * resources do not have a group. See #123.
 */
export function getGroup(apiVersion: string): string {
    const index = apiVersion.indexOf("/");
    return index > 0 ? apiVersion.substring(0, index) : "";
}

/**
 * Log entries as the plain-text block that goes into the prompt: one header line, then
 * `<timestamp> <content>` per line. Each raw entry also carries a second timestamp and two stream
 * flags, which add tokens without adding information.
 */
export function summariseLogs(entries: LogEntry[], container?: string, previous = false, max: number = MAX_LOG_CHARS): string {
    const all = Array.isArray(entries) ? entries : [];
    // The stream ends with an empty sentinel entry, which is protocol rather than a log line.
    const lines = all.filter((e) => (e?.content ?? "").length > 0);
    // A workload's log interleaves its pods, so each line names its pod once there is more than one.
    // A line Argo CD writes itself, such as a Kubernetes error, carries no pod name.
    const pods = [...new Set(lines.map((e) => e.podName).filter(Boolean))];
    const multiPod = pods.length > 1;
    const rows = lines.map((e) => [multiPod && e.podName, e.timeStamp, e.content].filter(Boolean).join(" "));

    const header = [
        multiPod ? `pods: ${pods.join(", ")}` : pods[0] && `pod: ${pods[0]}`,
        container && `container: ${container}`,
        // Without this the model reads a crashed instance's last lines as the running one's.
        previous && "instance: previous, before the last restart",
        `lines: ${rows.length}`
    ].filter(Boolean).join(", ");

    // Keep the tail: when a log is too long to attach whole, the recent lines are the ones that
    // explain the failure.
    return `${header}\n${capText(rows.join("\n"), max, "container log", "end")}`;
}

/**
 * Lines read from each pod when a filter is set. Argo CD tails each pod first and filters after, so
 * a search over only `count` lines would miss most matches.
 */
export const FILTER_WINDOW_LINES = 1000;

/**
 * The newest `count` log lines of a Pod, or of every pod of a workload. An empty `container` lets
 * Kubernetes pick the only container of a single-container pod. `filter` keeps the lines that
 * contain it, ignoring case.
 */
export const getLogs = async (application: any, resource: any, container: string, count: number, signal?: AbortSignal, previous = false, filter?: string): Promise<LogEntry[]> => {
    const params = new URLSearchParams({
        appNamespace: application?.metadata?.namespace ?? "",
        namespace: resource?.metadata?.namespace ?? "",
        tailLines: String(filter ? Math.max(count, FILTER_WINDOW_LINES) : count),
        follow: "false",
        sinceSeconds: "0"
    });
    if (container) params.set("container", container);
    if (filter) params.set("filter", filter);
    // Argo CD passes this to Kubernetes for every pod. A pod with no previous instance answers with
    // a "previous terminated container ... not found" line, not an error status.
    if (previous) params.append("previous", "true");

    if (resource?.kind === Kinds.POD) {
        params.append("podName", resource?.metadata?.name ?? "");
    } else {
        params.append("resourceName", resource?.metadata?.name ?? "");
        params.append("kind", resource?.kind ?? "");
        params.append("group", getGroup(resource?.apiVersion ?? ""));
    }

    const url = `/api/v1/applications/${encodeURIComponent(application?.metadata?.name ?? "")}/logs?${params.toString()}`;

    const response = await argocdFetch(url, application, "Pod logs", { timeoutMs: LOGS_REQUEST_MS, signal });
    if (!response.body) {
        throw new Error("The Pod logs API returned no response body.");
    }

    // Each line is an RPC envelope `{"result": {...}}` rather than a bare entry, because the logs
    // endpoint is a grpc-gateway server stream. See #119.
    const results: LogEntry[] = [];
    for await (const line of readLines(response.body)) {
        try {
            const entry = JSON.parse(line)?.result;
            if (entry?.content) results.push(entry as LogEntry);
        } catch (_e) {
            // Ignore incomplete/malformed JSON objects.
        }
    }

    // Argo CD tails each pod separately and merges the streams oldest first, so a workload returns
    // up to `count` lines per pod. The newest `count` are the ones that show a failure.
    return results.slice(Math.max(0, results.length - count));
};
