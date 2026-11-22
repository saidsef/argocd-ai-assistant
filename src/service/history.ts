// An Application's recent deployments with what each one deployed, and the result of every resource
// in its last sync. The Application summary lists revisions and dates, which do not say what changed.

import { capText } from "../util/context";
import { argocdFetch, errorMessage } from "../util/util";

export const DEFAULT_HISTORY = 5;

/** Argo CD keeps ten deployments by default (`revisionHistoryLimit`). */
export const MAX_HISTORY = 10;

/** A commit message can run to pages, and the subject and first paragraph carry the change. */
const MAX_MESSAGE_CHARS = 600;

/** Resources of the last sync listed by name, with failures first. The rest are counted. */
const MAX_SYNC_RESOURCES = 20;

/** A sync message is free text from the API server or a hook. */
const MAX_SYNC_MESSAGE_CHARS = 300;

/** Fields kept from an OCI artifact's metadata, which this code does not otherwise interpret. */
const MAX_OCI_FIELD_CHARS = 300;

type Details = Record<string, unknown>;

/** Who started a deployment or an operation, from its `initiatedBy`. */
function initiator(by: any): string | undefined {
    if (by?.automated) return "automated sync";
    return by?.username ? `user ${by.username}` : undefined;
}

/** The endpoint that describes a revision of this source. */
function detailsPath(source: any): "metadata" | "chartdetails" | "ocimetadata" {
    if (source?.chart) return "chartdetails";
    return String(source?.repoURL ?? "").startsWith("oci://") ? "ocimetadata" : "metadata";
}

/** A commit for a Git source, chart details for a Helm repository and artifact metadata for OCI. */
export function revisionSummary(path: string, body: any): Details {
    if (path === "metadata") {
        return {
            commit: {
                author: body?.author,
                date: body?.date,
                tags: Array.isArray(body?.tags) && body.tags.length ? body.tags : undefined,
                message: typeof body?.message === "string" ? capText(body.message.trim(), MAX_MESSAGE_CHARS, "the commit message") : undefined,
            },
        };
    }
    if (path === "chartdetails") {
        return { chartDetails: { description: body?.description, home: body?.home, maintainers: body?.maintainers } };
    }
    const fields = Object.entries(body && typeof body === "object" ? body : {})
        .filter(([, v]) => typeof v === "string" && v)
        .map(([k, v]) => [k, capText(v as string, MAX_OCI_FIELD_CHARS, k)]);
    return { artifact: Object.fromEntries(fields) };
}

async function revisionDetails(
    application: any,
    revision: string,
    source: any,
    multiSource: { sourceIndex: number; versionId?: number } | undefined,
    signal?: AbortSignal
): Promise<Details> {
    const path = detailsPath(source);
    const params = new URLSearchParams();
    if (application?.metadata?.namespace) params.set("appNamespace", application.metadata.namespace);
    if (multiSource) {
        params.set("sourceIndex", String(multiSource.sourceIndex));
        if (multiSource.versionId !== undefined) params.set("versionId", String(multiSource.versionId));
    }
    const qs = params.toString();
    const url = `/api/v1/applications/${encodeURIComponent(application?.metadata?.name ?? "")}/revisions/${encodeURIComponent(revision)}/${path}${qs ? `?${qs}` : ""}`;
    try {
        const response = await argocdFetch(url, application, "Revision metadata", { signal });
        return revisionSummary(path, await response.json());
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        // One unreadable revision, such as a force-pushed commit, should not hide the others.
        return { detailsError: errorMessage(err) };
    }
}

const sourceFields = (s: any) => ({
    repoURL: s?.repoURL,
    path: s?.path,
    chart: s?.chart,
    targetRevision: s?.targetRevision,
});

/** Failed resources and hooks first, because they explain a failed sync. */
const failed = (r: any): boolean =>
    r?.status === "SyncFailed" || r?.status === "PruneSkipped" || r?.hookPhase === "Failed" || r?.hookPhase === "Error";

/** The last operation, with the result of each resource it applied. */
export function summariseLastOperation(op: any): Details | undefined {
    if (!op || typeof op !== "object") return undefined;
    const all: any[] = Array.isArray(op.syncResult?.resources) ? op.syncResult.resources : [];
    const ordered = [...all.filter(failed), ...all.filter((r) => !failed(r))];
    const shown = ordered.slice(0, MAX_SYNC_RESOURCES).map((r) => ({
        kind: r?.kind,
        namespace: r?.namespace || undefined,
        name: r?.name,
        status: r?.status,
        message: typeof r?.message === "string" && r.message ? capText(r.message, MAX_SYNC_MESSAGE_CHARS, "the message") : undefined,
        hookType: r?.hookType,
        hookPhase: r?.hookPhase,
        syncPhase: r?.syncPhase,
    }));
    return {
        phase: op.phase,
        message: op.message,
        startedAt: op.startedAt,
        finishedAt: op.finishedAt,
        initiatedBy: initiator(op.operation?.initiatedBy),
        revision: op.syncResult?.revision,
        revisions: op.syncResult?.revisions,
        resources: shown,
        resourcesNotListed: all.length > shown.length ? all.length - shown.length : undefined,
    };
}

/**
 * The newest `limit` deployments of an Application, newest first, each with the details of what it
 * deployed, and the result of its last operation. `app` is the current Application object.
 */
export async function getChangeHistory(app: any, limit: number, signal?: AbortSignal): Promise<Details> {
    const history: any[] = Array.isArray(app?.status?.history) ? app.status.history : [];
    const recent = history.slice(-Math.max(1, limit)).reverse();

    const deployments = await Promise.all(recent.map(async (h) => {
        const multi = Array.isArray(h?.sources) && h.sources.length > 0;
        const sources: any[] = multi ? h.sources : [h?.source];
        const revisions: any[] = multi ? (Array.isArray(h?.revisions) ? h.revisions : []) : [h?.revision];
        return {
            id: h?.id,
            deployStartedAt: h?.deployStartedAt,
            deployedAt: h?.deployedAt,
            initiatedBy: initiator(h?.initiatedBy),
            sources: await Promise.all(sources.map(async (source, i) => {
                const revision = revisions[i];
                return {
                    ...sourceFields(source),
                    revision,
                    ...(typeof revision === "string" && revision
                        ? await revisionDetails(app, revision, source, multi ? { sourceIndex: i, versionId: h?.id } : undefined, signal)
                        : {}),
                };
            })),
        };
    }));

    return {
        deployments,
        deploymentsNotListed: history.length > recent.length ? history.length - recent.length : undefined,
        lastOperation: summariseLastOperation(app?.status?.operationState),
    };
}
