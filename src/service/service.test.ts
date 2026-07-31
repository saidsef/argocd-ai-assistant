import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summariseApplication } from "./application";
import { summariseEvents } from "./events";
import { getGroup, hasLogs, summariseLogs } from "./logs";

describe("getGroup", () => {
    it("splits the group off an apiVersion, and reports core resources as no group", () => {
        assert.equal(getGroup("apps/v1"), "apps");
        // Returning "v1" here made the logs API reject core-group non-Pod workloads.
        assert.equal(getGroup("v1"), "");
        assert.equal(getGroup(""), "");
    });
});

describe("hasLogs", () => {
    it("is true for Pods and for workloads with a pod template", () => {
        assert.equal(hasLogs({ kind: "Pod" }), true);
        assert.equal(hasLogs({ kind: "Deployment", spec: { template: { spec: { containers: [] } } } }), true);
        assert.equal(hasLogs({ kind: "Service", spec: {} }), false);
        assert.equal(hasLogs(undefined), false);
    });
});

describe("summariseLogs", () => {
    it("emits a header plus timestamped rows instead of the raw envelope", () => {
        const out = summariseLogs(
            [
                { timeStamp: "T1", content: "line one", podName: "web-abc" },
                { timeStamp: "T2", content: "line two", podName: "web-abc" },
            ] as any,
            "app"
        );
        assert.match(out, /^pod: web-abc, container: app, lines: 2\n/);
        assert.match(out, /T1 line one\nT2 line two/);
    });

    it("drops the empty-content sentinel the stream terminates with", () => {
        const out = summariseLogs([{ timeStamp: "T1", content: "real" }, { content: "" }] as any, "app");
        assert.match(out, /lines: 1/);
    });

    it("tolerates a non-array and missing fields", () => {
        assert.match(summariseLogs(undefined as any, "app"), /lines: 0/);
        assert.match(summariseLogs([{ content: "bare" }] as any), /\nbare/);
    });
});

describe("summariseEvents", () => {
    const events = [
        { type: "Normal", reason: "Pulled", message: "pulled image", count: 1, lastTimestamp: "2026-01-01T00:00:00Z", involvedObject: { kind: "Pod", name: "web" } },
        { type: "Warning", reason: "BackOff", message: "back-off restarting", count: 9, lastTimestamp: "2026-01-03T00:00:00Z", involvedObject: { kind: "Pod", name: "web" } },
        { type: "Normal", reason: "Created", message: "created", count: 1, lastTimestamp: "2026-01-02T00:00:00Z" },
    ];

    it("sorts newest first and reports the untruncated total", () => {
        const out = summariseEvents(events, 2);
        assert.equal(out.total, 3);
        assert.deepEqual(out.items.map((i) => i.reason), ["BackOff", "Created"]);
    });

    it("does not mutate the caller's array", () => {
        const input = [...events];
        summariseEvents(input, 2);
        assert.deepEqual(input.map((e) => e.reason), events.map((e) => e.reason));
    });

    it("formats involvedObject as kind/name and omits it when absent", () => {
        const out = summariseEvents(events, 3);
        assert.equal(out.items.find((i) => i.reason === "BackOff")?.object, "Pod/web");
        assert.equal(out.items.find((i) => i.reason === "Created")?.object, undefined);
    });

    it("caps one oversized message rather than letting it crowd out the rest", () => {
        const out = summariseEvents([{ reason: "Big", message: "x".repeat(5000), lastTimestamp: "T" }], 1);
        assert.ok(out.items[0].message!.length < 5000);
        assert.match(out.items[0].message!, /truncated/);
    });

    it("tolerates a non-array and missing fields", () => {
        assert.deepEqual(summariseEvents(undefined as any), { total: 0, items: [] });
        assert.equal(summariseEvents([{}]).items[0].reason, undefined);
    });
});

describe("summariseApplication", () => {
    const app = {
        metadata: { name: "web", namespace: "argocd" },
        spec: {
            project: "default",
            source: { repoURL: "https://charts", chart: "web", targetRevision: "1.2.3" },
            destination: { server: "https://k8s", namespace: "prod" },
            syncPolicy: { automated: { prune: true } },
        },
        status: {
            sync: { status: "OutOfSync", revision: "abc" },
            health: { status: "Degraded" },
            resources: [
                { kind: "Deployment", name: "web", status: "Synced", health: { status: "Healthy" } },
                { kind: "Deployment", name: "api", status: "OutOfSync", health: { status: "Degraded", message: "crash" } },
            ],
        },
    };

    it("returns null for anything that is not an Application object", () => {
        for (const value of [null, undefined, "x", 3, {}]) {
            assert.equal(summariseApplication(value), null);
        }
    });

    it("normalises a single source into the sources array", () => {
        const out = summariseApplication(app)!;
        assert.equal(out.sources.length, 1);
        assert.equal(out.sources[0].chart, "web");
        assert.equal(out.sync.targetRevision, "1.2.3");
    });

    it("prefers spec.sources when the app is multi-source", () => {
        const out = summariseApplication({ ...app, spec: { ...app.spec, sources: [{ chart: "a" }, { chart: "b" }] } })!;
        assert.deepEqual(out.sources.map((s) => s.chart), ["a", "b"]);
    });

    it("counts the whole resource list but only lists what needs attention", () => {
        const out = summariseApplication(app)!;
        assert.equal(out.resources.total, 2);
        assert.equal(out.resources.synced, 1);
        assert.equal(out.resources.outOfSyncCount, 1);
        assert.deepEqual(out.resources.outOfSync.map((r) => r.name), ["api"]);
        assert.deepEqual(out.resources.unhealthy.map((r) => r.name), ["api"]);
    });

    it("treats automated-without-enabled as automated, matching Argo CD's own default", () => {
        assert.equal(summariseApplication(app)!.syncPolicy.automated, true);
        assert.equal(summariseApplication({ ...app, spec: { ...app.spec, syncPolicy: { automated: {} } } })!.syncPolicy.automated, true);
        assert.equal(
            summariseApplication({ ...app, spec: { ...app.spec, syncPolicy: { automated: { enabled: false } } } })!.syncPolicy.automated,
            false
        );
        assert.equal(summariseApplication({ ...app, spec: { ...app.spec, syncPolicy: {} } })!.syncPolicy.automated, false);
    });

    it("survives an Application with no status at all", () => {
        const out = summariseApplication({ metadata: { name: "bare" } })!;
        assert.equal(out.name, "bare");
        assert.equal(out.resources.total, 0);
        assert.deepEqual(out.sources, []);
    });
});
