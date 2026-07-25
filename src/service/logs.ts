import { LogEntry } from "../model/argocd";
import { capText, MAX_LOG_CHARS } from "../util/context";
import { readLines } from "../util/stream";
import { argocdApiHeaders, Kinds } from "../util/util";

export const MAX_LINES = 250;

export function hasLogs(resource: any): boolean {
    return !!(resource?.spec?.template?.spec?.containers || resource?.kind === Kinds.POD);
}

function getGroup(apiVersion: string): string {
    const index = apiVersion.indexOf("/");
    if (index > 0) return apiVersion.substring(0, index);
    else return apiVersion;
}

// Distil log entries into the plain-text block that goes into the prompt.
//
// The wire format carries five fields per line, of which one is the log: `timeStampStr` duplicates
// `timeStamp` at higher precision, `podName` repeats identically on every line, and `first`/`last`
// are stream-control flags. Attaching the raw array spends 2-3x the tokens for no extra signal
// (measured on a real pod: 1,521 bytes of JSON for 972 bytes of log content, and short application
// log lines are far worse). One `pod` header line plus `<timestamp> <content>` per line carries the
// same information, in a shape the model reads more naturally than JSON.
export function summariseLogs(entries: LogEntry[], container?: string): string {
    const rows = (Array.isArray(entries) ? entries : [])
        // The stream ends with an empty-content `last: true` sentinel; it is protocol, not a log line.
        .filter((e) => (e?.content ?? "").length > 0)
        .map((e) => (e.timeStamp ? `${e.timeStamp} ${e.content}` : e.content));

    const pod = entries.find((e) => e?.podName)?.podName;
    const header = [
        pod && `pod: ${pod}`,
        container && `container: ${container}`,
        `lines: ${rows.length}`
    ].filter(Boolean).join(", ");

    // Keep the tail: when a log is too long to attach whole, the recent lines are the ones that
    // explain the failure.
    return `${header}\n${capText(rows.join("\n"), MAX_LOG_CHARS, "container log", "end")}`;
}

export const getLogs = async (application: any, resource: any, container: string, count: number): Promise<LogEntry[]> => {
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

    const response = await fetch(url, {
        credentials: 'include',
        method: 'GET',
        headers: argocdApiHeaders(application)
    });
    if (!response.ok || !response.body) {
        throw new Error(`Failed to fetch data: ${response.status} ${response.statusText}`);
    }

    // The logs endpoint is a grpc-gateway server stream, so each line is the RPC envelope
    // `{"result": {...}}` rather than a bare entry - unwrap it. (Verified against a live Argo CD;
    // casting the envelope straight to LogEntry, as this used to, embedded the wrapper in the prompt.)
    const results: LogEntry[] = [];
    for await (const line of readLines(response.body)) {
        if (results.length >= count) break;
        try {
            const entry = JSON.parse(line)?.result;
            if (entry) results.push(entry as LogEntry);
        } catch (_e) {
            // Ignore incomplete/malformed JSON objects.
        }
    }

    return results;
};
