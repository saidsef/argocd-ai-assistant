// The fields of an OutOfSync resource that differ from the Application's target state. The manifest
// attachment is the live object, so without this the model cannot say what Argo CD expects.

import { argocdFetch } from "../util/util";
import { getGroup } from "./logs";

// Differing fields listed by path. The rest are counted.
export const MAX_DRIFT_FIELDS = 30;

// One value in a line. A whole ConfigMap file can sit in a single field.
const MAX_VALUE_CHARS = 300;

// Fields the cluster or a client writes, which say nothing about drift from the source.
const SKIPPED_PATHS = new Set([
    "status",
    "metadata.managedFields",
    "metadata.resourceVersion",
    "metadata.generation",
    "metadata.uid",
    "metadata.creationTimestamp",
    // It can hold a Secret's data in plain text.
    'metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]',
]);

/** This resource's entry in the Application's status, which carries its sync status. */
function statusEntry(application: any, resource: any): any {
    const resources: any[] = Array.isArray(application?.status?.resources) ? application.status.resources : [];
    const group = getGroup(resource?.apiVersion ?? "");
    return resources.find((r) =>
        r?.kind === resource?.kind &&
        r?.name === resource?.metadata?.name &&
        (r?.group ?? "") === group &&
        (r?.namespace ?? "") === (resource?.metadata?.namespace ?? ""));
}

/** Whether Argo CD reports this resource OutOfSync. Read from the Application, so it costs no request. */
export function isOutOfSync(application: any, resource: any): boolean {
    if (!resource || resource.kind === "Application") return false;
    return statusEntry(application, resource)?.status === "OutOfSync";
}

const segment = (key: string): string => (/^[A-Za-z_$][\w$-]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

const show = (value: unknown): string => {
    if (value === undefined) return "(not set)";
    const text = JSON.stringify(value);
    return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}… (${text.length} characters)` : text;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The API server leaves a zero value out of the object it stores, so a target `false` or `""` and an
// absent live field are the same state. Argo CD's own diff treats them as equal.
const isZero = (v: unknown): boolean =>
    v === null || v === false || v === 0 || v === "" ||
    (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);

// Resource quantities have several spellings of one value, such as "1000m" and "1" for a CPU.
const QUANTITY_PATH = /\.(limits|requests|hard)[.[]/;
const QUANTITY = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/;
const SCALE: Record<string, number> = {
    n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};
function quantity(v: unknown): number | undefined {
    const match = QUANTITY.exec(String(v));
    return match ? Number(match[1]) * SCALE[match[2] ?? ""] : undefined;
}

function same(t: unknown, l: unknown, path: string): boolean {
    if (JSON.stringify(t) === JSON.stringify(l)) return true;
    if (l === undefined && isZero(t)) return true;
    if (QUANTITY_PATH.test(path) && (typeof t === "string" || typeof t === "number")) {
        const a = quantity(t), b = quantity(l);
        return a !== undefined && b !== undefined && Math.abs(a - b) <= Math.abs(a) * 1e-9;
    }
    return false;
}

/**
 * Every field set in `target` whose value differs in `live`, as `path: target X, live Y`. Fields
 * set only on the live object are left out, because the cluster fills in defaults the source never
 * sets. A Secret's `data` and `stringData` are named without their values.
 */
export function driftFields(target: any, live: any, kind?: string): string[] {
    const lines: string[] = [];
    const secret = kind === "Secret";

    const walk = (t: unknown, l: unknown, path: string) => {
        if (SKIPPED_PATHS.has(path)) return;
        if (isObject(t)) {
            for (const key of Object.keys(t)) walk(t[key], isObject(l) ? l[key] : undefined, path ? `${path}${segment(key)}` : key);
            return;
        }
        if (Array.isArray(t) && Array.isArray(l)) {
            t.forEach((item, i) => walk(item, l[i], `${path}[${i}]`));
            return;
        }
        if (same(t, l, path)) return;
        if (secret && /^(data|stringData)[.[]/.test(path)) {
            lines.push(`${path}: the target and live values differ (Secret values are not shown)`);
            return;
        }
        lines.push(`${path}: target ${show(t)}, live ${show(l)}`);
    };

    walk(target, live, "");
    return lines;
}

const parse = (state: unknown): any => {
    if (typeof state !== "string" || !state) return undefined;
    try {
        return JSON.parse(state);
    } catch (_e) {
        return undefined;
    }
};

/** The text attached for an OutOfSync resource, from its managed-resources entry. */
export function summariseDrift(item: any, kind?: string, max: number = MAX_DRIFT_FIELDS): string {
    if (!item) return "Argo CD did not return a target state for this resource.";
    const target = parse(item?.targetState);
    const live = parse(item?.normalizedLiveState);
    if (target === undefined) return "Argo CD's target state does not include this resource: the Application's source does not define it.";
    if (live === undefined) return "Argo CD has no live state for this resource: it does not exist in the cluster.";

    const lines = driftFields(target, live, kind);
    if (lines.length === 0) {
        return "No field set in Argo CD's target state differs from the live object. The difference may be in a field set only on the live object, which this comparison does not list.";
    }
    const shown = lines.slice(0, Math.max(0, max));
    const rest = lines.length - shown.length;
    if (rest > 0) shown.push(`${rest} more field${rest === 1 ? " differs" : "s differ"}`);
    return `OutOfSync fields (target from the Application's source, live from the cluster; fields set only on the live object are not listed):\n${shown.join("\n")}`;
}

/** The managed-resources entry for one resource, which holds its target and live state. */
export async function getManagedResource(application: any, resource: any, signal?: AbortSignal): Promise<any> {
    const params = new URLSearchParams();
    if (application?.metadata?.namespace) params.set("appNamespace", application.metadata.namespace);
    params.set("kind", resource?.kind ?? "");
    params.set("group", getGroup(resource?.apiVersion ?? ""));
    params.set("name", resource?.metadata?.name ?? "");
    params.set("namespace", resource?.metadata?.namespace ?? "");
    const url = `/api/v1/applications/${encodeURIComponent(application?.metadata?.name ?? "")}/managed-resources?${params.toString()}`;
    const response = await argocdFetch(url, application, "Managed resources", { signal });
    const items = (await response.json())?.items;
    return Array.isArray(items) ? items[0] : undefined;
}
