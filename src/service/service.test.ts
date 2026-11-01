import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { summariseApplication } from "./application";
import { MAX_EVENTS, summariseEvents } from "./events";
import { MAX_EVENTS_CHARS } from "../util/context";
import { getGroup, getLogs, hasLogs, summariseLogs } from "./logs";
import { firstUnhealthy, hasPods, podsOf, summarisePods } from "./pods";

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

    it("names the pod on every line when the lines come from several pods", () => {
        const out = summariseLogs(
            [
                { timeStamp: "T1", content: "ok", podName: "web-a" },
                { timeStamp: "T2", content: "FATAL out of memory", podName: "web-c" },
                { content: "previous terminated container \"web\" in pod \"web-b\" not found", podName: "" },
            ] as any,
            "web"
        );
        assert.match(out, /^pods: web-a, web-c, container: web, lines: 3\n/);
        assert.match(out, /\nweb-a T1 ok\nweb-c T2 FATAL out of memory\nprevious terminated/);
    });
});

describe("getLogs", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    // Argo CD's merged stream: every pod's lines interleaved oldest first, then the sentinel.
    const stream = (pods: string[], perPod: number) => {
        const lines: string[] = [];
        for (let i = 0; i < perPod; i++) {
            for (const pod of pods) {
                lines.push(JSON.stringify({ result: { content: `${pod} line ${i}`, timeStamp: `T${i}`, podName: pod } }));
            }
        }
        lines.push(JSON.stringify({ result: { content: "", last: true, podName: "" } }));
        return lines.join("\n") + "\n";
    };

    const stub = (body: string) => {
        globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    };

    const app = { metadata: { name: "web", namespace: "argocd" }, spec: { project: "default" } };
    const deployment = { kind: "Deployment", apiVersion: "apps/v1", metadata: { name: "web", namespace: "default" } };

    it("keeps the newest lines across every pod of a workload", async () => {
        stub(stream(["web-a", "web-b", "web-c"], 5));
        const entries = await getLogs(app, deployment, "web", 5);
        assert.deepEqual(entries.map((e) => e.content), [
            "web-b line 3", "web-c line 3", "web-a line 4", "web-b line 4", "web-c line 4",
        ]);
    });

    it("drops the sentinel, so the count matches the lines attached", async () => {
        stub(stream(["web-a"], 3));
        const entries = await getLogs(app, deployment, "web", 5);
        assert.equal(entries.length, 3);
        assert.match(summariseLogs(entries, "web"), /^pod: web-a, container: web, lines: 3\n/);
    });
});

describe("pods of a workload", () => {
    const pod = (name: string, parent: string, health: string, info: Array<[string, string]>, message?: string) => ({
        kind: "Pod", name, namespace: "default", uid: `uid-${name}`,
        parentRefs: [{ kind: "ReplicaSet", uid: parent }],
        health: { status: health, ...(message ? { message } : {}) },
        info: info.map(([n, value]) => ({ name: n, value })),
    });
    const tree = {
        nodes: [
            { kind: "ReplicaSet", name: "web-7d9f", uid: "rs-new", parentRefs: [{ kind: "Deployment", uid: "deploy-web" }] },
            { kind: "ReplicaSet", name: "web-6c1a", uid: "rs-old", parentRefs: [{ kind: "Deployment", uid: "deploy-web" }] },
            pod("web-7d9f-def34", "rs-new", "Healthy", [["Status Reason", "Running"], ["Containers", "1/1"]]),
            pod("web-7d9f-abc12", "rs-new", "Degraded", [["Status Reason", "CrashLoopBackOff"], ["Containers", "0/1"], ["Restart Count", "14"]], "back-off 5m0s restarting failed container"),
            pod("web-6c1a-zzz99", "rs-old", "Progressing", [["Status Reason", "Terminating"], ["Containers", "1/1"]]),
            pod("api-1234-aaaaa", "rs-api", "Degraded", [["Status Reason", "Error"]]),
        ],
    };
    const deployment = { kind: "Deployment", metadata: { name: "web", uid: "deploy-web" }, spec: { template: { spec: { containers: [{ name: "web" }] } } } };

    it("finds every pod below a workload through its ReplicaSets, unhealthy first", () => {
        const pods = podsOf(tree, deployment);
        assert.deepEqual(pods.map((p) => p.name), ["web-6c1a-zzz99", "web-7d9f-abc12", "web-7d9f-def34"]);
        assert.equal(pods.find((p) => p.name === "web-7d9f-abc12")?.restarts, 14);
        // Argo CD leaves the restart count out when it is zero.
        assert.equal(pods.find((p) => p.name === "web-7d9f-def34")?.restarts, 0);
        assert.equal(firstUnhealthy(pods)?.name, "web-6c1a-zzz99");
    });

    it("writes one line per pod with its health, status reason, containers and restarts", () => {
        const out = summarisePods("Deployment/web", podsOf(tree, deployment));
        assert.match(out, /^Pods of Deployment\/web \(3\):\n/);
        assert.match(out, /\n- web-7d9f-abc12 Degraded, Status Reason: CrashLoopBackOff, Containers: 0\/1, Restart Count: 14, Message: back-off 5m0s restarting failed container\n/);
        assert.match(out, /\n- web-7d9f-def34 Healthy, Status Reason: Running, Containers: 1\/1, Restart Count: 0$/);
    });

    it("lists a fixed number of pods however many the workload has", () => {
        const many = Array.from({ length: 50 }, (_, i) => ({ name: `web-${i}`, health: "Healthy", restarts: 0 }));
        const lines = summarisePods("Deployment/web", many, undefined, 5).split("\n");
        assert.equal(lines.length, 1 + 5 + 1);
        assert.equal(lines[lines.length - 1], "- 45 more pods not listed");
    });

    it("adds the events of the first unhealthy pod, or says why they are missing", () => {
        const pods = podsOf(tree, deployment);
        const events = [{ type: "Warning", reason: "BackOff", message: "Back-off restarting failed container", lastTimestamp: "T" }];
        assert.match(summarisePods("Deployment/web", pods, { pod: "web-7d9f-abc12", items: events }), /Events of pod web-7d9f-abc12, most recent first:\n\{"total":1,"items":\[\{"type":"Warning","reason":"BackOff"/);
        assert.match(summarisePods("Deployment/web", pods, { pod: "web-7d9f-abc12", error: "Pod events API returned 403 Forbidden" }), /Events of pod web-7d9f-abc12 could not be fetched \(Pod events API returned 403 Forbidden\)\.$/);
    });

    it("says when the tree shows no pods", () => {
        assert.equal(summarisePods("Deployment/web", []), "The Argo CD resource tree shows no pods for Deployment/web.");
        assert.deepEqual(podsOf({ nodes: null }, deployment), []);
        assert.deepEqual(podsOf(tree, { kind: "Deployment", metadata: {} }), []);
    });

    it("attaches pods only for a resource with a pod template", () => {
        assert.equal(hasPods(deployment), true);
        assert.equal(hasPods({ kind: "CronJob", spec: { jobTemplate: { spec: { template: { spec: { containers: [] } } } } } }), true);
        assert.equal(hasPods({ kind: "Pod", spec: { containers: [] } }), false);
        assert.equal(hasPods({ kind: "Service", spec: {} }), false);
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

    it("names the container an event concerns, from involvedObject.fieldPath", () => {
        const out = summariseEvents([
            { reason: "Created", lastTimestamp: "T3", involvedObject: { kind: "Pod", name: "web", fieldPath: "spec.containers{app}" } },
            { reason: "Pulled", lastTimestamp: "T2", involvedObject: { kind: "Pod", name: "web", fieldPath: "spec.initContainers{migrate}" } },
            { reason: "Scheduled", lastTimestamp: "T1", involvedObject: { kind: "Pod", name: "web" } },
        ], 3);
        assert.equal(out.items.find((i) => i.reason === "Created")?.container, "app");
        assert.equal(out.items.find((i) => i.reason === "Pulled")?.container, "migrate");
        assert.equal(out.items.find((i) => i.reason === "Scheduled")?.container, undefined);
    });

    it("ignores a fieldPath that names no container", () => {
        assert.equal(summariseEvents([{ involvedObject: { fieldPath: "spec.containers" } }]).items[0].container, undefined);
        assert.equal(summariseEvents([{ involvedObject: { fieldPath: 42 } }]).items[0].container, undefined);
        assert.equal(summariseEvents([{ involvedObject: { fieldPath: "spec.containers{}" } }]).items[0].container, undefined);
    });

    it("carries firstTimestamp only for a repeated event, so count reads as a rate", () => {
        const out = summariseEvents([
            { reason: "BackOff", count: 47, firstTimestamp: "2026-01-01T00:00:00Z", lastTimestamp: "2026-01-01T00:03:00Z" },
            { reason: "Pulled", count: 1, firstTimestamp: "2026-01-01T00:00:00Z", lastTimestamp: "2026-01-01T00:00:00Z" },
        ], 2);
        assert.equal(out.items.find((i) => i.reason === "BackOff")?.first, "2026-01-01T00:00:00Z");
        assert.equal(out.items.find((i) => i.reason === "Pulled")?.first, undefined);
    });

    it("reports the source component and host, falling back to the reporting pair", () => {
        const out = summariseEvents([
            { reason: "Pulled", lastTimestamp: "T2", source: { component: "kubelet", host: "spot" }, reportingComponent: "ignored", reportingInstance: "ignored" },
            { reason: "Sync", lastTimestamp: "T1", source: {}, reportingComponent: "argocd-application-controller", reportingInstance: "controller-0" },
        ], 2);
        const pulled = out.items.find((i) => i.reason === "Pulled");
        assert.equal(pulled?.component, "kubelet");
        assert.equal(pulled?.host, "spot");
        const sync = out.items.find((i) => i.reason === "Sync");
        assert.equal(sync?.component, "argocd-application-controller");
        assert.equal(sync?.host, "controller-0");
        assert.equal(summariseEvents([{}]).items[0].component, undefined);
    });

    it("distils a real kubelet pod event without dropping the fields an answer cites", () => {
        // Captured from the Argo CD events API, so a field dropped from the summary fails here
        // rather than in a wrong answer.
        const out = summariseEvents([{
            metadata: { name: "web.18d19625bdf17870", namespace: "web", creationTimestamp: "2026-09-02T19:00:15Z", managedFields: [{ manager: "kubelet" }] },
            involvedObject: { kind: "Pod", namespace: "web", name: "web-7676f6dc8f-p6r2m", uid: "445af99b", apiVersion: "v1", resourceVersion: "1061817", fieldPath: "spec.containers{drawio}" },
            reason: "Pulled",
            message: 'Container image "registry/saidsef:tag" already present on machine and can be accessed by the pod',
            source: { component: "kubelet", host: "spot" },
            firstTimestamp: "2026-09-02T19:00:15Z",
            lastTimestamp: "2026-09-02T19:00:15Z",
            count: 1,
            type: "Normal",
            eventTime: null,
            reportingComponent: "kubelet",
            reportingInstance: "spot",
        }], 1);
        assert.deepEqual(out, {
            total: 1,
            items: [{
                type: "Normal",
                reason: "Pulled",
                message: 'Container image "registry/saidsef:tag" already present on machine and can be accessed by the pod',
                count: 1,
                first: undefined,
                last: "2026-09-02T19:00:15Z",
                object: "Pod/web-7676f6dc8f-p6r2m",
                container: "drawio",
                component: "kubelet",
                host: "spot",
            }],
        });
    });

    it("keeps a full page of events inside the events character cap", () => {
        const busy = Array.from({ length: MAX_EVENTS }, (_, i) => ({
            type: "Warning",
            reason: "FailedScheduling",
            message: "0/12 nodes are available: 12 Insufficient cpu. preemption: 0/12 nodes are available.",
            count: 47,
            firstTimestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
            lastTimestamp: `2026-01-02T00:${String(i).padStart(2, "0")}:00Z`,
            involvedObject: { kind: "Pod", name: `workload-with-a-long-name-7676f6dc8f-p6r${i}`, fieldPath: "spec.containers{application}" },
            source: { component: "default-scheduler", host: "ip-10-0-128-200.eu-west-1.compute.internal" },
        }));
        const serialised = JSON.stringify(summariseEvents(busy, MAX_EVENTS));
        assert.ok(serialised.length < MAX_EVENTS_CHARS, `events summary was ${serialised.length} chars`);
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
