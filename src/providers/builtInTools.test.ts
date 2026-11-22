// The built-in tools against a fake Argo CD API, which records every request URL.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { builtInTools, builtInToolsOf, currentTime, runBuiltInTool } from "./builtInTools";
import { findNodes, logSources, redactManifest } from "../service/resource";
import { summariseLastOperation } from "../service/history";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const app = { metadata: { name: "shop", namespace: "argocd" }, spec: { project: "default" } };

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const tree = {
    nodes: [
        { group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "api", uid: "d1" },
        { group: "apps", version: "v1", kind: "ReplicaSet", namespace: "web", name: "api-5d8", uid: "r1", parentRefs: [{ uid: "d1" }] },
        { version: "v1", kind: "Pod", namespace: "web", name: "api-5d8-x1", uid: "p1", parentRefs: [{ uid: "r1" }] },
        { version: "v1", kind: "Service", namespace: "web", name: "api", uid: "s1" },
        { version: "v1", kind: "ConfigMap", namespace: "web", name: "api-config", uid: "c1" },
        { version: "v1", kind: "Secret", namespace: "web", name: "api-token", uid: "k1" },
    ],
};

/** Answers each path from `routes`, and records every URL requested. */
function argocd(routes: Record<string, (url: URL) => Response>) {
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string) => {
        const url = new URL(input, "https://argocd.test");
        urls.push(url);
        const route = Object.keys(routes).find((path) => url.pathname.endsWith(path));
        if (!route) throw new Error(`unexpected request ${url.pathname}`);
        return routes[route](url);
    }) as unknown as typeof fetch;
    return urls;
}

const ctx = { application: app, scope: "open-application" as const, maxChars: 16000 };

/** The /assistant page, where `application` only routes the proxy. */
const anyCtx = { application: { metadata: { name: "router", namespace: "argocd" }, spec: { project: "default" } }, scope: "any-application" as const, maxChars: 16000 };

describe("built-in tool definitions", () => {
    it("gives every tool a skill and an object schema", () => {
        assert.deepEqual(builtInToolsOf("open-application").map((t) => t.name), ["get_current_datetime", "get_resource", "get_logs", "get_change_history", "get_resource_diff"]);
        for (const tool of [...builtInToolsOf("open-application"), ...builtInToolsOf("any-application")]) {
            assert.match(tool.description ?? "", /Call it /, tool.name);
            assert.equal(tool.inputSchema.type, "object", tool.name);
            assert.equal(tool.serverIndex, -1, tool.name);
        }
    });

    it("asks for an Application only on the /assistant page, where it adds a way to list them", () => {
        const any = builtInToolsOf("any-application");
        assert.deepEqual(any.map((t) => t.name), ["get_current_datetime", "list_applications", "get_resource", "get_logs", "get_change_history", "get_resource_diff"]);
        for (const tool of any.filter((t) => !["get_current_datetime", "list_applications"].includes(t.name))) {
            assert.equal(tool.inputSchema.required[0], "application", tool.name);
            assert.doesNotMatch(tool.description ?? "", /this Argo CD Application|did not open/, tool.name);
        }
        for (const tool of builtInToolsOf("open-application")) {
            assert.equal(tool.inputSchema.properties.application, undefined, tool.name);
        }
    });

    it("offers none in the resource tab until its Application resolves, and none when unset", () => {
        assert.deepEqual(builtInTools({ builtInTools: "open-application" }), []);
        assert.equal(builtInTools({ builtInTools: "open-application", application: app }).length, 5);
        assert.equal(builtInTools({ builtInTools: "any-application" }).length, 6);
        assert.deepEqual(builtInTools({ application: app }), []);
    });
});

describe("get_current_datetime", () => {
    const now = new Date("2026-11-22T00:12:34.567Z");

    it("gives the time in UTC and in the user's time zone", () => {
        const out = currentTime(now, "Asia/Tokyo");
        assert.match(out, /^Current time: 2026-11-22T00:12:34Z \(UTC\)\. The user's time zone is Asia\/Tokyo, where it is Sunday,? 22 November 2026 at 09:12:34 /);
    });

    it("falls back to UTC for a time zone the browser does not know", () => {
        assert.match(currentTime(now, "Nowhere/Special"), /time zone is UTC, where it is Sunday,? 22 November 2026 at 00:12:34/);
    });

    it("runs without a network call", async () => {
        const urls = argocd({});
        const out = await runBuiltInTool("get_current_datetime", {}, { ...ctx, now: () => now, timeZone: "UTC" });
        assert.match(out, /2026-11-22T00:12:34Z/);
        assert.equal(urls.length, 0);
    });
});

describe("resource lookups", () => {
    it("matches the kind in any case, and the namespace only when given", () => {
        assert.deepEqual(findNodes(tree, "deployment", "api").map((n) => n.uid), ["d1"]);
        assert.deepEqual(findNodes(tree, "Deployment", "api", "other"), []);
    });

    it("reads logs from a pod by name, or from the resource that owns pods", () => {
        assert.deepEqual(logSources(tree, "api-5d8-x1").map((n) => n.kind), ["Pod"]);
        // The Service shares the name but owns no pods.
        assert.deepEqual(logSources(tree, "api").map((n) => n.kind), ["Deployment"]);
        assert.deepEqual(logSources(tree, "api-config"), []);
    });

    it("hides every Secret value and drops the noise", () => {
        const secret = redactManifest({
            kind: "Secret",
            metadata: { name: "s", managedFields: [{}], annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}" } },
            data: { token: "c2VjcmV0" },
            stringData: { password: "hunter2" },
        });
        assert.deepEqual(secret.data, { token: "(hidden)" });
        assert.deepEqual(secret.stringData, { password: "(hidden)" });
        assert.equal(secret.metadata.managedFields, undefined);
        assert.doesNotMatch(JSON.stringify(secret), /c2VjcmV0|hunter2/);
        assert.deepEqual(redactManifest({ kind: "ConfigMap", metadata: {}, data: { a: "b" } }).data, { a: "b" });
    });
});

describe("get_resource", () => {
    it("reads the manifest with the group and version from the tree, and the resource's events", async () => {
        const urls = argocd({
            "/resource-tree": () => json(tree),
            "/resource": () => json({ manifest: JSON.stringify({ kind: "ConfigMap", metadata: { name: "api-config" }, data: { LOG_LEVEL: "debug" } }) }),
            "/events": () => json({ items: [{ type: "Warning", reason: "Failed", message: "bad", lastTimestamp: "2026-11-21T10:00:00Z" }] }),
        });
        const out = await runBuiltInTool("get_resource", { kind: "configmap", name: "api-config" }, ctx);

        assert.match(out, /^Live manifest of ConfigMap web\/api-config:\n/);
        assert.match(out, /"LOG_LEVEL":"debug"/);
        assert.match(out, /Events, most recent first:\n.*"reason":"Failed"/);
        const resource = urls.find((u) => u.pathname.endsWith("/resource"))!;
        assert.equal(resource.pathname, "/api/v1/applications/shop/resource");
        assert.equal(resource.searchParams.get("version"), "v1");
        assert.equal(resource.searchParams.get("group"), "");
        assert.equal(resource.searchParams.get("appNamespace"), "argocd");
        assert.equal(urls.find((u) => u.pathname.endsWith("/events"))!.searchParams.get("resourceUID"), "c1");
    });

    it("lists the resources of the kind when the name matches nothing", async () => {
        argocd({ "/resource-tree": () => json(tree) });
        const out = await runBuiltInTool("get_resource", { kind: "Service", name: "web" }, ctx);
        assert.equal(out, "argocd/shop does not have a Service named web. Its resources of that kind are Service web/api.");
        const none = await runBuiltInTool("get_resource", { kind: "Ingress", name: "web" }, ctx);
        assert.match(none, /It does not have any Ingress\. Its resource kinds are ConfigMap, Deployment, Pod, ReplicaSet, Secret, Service\./);
    });

    it("keeps the manifest when the events cannot be fetched", async () => {
        argocd({
            "/resource-tree": () => json(tree),
            "/resource": () => json({ manifest: JSON.stringify({ kind: "Service", metadata: { name: "api" } }) }),
            "/events": () => json({}, 500),
        });
        const out = await runBuiltInTool("get_resource", { kind: "Service", name: "api" }, ctx);
        assert.match(out, /^Live manifest of Service web\/api/);
        assert.match(out, /Events could not be fetched \(Events API returned 500/);
    });

    it("does not call Argo CD without a kind and a name", async () => {
        const urls = argocd({});
        assert.equal(await runBuiltInTool("get_resource", { kind: "Service" }, ctx), "Not run: kind and name are both required.");
        assert.equal(urls.length, 0);
    });
});

describe("get_logs", () => {
    const stream = (lines: string[]) => new Response(
        lines.map((content, i) => JSON.stringify({ result: { content, timeStamp: `T${i}`, podName: "api-5d8-x1" } })).join("\n") + "\n",
        { status: 200 },
    );

    it("reads a workload's logs by kind and group, and leaves the container to Kubernetes", async () => {
        const urls = argocd({ "/resource-tree": () => json(tree), "/logs": () => stream(["started", "listening"]) });
        const out = await runBuiltInTool("get_logs", { name: "api" }, ctx);

        const logs = urls.find((u) => u.pathname.endsWith("/logs"))!.searchParams;
        assert.equal(logs.get("kind"), "Deployment");
        assert.equal(logs.get("group"), "apps");
        assert.equal(logs.get("resourceName"), "api");
        assert.equal(logs.get("tailLines"), "100");
        assert.equal(logs.has("container"), false);
        assert.equal(logs.has("filter"), false);
        assert.match(out, /^Logs of Deployment web\/api:\npod: api-5d8-x1, lines: 2\nT0 started\nT1 listening$/);
    });

    it("searches a wider window when filtering, and asks for the previous instance", async () => {
        const urls = argocd({ "/resource-tree": () => json(tree), "/logs": () => stream(["panic: boom"]) });
        const out = await runBuiltInTool("get_logs", { name: "api-5d8-x1", container: "api", filter: "panic", previous: "true", lines: 9999 }, ctx);

        const logs = urls.find((u) => u.pathname.endsWith("/logs"))!.searchParams;
        assert.equal(logs.get("podName"), "api-5d8-x1");
        assert.equal(logs.get("container"), "api");
        assert.equal(logs.get("filter"), "panic");
        assert.equal(logs.get("previous"), "true");
        assert.equal(logs.get("tailLines"), "1000");
        assert.match(out, /only lines containing "panic" \(ignoring case\) among the last 1000 of each pod/);
        assert.match(out, /instance: previous/);
    });

    it("names the workloads when nothing owns pods under that name", async () => {
        argocd({ "/resource-tree": () => json(tree) });
        assert.equal(
            await runBuiltInTool("get_logs", { name: "api-config" }, ctx),
            "argocd/shop does not have a pod or workload named api-config. Its workloads are Deployment web/api.",
        );
    });
});

describe("get_change_history", () => {
    const fresh = {
        ...app,
        status: {
            history: [
                { id: 1, revision: "aaa", deployedAt: "2026-11-20T10:00:00Z", source: { repoURL: "https://git.test/shop.git", path: "deploy" }, initiatedBy: { username: "admin" } },
                { id: 2, revision: "bbb", deployedAt: "2026-11-21T10:00:00Z", source: { repoURL: "https://git.test/shop.git", path: "deploy" }, initiatedBy: { automated: true } },
                { id: 3, revision: "1.2.3", deployedAt: "2026-11-22T10:00:00Z", source: { repoURL: "https://charts.test", chart: "shop" } },
            ],
            operationState: {
                phase: "Failed",
                message: "one or more objects failed to apply",
                operation: { initiatedBy: { automated: true } },
                syncResult: {
                    revision: "1.2.3",
                    resources: [
                        { kind: "Service", namespace: "web", name: "api", status: "Synced", message: "configured" },
                        { kind: "Job", namespace: "web", name: "migrate", status: "Synced", hookType: "PreSync", hookPhase: "Failed", message: "Job has reached the specified backoff limit" },
                    ],
                },
            },
        },
    };

    it("describes each deployment newest first, and puts the failed hook first", async () => {
        const urls = argocd({
            "/applications/shop": () => json(fresh),
            "/revisions/bbb/metadata": () => json({ author: "Dev <dev@test>", date: "2026-11-21T09:00:00Z", message: "fix: raise the memory limit\n\nThe pod ran out of memory.", tags: [] }),
            "/revisions/1.2.3/chartdetails": () => json({ description: "Shop chart", home: "https://charts.test/shop" }),
        });
        const out = JSON.parse(await runBuiltInTool("get_change_history", { limit: "2" }, ctx));

        assert.deepEqual(out.deployments.map((d: any) => d.id), [3, 2]);
        assert.equal(out.deploymentsNotListed, 1);
        assert.deepEqual(out.deployments[0].sources[0].chartDetails, { description: "Shop chart", home: "https://charts.test/shop" });
        assert.equal(out.deployments[1].initiatedBy, "automated sync");
        assert.equal(out.deployments[1].sources[0].commit.message, "fix: raise the memory limit\n\nThe pod ran out of memory.");
        assert.equal(out.deployments[1].sources[0].commit.tags, undefined);
        assert.equal(out.lastOperation.phase, "Failed");
        assert.deepEqual(out.lastOperation.resources.map((r: any) => r.name), ["migrate", "api"]);
        assert.ok(urls.every((u) => u.searchParams.get("appNamespace") === "argocd"));
    });

    it("keeps the other deployments when one revision cannot be read", async () => {
        argocd({
            "/applications/shop": () => json(fresh),
            "/revisions/bbb/metadata": () => json({ message: "revision not found" }, 500),
            "/revisions/1.2.3/chartdetails": () => json({ description: "Shop chart" }),
        });
        const out = JSON.parse(await runBuiltInTool("get_change_history", {}, ctx));
        assert.match(out.deployments[1].sources[0].detailsError, /Revision metadata API returned 500/);
        assert.equal(out.deployments[0].sources[0].chartDetails.description, "Shop chart");
    });

    it("asks for each source of a multi-source deployment by index and history id", async () => {
        const urls = argocd({
            "/applications/shop": () => json({ ...app, status: { history: [{ id: 7, revisions: ["ccc", "4.5.6"], sources: [{ repoURL: "https://git.test/values.git" }, { repoURL: "https://charts.test", chart: "shop" }] }] } }),
            "/revisions/ccc/metadata": () => json({ author: "Dev", message: "values" }),
            "/revisions/4.5.6/chartdetails": () => json({ description: "Shop chart" }),
        });
        await runBuiltInTool("get_change_history", {}, ctx);
        const chart = urls.find((u) => u.pathname.endsWith("/chartdetails"))!.searchParams;
        assert.equal(chart.get("sourceIndex"), "1");
        assert.equal(chart.get("versionId"), "7");
    });

    it("counts the sync results it does not list", () => {
        const resources = Array.from({ length: 25 }, (_, i) => ({ kind: "ConfigMap", name: `c${i}`, status: "Synced" }));
        const op = summariseLastOperation({ phase: "Succeeded", syncResult: { resources } })!;
        assert.equal((op.resources as unknown[]).length, 20);
        assert.equal(op.resourcesNotListed, 5);
    });
});

describe("get_resource_diff", () => {
    const fresh = {
        ...app,
        status: {
            resources: [
                { group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "api", status: "OutOfSync" },
                { version: "v1", kind: "ConfigMap", namespace: "web", name: "api-config", status: "Synced" },
            ],
        },
    };

    it("reads the target state with the group Argo CD reports", async () => {
        const urls = argocd({
            "/applications/shop": () => json(fresh),
            "/managed-resources": () => json({ items: [{ targetState: '{"spec":{"replicas":3}}', normalizedLiveState: '{"spec":{"replicas":1}}' }] }),
        });
        const out = await runBuiltInTool("get_resource_diff", { kind: "Deployment", name: "api" }, ctx);

        const managed = urls.find((u) => u.pathname.endsWith("/managed-resources"))!.searchParams;
        assert.equal(managed.get("group"), "apps");
        assert.equal(managed.get("namespace"), "web");
        assert.match(out, /^Deployment web\/api: OutOfSync fields .*\nspec\.replicas: target 3, live 1$/s);
    });

    it("does not fetch the target state of a Synced resource", async () => {
        const urls = argocd({ "/applications/shop": () => json(fresh) });
        assert.equal(
            await runBuiltInTool("get_resource_diff", { kind: "ConfigMap", name: "api-config" }, ctx),
            "Argo CD reports ConfigMap web/api-config as Synced, so it does not have any OutOfSync fields.",
        );
        assert.equal(urls.length, 1);
    });

    it("names the OutOfSync resources when the name matches nothing", async () => {
        argocd({ "/applications/shop": () => json(fresh) });
        assert.equal(
            await runBuiltInTool("get_resource_diff", { kind: "Deployment", name: "web" }, ctx),
            "Argo CD does not manage a Deployment named web in argocd/shop. Its OutOfSync resources are Deployment web/api.",
        );
    });
});

describe("runBuiltInTool", () => {
    it("rejects a name that is not a built-in tool", async () => {
        await assert.rejects(runBuiltInTool("docs_search", {}, ctx), /docs_search is not a built-in tool/);
    });

    it("passes an Argo CD failure on as an error", async () => {
        argocd({ "/resource-tree": () => json({ error: "permission denied" }, 403) });
        await assert.rejects(runBuiltInTool("get_resource", { kind: "Service", name: "api" }, ctx), /Resource tree API returned 403/);
    });
});

describe("the /assistant page", () => {
    const shop = { ...app, status: { history: [], operationState: { phase: "Succeeded" } } };

    it("reads the Application a call names, fetching it once", async () => {
        const urls = argocd({ "/applications/shop": () => json(shop) });
        const out = JSON.parse(await runBuiltInTool("get_change_history", { application: "argocd/shop" }, anyCtx));
        assert.equal(out.lastOperation.phase, "Succeeded");
        assert.equal(urls.length, 1);
        assert.equal(urls[0].pathname, "/api/v1/applications/shop");
        assert.equal(urls[0].searchParams.get("appNamespace"), "argocd");
    });

    it("never reads the Application that only routes the proxy", async () => {
        const urls = argocd({ "/resource-tree": () => json(tree), "/applications/shop": () => json(shop) });
        await runBuiltInTool("get_logs", { application: "shop", name: "api-config" }, anyCtx);
        assert.ok(urls.every((u) => !u.pathname.includes("router")));
        assert.equal(urls[1].pathname, "/api/v1/applications/shop/resource-tree");
    });

    it("asks for the Application before calling Argo CD", async () => {
        const urls = argocd({});
        assert.equal(
            await runBuiltInTool("get_resource", { kind: "Service", name: "api" }, anyCtx),
            "Not run: application is required. Call list_applications for the names.",
        );
        assert.equal(urls.length, 0);
    });

    it("points the model at list_applications for a name Argo CD refuses", async () => {
        argocd({ "/applications/nope": () => json({ message: "permission denied" }, 403) });
        assert.equal(
            await runBuiltInTool("get_resource_diff", { application: "nope", kind: "Deployment", name: "api" }, anyCtx),
            "The user cannot read an Argo CD Application named nope, or it does not exist. Call list_applications for the names.",
        );
    });

    it("lists the Applications that need attention first", async () => {
        const urls = argocd({
            "/api/v1/applications": () => json({
                items: [
                    { metadata: { name: "web", namespace: "argocd" }, spec: { project: "default" }, status: { sync: { status: "Synced" }, health: { status: "Healthy" } } },
                    { metadata: { name: "api", namespace: "argocd" }, spec: { project: "team" }, status: { sync: { status: "OutOfSync" }, health: { status: "Degraded" } } },
                ],
            }),
        });
        assert.equal(
            await runBuiltInTool("list_applications", {}, anyCtx),
            "2 Applications, 1 of them OutOfSync or not Healthy, listed first:\n- argocd/api (project team): OutOfSync, Degraded\n- argocd/web (project default): Synced, Healthy",
        );
        assert.match(urls[0].searchParams.get("fields") ?? "", /items\.status\.sync\.status,items\.status\.health$/);
    });

    it("offers list_applications only where no Application is open", async () => {
        await assert.rejects(runBuiltInTool("list_applications", {}, ctx), /list_applications is not a built-in tool/);
    });
});
