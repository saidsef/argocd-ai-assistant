import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetHistory, MAX_HISTORY_CHARS, MAX_HISTORY_TURN_CHARS } from "./context";
import { capText } from "./context";

const turns = (...sizes: number[]) => sizes.map((n, i) => ({ role: "user", content: String(i).repeat(n) }));
const total = (list: Array<{ content: string }>) => list.reduce((n, t) => n + t.content.length, 0);

describe("capText", () => {
    it("returns short text untouched", () => {
        assert.equal(capText("hello", 10, "a thing"), "hello");
        // Exactly at the cap is not truncation.
        assert.equal(capText("hello", 5, "a thing"), "hello");
    });

    it("keeps the start by default and announces the truncation", () => {
        const out = capText("abcdefghij", 4, "a manifest");
        assert.ok(out.startsWith("abcd"));
        assert.match(out, /\[truncated: showing 4 of 10 characters of a manifest\]/);
    });

    it("keeps the end for logs, where the recent lines carry the failure", () => {
        const out = capText("abcdefghij", 4, "container log", "end");
        assert.ok(out.endsWith("ghij"));
        assert.match(out, /\[truncated: showing 4 of 10 characters of container log\]/);
        // The marker leads, so the model reads "this is a fragment" before the fragment.
        assert.ok(out.indexOf("truncated") < out.indexOf("ghij"));
    });

    it("passes through non-string input rather than throwing", () => {
        assert.equal(capText(undefined as any, 4, "x"), undefined);
        assert.equal(capText(null as any, 4, "x"), null);
    });
});

describe("budgetHistory", () => {
    it("returns everything when the whole history fits", () => {
        const list = turns(10, 10, 10);
        assert.deepEqual(budgetHistory(list, 100), list);
    });

    it("drops the oldest turns first, keeping the newest", () => {
        // Recency is what the model needs; the opening turns are the disposable ones.
        const kept = budgetHistory(turns(30, 30, 30), 70);
        assert.equal(kept.length, 2);
        assert.deepEqual(kept.map((t) => t.content[0]), ["1", "2"]);
    });

    it("never exceeds the budget", () => {
        assert.ok(total(budgetHistory(turns(30, 30, 30), 70)) <= 70);
        assert.ok(total(budgetHistory(turns(50, 50, 50, 50), 120)) <= 120);
    });

    it("preserves order and does not truncate any turn's text", () => {
        // Half a question is worse than no question, so this drops whole turns only.
        const kept = budgetHistory(turns(30, 30, 30), 70);
        assert.ok(kept.every((t) => t.content.length === 30));
    });

    it("keeps the newest turn at the real caps, which is what the defaults guarantee", () => {
        const capped = Array.from({ length: 20 }, () => ({ role: "user", content: "x".repeat(MAX_HISTORY_TURN_CHARS) }));
        const kept = budgetHistory(capped);
        assert.ok(kept.length >= 1);
        assert.ok(total(kept) <= MAX_HISTORY_CHARS);
        // 20 x 4000 = 80,000 chars in; the cap is what stops that riding along on every request.
        assert.ok(total(kept) < total(capped));
    });

    it("handles an empty history", () => {
        assert.deepEqual(budgetHistory([], 100), []);
    });

    it("drops a single over-budget turn, since callers must cap turns first", () => {
        assert.deepEqual(budgetHistory(turns(500), 100), []);
    });
});
