import { argocdApiHeaders } from "../util/util";

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
 * The `fields` mask keeps this to a single ~29KB response instead of the full ~320KB list. Returns
 * null when the user can see no Applications, which the caller turns into an explanation rather
 * than letting the proxy's opaque 400 surface.
 */
export async function getProxyApplication(): Promise<any | null> {
    try {
        const response = await fetch(
            "/api/v1/applications?fields=items.metadata.name,items.metadata.namespace,items.spec",
            { credentials: "include", method: "GET", headers: argocdApiHeaders(undefined) }
        );
        if (!response.ok) {
            throw new Error(`Applications API returned ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        const app = (data?.items ?? []).find((a: any) => a?.metadata?.name && a?.spec?.project);
        return app ?? null;
    } catch (err) {
        console.warn("Failed to resolve an Argo CD application for proxy routing:", err);
        return null;
    }
}
