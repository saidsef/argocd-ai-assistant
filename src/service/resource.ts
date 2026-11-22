// One resource of an Application, found by kind and name in its resource tree. The tree supplies
// the group and version that the resource endpoint requires, and it holds only the Application's
// own resources.

import { argocdFetch, Kinds, stripManifestNoise } from "../util/util";
import { podsOf } from "./pods";

export interface TreeNode {
    group?: string;
    version?: string;
    kind: string;
    namespace?: string;
    name: string;
    uid?: string;
}

/** Names listed when a lookup finds nothing. The rest are counted. */
const MAX_SUGGESTIONS = 20;

/** `Kind namespace/name`, the form every tool result uses for a resource. */
export const nodeLabel = (n: { kind?: string; namespace?: string; name?: string }): string =>
    `${n.kind ?? ""} ${n.namespace ? `${n.namespace}/` : ""}${n.name ?? ""}`;

/** The nodes of a resource tree that name a kind and a resource. */
export function treeNodes(tree: any): TreeNode[] {
    const nodes: any[] = Array.isArray(tree?.nodes) ? tree.nodes : [];
    return nodes.filter((n) => typeof n?.kind === "string" && typeof n?.name === "string");
}

/** Nodes of this kind and name, and in this namespace when one is given. Kind ignores case. */
export function findNodes(tree: any, kind: string, name: string, namespace?: string): TreeNode[] {
    const wanted = kind.toLowerCase();
    return treeNodes(tree).filter((n) =>
        n.kind.toLowerCase() === wanted &&
        n.name === name &&
        (!namespace || (n.namespace ?? "") === namespace));
}

/** A sentence naming the resources of one kind in the tree, so the model can correct a name. */
export function kindRoster(tree: any, kind: string): string {
    const wanted = kind.toLowerCase();
    const names = treeNodes(tree).filter((n) => n.kind.toLowerCase() === wanted).map(nodeLabel);
    if (names.length === 0) {
        const kinds = [...new Set(treeNodes(tree).map((n) => n.kind))].sort();
        return kinds.length ? `It does not have any ${kind}. Its resource kinds are ${kinds.join(", ")}.` : "Its resource tree is empty.";
    }
    const shown = names.slice(0, MAX_SUGGESTIONS);
    const rest = names.length - shown.length;
    return `Its resources of that kind are ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`;
}

/**
 * The node to read logs from: a Pod with this name, or else a resource with this name that owns
 * pods, such as a Deployment. Several matches mean the caller has to name a namespace.
 */
export function logSources(tree: any, name: string, namespace?: string): TreeNode[] {
    const named = treeNodes(tree).filter((n) => n.name === name && (!namespace || (n.namespace ?? "") === namespace));
    const pods = named.filter((n) => n.kind === Kinds.POD);
    if (pods.length) return pods;
    return named.filter((n) => n.uid && podsOf(tree, { metadata: { uid: n.uid } }).length > 0);
}

/** The pod-owning resources of a tree, listed when a log lookup finds nothing. */
export function workloadRoster(tree: any): string {
    const owners = treeNodes(tree).filter((n) =>
        n.kind !== Kinds.POD && n.kind !== "ReplicaSet" && n.uid && podsOf(tree, { metadata: { uid: n.uid } }).length > 0);
    if (owners.length === 0) return "It does not have any pods.";
    const shown = owners.slice(0, MAX_SUGGESTIONS).map(nodeLabel);
    const rest = owners.length - shown.length;
    return `Its workloads are ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`;
}

/** A node as the resource object that getLogs and getManagedResource read. */
export function nodeAsResource(node: TreeNode): any {
    return {
        kind: node.kind,
        apiVersion: node.group ? `${node.group}/${node.version ?? ""}` : node.version ?? "",
        metadata: { name: node.name, namespace: node.namespace, uid: node.uid },
    };
}

/** The live object of one node, from the Argo CD resource endpoint. */
export async function getLiveResource(application: any, node: TreeNode, signal?: AbortSignal): Promise<any> {
    const params = new URLSearchParams();
    if (application?.metadata?.namespace) params.set("appNamespace", application.metadata.namespace);
    params.set("namespace", node.namespace ?? "");
    params.set("resourceName", node.name);
    params.set("kind", node.kind);
    params.set("group", node.group ?? "");
    // Argo CD rejects the request without a version.
    params.set("version", node.version ?? "");
    const url = `/api/v1/applications/${encodeURIComponent(application?.metadata?.name ?? "")}/resource?${params.toString()}`;
    const response = await argocdFetch(url, application, "Resource", { signal });
    const manifest = (await response.json())?.manifest;
    if (typeof manifest !== "string" || !manifest) throw new Error("The Resource API returned no manifest.");
    return JSON.parse(manifest);
}

/**
 * A live object without managedFields and the last-applied annotation, and with every Secret value
 * replaced. Argo CD masks Secret values itself, and this keeps them out if it ever does not.
 */
export function redactManifest(manifest: any): any {
    const clean = stripManifestNoise(manifest);
    if (clean?.kind !== "Secret") return clean;
    const hide = (values: unknown) => values && typeof values === "object"
        ? Object.fromEntries(Object.keys(values as object).map((key) => [key, "(hidden)"]))
        : values;
    return { ...clean, data: hide(clean.data), stringData: hide(clean.stringData) };
}
