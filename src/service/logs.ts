import { LogEntry } from "../model/argocd";
import { capText, MAX_LOG_CHARS } from "../util/context";
import { readLines } from "../util/stream";
import { argocdFetch, Kinds } from "../util/util";

export const MAX_LINES = 250;

// The logs endpoint is a stream, so its deadline has to cover the whole read, not just the headers.
// `follow=false` plus `tailLines` bounds it to `tailLines` entries per pod, so this is generous.
const LOGS_REQUEST_MS = 60000;

export function hasLogs(resource: any): boolean {
    return !!(resource?.spec?.template?.spec?.containers || resource?.kind === Kinds.POD);
}

// The API group of an apiVersion: "apps/v1" -> "apps", and "v1" -> "" (core resources have no
// group; returning "v1" as the group made the logs API reject core-group non-Pod workloads).
export function getGroup(apiVersion: string): string {
    const index = apiVersion.indexOf("/");
    return index > 0 ? apiVersion.substring(0, index) : "";
}

// Distil log entries into the plain-text block that goes into the prompt.
//
// The wire format carries five fields per line, of which one is the log: `timeStampStr` duplicates
// `timeStamp` at higher precision, `podName` repeats on every line of a pod, and `first`/`last`
// are stream-control flags. Attaching the raw array spends 2-3x the tokens for no extra signal
// (measured on a real pod: 1,521 bytes of JSON for 972 bytes of log content, and short application
// log lines are far worse). One `pod` header line plus `<timestamp> <content>` per line carries the
// same information, in a shape the model reads more naturally than JSON.
export function summariseLogs(entries: LogEntry[], container?: string): string {
    const all = Array.isArray(entries) ? entries : [];
    // The stream ends with an empty-content sentinel entry; it is protocol, not a log line.
    const lines = all.filter((e) => (e?.content ?? "").length > 0);
    // A workload's log interleaves its pods, so each line names its pod once there is more than one.
    // A line Argo CD writes itself, such as a Kubernetes error, carries no pod name.
    const pods = [...new Set(lines.map((e) => e.podName).filter(Boolean))];
    const multiPod = pods.length > 1;
    const rows = lines.map((e) => [multiPod && e.podName, e.timeStamp, e.content].filter(Boolean).join(" "));

    const header = [
        multiPod ? `pods: ${pods.join(", ")}` : pods[0] && `pod: ${pods[0]}`,
        container && `container: ${container}`,
        `lines: ${rows.length}`
    ].filter(Boolean).join(", ");

    // Keep the tail: when a log is too long to attach whole, the recent lines are the ones that
    // explain the failure.
    return `${header}\n${capText(rows.join("\n"), MAX_LOG_CHARS, "container log", "end")}`;
}

export const getLogs = async (application: any, resource: any, container: string, count: number, signal?: AbortSignal): Promise<LogEntry[]> => {
    const params = new URLSearchParams({
        appNamespace: application?.metadata?.namespace ?? "",
        namespace: resource?.metadata?.namespace ?? "",
        container: container,
        tailLines: String(count),
        follow: "false",
        sinceSeconds: "0"
    });

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

    // The logs endpoint is a grpc-gateway server stream, so each line is the RPC envelope
    // `{"result": {...}}` rather than a bare entry - unwrap it. (Verified against a live Argo CD;
    // casting the envelope straight to LogEntry, as this used to, embedded the wrapper in the prompt.)
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
