import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { argocdFetch } from "./util";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const APP = { metadata: { name: "web", namespace: "argocd" }, spec: { project: "default" } };

/** Reject as the platform would when the composed signal fires. */
const rejectWith = (name: string) => {
    globalThis.fetch = (async () => { throw new DOMException("aborted", name); }) as unknown as typeof fetch;
};

describe("argocdFetch", () => {
    it("sends the routing headers and the session cookie", async () => {
        let seen: RequestInit | undefined;
        globalThis.fetch = (async (_url: string, init: RequestInit) => {
            seen = init;
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        await argocdFetch("/api/v1/applications", APP, "Applications");
        assert.equal(seen!.credentials, "include");
        assert.equal((seen!.headers as any)["Argocd-Application-Name"], "argocd:web");
        assert.equal((seen!.headers as any)["Argocd-Project-Name"], "default");
        assert.ok(seen!.signal, "a deadline is always applied");
    });

    it("names the endpoint in a non-2xx error", async () => {
        globalThis.fetch = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
        await assert.rejects(argocdFetch("/x", APP, "Events"), /Events API returned 404 Not Found/);
    });

    it("turns the deadline into a friendly message naming the endpoint", async () => {
        rejectWith("TimeoutError");
        await assert.rejects(argocdFetch("/x", APP, "Pod logs", { timeoutMs: 5000 }), /Pod logs request timed out after 5s/);
    });

    it("keeps that behaviour byte-identical when no caller signal is passed", async () => {
        // AbortSignal.timeout has historically been reported as either name; with no caller signal
        // there is nothing else it could be, so both must still read as a timeout.
        rejectWith("AbortError");
        await assert.rejects(argocdFetch("/x", APP, "Events"), /Events request timed out after 30s/);
    });

    it("lets a caller cancel unwind as an AbortError instead of reporting a timeout", async () => {
        // The distinction the callers depend on: a resource switch or a Cancel button must be
        // filterable, not surfaced to the user as "the Argo CD API may be unreachable".
        rejectWith("AbortError");
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            argocdFetch("/x", APP, "Events", { signal: controller.signal }),
            (err: Error) => {
                assert.equal(err.name, "AbortError");
                assert.doesNotMatch(err.message, /timed out/);
                return true;
            }
        );
    });

    it("still reports a deadline as a timeout even when a caller signal is present", async () => {
        rejectWith("TimeoutError");
        const controller = new AbortController(); // never aborted
        await assert.rejects(
            argocdFetch("/x", APP, "Events", { signal: controller.signal }),
            /Events request timed out/
        );
    });

    it("composes the caller signal with the deadline", async () => {
        let seen: AbortSignal | undefined;
        globalThis.fetch = (async (_url: string, init: RequestInit) => {
            seen = init.signal as AbortSignal;
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        const controller = new AbortController();
        await argocdFetch("/x", APP, "Events", { signal: controller.signal });
        assert.equal(seen!.aborted, false);
        controller.abort();
        assert.equal(seen!.aborted, true, "aborting the caller signal must abort the composed one");
    });
});
