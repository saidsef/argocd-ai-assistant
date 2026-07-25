import { argocdFetch, canRouteToProxy } from "../util/util";

/**
 * Find an Argo CD Application to route the system-level assistant's proxied LLM requests through.
 *
 * The Argo CD proxy extension authorises per-Application: it requires `Argocd-Application-Name`
 * ("namespace:name") and a matching `Argocd-Project-Name` on every request, and rejects anything
 * else (an empty namespace is a 400, a mismatched project a 401). The system-level page has no
 * resource and therefore no Application of its own, so it borrows the first one the user can read.
 * The choice is arbitrary and carries no meaning beyond authorisation - nothing about the picked
 * Application reaches the model.
 *
 * The `fields` mask keeps this to a single ~28KB response instead of the full ~300KB list. It has to
 * ask for `items.spec` whole: the mask does not support leaf paths, and narrowing it to
 * `items.spec.project` makes argocd-server omit `spec` from every item (verified against a live
 * server), so nothing would ever be routable. Returns null when the user can see no usable
 * Application, which the caller turns into an explanation rather than letting the proxy's opaque
 * 400 surface.
 */
export async function getProxyApplication(): Promise<any | null> {
    try {
        const response = await argocdFetch(
            "/api/v1/applications?fields=items.metadata.name,items.metadata.namespace,items.spec",
            undefined,
            "Applications"
        );
        const data = await response.json();
        // The same predicate the request path enforces. Selecting on name+project alone could pick an
        // Application with no namespace, which LlmProvider then rejects on every attempt - so "Press
        // Retry in a moment" could never succeed.
        const app = (data?.items ?? []).find(canRouteToProxy);
        return app ?? null;
    } catch (err) {
        console.warn("Failed to resolve an Argo CD application for proxy routing:", err);
        return null;
    }
}
