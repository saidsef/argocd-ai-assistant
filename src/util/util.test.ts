import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    argocdHeaders,
    bearer,
    canRouteToProxy,
    containsWord,
    getContainers,
    getResourceIdentifier,
    mcpWelcomeHint,
    parseMcpServers,
    stripManifestNoise,
} from "./util";

describe("parseMcpServers", () => {
    it("accepts bare URL strings and the object form", () => {
        assert.deepEqual(parseMcpServers(["https://a/mcp", { url: "https://b/mcp", name: "bee" }]), [
            { url: "https://a/mcp" },
            { url: "https://b/mcp", name: "bee" },
        ]);
    });

    it("drops malformed entries without losing the good ones", () => {
        // The setting is hand-written into a ConfigMap: one bad line must cost that one server only.
        assert.deepEqual(parseMcpServers(["", "  ", 42, null, { name: "no-url" }, { url: 7 }, "https://ok/mcp"]), [
            { url: "https://ok/mcp" },
        ]);
    });

    it("returns an empty list for anything that is not an array", () => {
        for (const raw of [undefined, null, "https://a/mcp", {}, 3]) {
            assert.deepEqual(parseMcpServers(raw), []);
        }
    });

    it("trims whitespace and omits an empty name rather than storing one", () => {
        assert.deepEqual(parseMcpServers([{ url: "  https://a/mcp  ", name: "   " }]), [{ url: "https://a/mcp" }]);
    });
});

describe("containsWord", () => {
    it("matches on whole-word boundaries, case-insensitively", () => {
        assert.equal(containsWord("hey docs, search for x", "docs"), true);
        assert.equal(containsWord("DOCS please", "docs"), true);
        assert.equal(containsWord("check the documentation", "docs"), false);
        assert.equal(containsWord("docside panel", "docs"), false);
    });

    it("treats punctuation and dots as boundaries so hostname handles match", () => {
        assert.equal(containsWord("ask docs.example.com about it", "docs"), true);
        assert.equal(containsWord("use my-server now", "my-server"), true);
    });

    it("escapes regex metacharacters in the term", () => {
        // A handle is derived from a hostname, so it routinely contains dots.
        assert.equal(containsWord("ask a.b about it", "a.b"), true);
        assert.equal(containsWord("ask axb about it", "a.b"), false);
    });

    it("is false for empty input on either side", () => {
        assert.equal(containsWord("", "docs"), false);
        assert.equal(containsWord("docs", ""), false);
    });
});

describe("bearer", () => {
    it("adds the scheme once, whatever case it arrives in", () => {
        assert.equal(bearer("abc"), "Bearer abc");
        assert.equal(bearer("Bearer abc"), "Bearer abc");
        // RFC 7235 makes the scheme case-insensitive; double-prefixing used to 401.
        assert.equal(bearer("bearer abc"), "bearer abc");
        assert.equal(bearer("BEARER abc"), "BEARER abc");
    });
});

describe("stripManifestNoise", () => {
    it("drops managedFields and last-applied-configuration, keeping other annotations", () => {
        const out = stripManifestNoise({
            kind: "Deployment",
            metadata: {
                name: "web",
                managedFields: [{ manager: "kubectl" }],
                annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{...}", keep: "yes" },
            },
        });
        assert.equal(out.metadata.managedFields, undefined);
        assert.deepEqual(out.metadata.annotations, { keep: "yes" });
        assert.equal(out.metadata.name, "web");
        assert.equal(out.kind, "Deployment");
    });

    it("does not mutate its input", () => {
        const input = { metadata: { name: "web", managedFields: [1] } };
        stripManifestNoise(input);
        assert.deepEqual(input.metadata.managedFields, [1]);
    });

    it("passes through anything without an object metadata", () => {
        for (const value of [null, undefined, "x", 3, { kind: "Pod" }, { metadata: null }]) {
            assert.equal(stripManifestNoise(value), value);
        }
    });
});

describe("argocdHeaders / canRouteToProxy", () => {
    it("always emits both Argocd-* headers, since the proxy rejects a missing one", () => {
        assert.deepEqual(argocdHeaders(undefined), {
            "Argocd-Application-Name": ":",
            "Argocd-Project-Name": "",
        });
    });

    it("formats the application name as namespace:name and merges extras", () => {
        const app = { metadata: { name: "web", namespace: "argocd" }, spec: { project: "default" } };
        assert.deepEqual(argocdHeaders(app, { "Content-Type": "application/json" }), {
            "Argocd-Application-Name": "argocd:web",
            "Argocd-Project-Name": "default",
            "Content-Type": "application/json",
        });
    });

    it("requires name, namespace and project before the proxy can authorise", () => {
        assert.equal(canRouteToProxy({ metadata: { name: "w", namespace: "a" }, spec: { project: "d" } }), true);
        assert.equal(canRouteToProxy({ metadata: { name: "w", namespace: "a" }, spec: {} }), false);
        assert.equal(canRouteToProxy({ metadata: { name: "w" }, spec: { project: "d" } }), false);
        assert.equal(canRouteToProxy(undefined), false);
    });
});

describe("getResourceIdentifier / getContainers", () => {
    it("prefers uid and falls back to kind-namespace-name", () => {
        assert.equal(getResourceIdentifier({ metadata: { uid: "u1" } }), "u1");
        assert.equal(getResourceIdentifier({ kind: "Pod", metadata: { namespace: "ns", name: "p" } }), "Pod-ns-p");
        assert.equal(getResourceIdentifier(undefined), "Undefined");
    });

    it("reads containers from the pod spec or the workload template", () => {
        assert.deepEqual(getContainers({ kind: "Pod", spec: { containers: [{ name: "app" }] } }), ["app"]);
        assert.deepEqual(
            getContainers({ kind: "Deployment", spec: { template: { spec: { containers: [{ name: "a" }, { name: "b" }] } } } }),
            ["a", "b"]
        );
        assert.deepEqual(getContainers({ kind: "Service" }), []);
    });
});

describe("mcpWelcomeHint", () => {
    it("is empty when no server is configured", () => {
        assert.equal(mcpWelcomeHint([]), "");
    });

    it("renders handles as code spans so punctuation cannot break the markdown", () => {
        assert.match(mcpWelcomeHint(["docs"]), /`docs`/);
        const two = mcpWelcomeHint(["docs", "gitlab"]);
        assert.match(two, /`docs`, and `gitlab`|`docs` and `gitlab`/);
        assert.match(two, /tool servers/);
    });
});
