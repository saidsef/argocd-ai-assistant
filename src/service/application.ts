import { argocdFetch } from "../util/util";

// A compact view of an Argo CD Application, like `argocd app get`. It lists only the resources that
// are out of sync or unhealthy, because the raw object carries the whole resource tree and history.

const MAX_LIST = 15;    // per resource sub-list (out-of-sync / unhealthy)
const MAX_IMAGES = 20;
const MAX_HISTORY = 3;

interface SourceSummary {
    repoURL?: string;
    chart?: string;
    path?: string;
    targetRevision?: string;
    helmParameters?: Array<{ name?: string; value?: string }>;
    helmValueFiles?: string[];
}

interface ResourceRef {
    kind?: string;
    name?: string;
    namespace?: string;
    status?: string;
    health?: string;
    message?: string;
}

export interface ApplicationSummary {
    name: string;
    namespace?: string;
    project?: string;
    sourceType?: string;
    sources: SourceSummary[];
    sync: { status?: string; revision?: string; targetRevision?: string };
    health: { status?: string; message?: string };
    syncPolicy: { automated: boolean; prune?: boolean; selfHeal?: boolean; syncOptions?: string[] };
    destination: { server?: string; name?: string; namespace?: string };
    images?: string[];
    externalURLs?: string[];
    resources: {
        total: number;
        synced: number;
        outOfSyncCount: number;
        outOfSync: ResourceRef[];
        unhealthyCount: number;
        unhealthy: ResourceRef[];
    };
    lastOperation?: { phase?: string; message?: string; finishedAt?: string; revision?: string };
    history?: Array<{ revision?: string; deployedAt?: string; chart?: string; targetRevision?: string }>;
}

/**
 * An Argo CD Application distilled into an ApplicationSummary, or null when the input is not an
 * Application. It tolerates missing fields and never throws.
 */
export function summariseApplication(app: any): ApplicationSummary | null {
    if (!app || typeof app !== "object" || !app.metadata) return null;

    const spec = app.spec || {};
    const status = app.status || {};

    // Single-source (spec.source) or multi-source (spec.sources) - normalise to an array.
    const rawSources: any[] = Array.isArray(spec.sources)
        ? spec.sources
        : (spec.source ? [spec.source] : []);
    const sources: SourceSummary[] = rawSources.map((s) => ({
        repoURL: s?.repoURL,
        chart: s?.chart,
        path: s?.path,
        targetRevision: s?.targetRevision,
        helmParameters: s?.helm?.parameters,
        helmValueFiles: s?.helm?.valueFiles,
    }));

    // `automated` may be {}, {enabled:true}, {enabled:false}, or absent. Treat present-and-not-
    // explicitly-disabled as automated (matches Argo CD's own default when `enabled` is omitted).
    const auto = spec.syncPolicy?.automated;

    const resList: any[] = Array.isArray(status.resources) ? status.resources : [];
    const outOfSyncAll = resList.filter((r) => r?.status && r.status !== "Synced");
    const unhealthyAll = resList.filter((r) => r?.health?.status && r.health.status !== "Healthy");
    const toRef = (r: any): ResourceRef => ({
        kind: r?.kind,
        name: r?.name,
        namespace: r?.namespace,
        status: r?.status,
        health: r?.health?.status,
        message: r?.health?.message,
    });

    const op = status.operationState;
    const hist: any[] = Array.isArray(status.history) ? status.history : [];

    const images: string[] | undefined = Array.isArray(status.summary?.images)
        ? status.summary.images.slice(0, MAX_IMAGES)
        : undefined;

    return {
        name: app.metadata.name,
        namespace: app.metadata.namespace,
        project: spec.project,
        sourceType: status.sourceType,
        sources,
        sync: {
            status: status.sync?.status,
            revision: status.sync?.revision,
            targetRevision: sources[0]?.targetRevision,
        },
        health: { status: status.health?.status, message: status.health?.message },
        syncPolicy: {
            automated: auto ? auto.enabled !== false : false,
            prune: auto?.prune,
            selfHeal: auto?.selfHeal,
            syncOptions: spec.syncPolicy?.syncOptions,
        },
        destination: {
            server: spec.destination?.server,
            name: spec.destination?.name,
            namespace: spec.destination?.namespace,
        },
        images,
        externalURLs: status.summary?.externalURLs,
        resources: {
            total: resList.length,
            synced: resList.filter((r) => r?.status === "Synced").length,
            outOfSyncCount: outOfSyncAll.length,
            outOfSync: outOfSyncAll.slice(0, MAX_LIST).map(toRef),
            unhealthyCount: unhealthyAll.length,
            unhealthy: unhealthyAll.slice(0, MAX_LIST).map(toRef),
        },
        lastOperation: op
            ? { phase: op.phase, message: op.message, finishedAt: op.finishedAt, revision: op.syncResult?.revision }
            : undefined,
        history: hist.length
            ? hist.slice(-MAX_HISTORY).reverse().map((h) => ({
                revision: h?.revision,
                deployedAt: h?.deployedAt,
                chart: h?.source?.chart,
                targetRevision: h?.source?.targetRevision,
            }))
            : undefined,
    };
}

/**
 * The current Application from the Argo CD API, distilled. The request does not ask for a refresh,
 * and never triggers a reconcile. Any failure falls back to the Application already in props.
 */
export async function getApplicationSummary(application: any, signal?: AbortSignal): Promise<ApplicationSummary | null> {
    if (!application?.metadata?.name) return summariseApplication(application);

    try {
        const fresh = await getApplication(application, signal);
        return summariseApplication(fresh) ?? summariseApplication(application);
    } catch (err) {
        // A caller cancel, from a resource switch or unmount, is not a failure worth logging.
        if (!(err instanceof Error && err.name === "AbortError")) {
            console.warn("Failed to fetch Argo CD application summary, falling back to cached manifest:", err);
        }
        return summariseApplication(application);
    }
}

/** The current Application object from the Argo CD API. It throws when the request fails. */
export async function getApplication(application: any, signal?: AbortSignal): Promise<any> {
    const params = new URLSearchParams();
    if (application?.metadata?.namespace) params.set("appNamespace", application.metadata.namespace);
    const qs = params.toString();
    const url = `/api/v1/applications/${encodeURIComponent(application?.metadata?.name ?? "")}${qs ? `?${qs}` : ""}`;
    const response = await argocdFetch(url, application, "Application", { signal });
    return response.json();
}
