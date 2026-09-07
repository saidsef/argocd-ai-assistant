import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolMarkerFilter } from "./toolMarker";

// Feed `text` one character at a time, the worst case for the incremental scan, and report the last
// non-null emission. Real deltas are larger, so a filter that is correct here is correct for them.
function stream(text: string): { emitted: string | null; suppressed: boolean } {
    const filter = createToolMarkerFilter();
    let emitted: string | null = null;
    for (let i = 1; i <= text.length; i++) {
        const out = filter.push(text.slice(0, i));
        if (out !== null) emitted = out;
    }
    return { emitted, suppressed: filter.suppressed };
}

describe("createToolMarkerFilter", () => {
    it("forwards the preamble and hides the block from the marker onward", () => {
        const { emitted, suppressed } = stream('Let me look.\n<tool name="docs_search">{"query":"a"}</tool>');
        assert.equal(emitted, "Let me look.");
        assert.equal(suppressed, true);
    });

    it("hides a block wrapped in a model's own tool-call sentinel", () => {
        const { emitted, suppressed } = stream('One moment.\n<｜｜DSML｜｜tool name="docs_search">{"query":"a"}</｜｜DSML｜｜tool>');
        assert.equal(emitted, "One moment.");
        assert.equal(suppressed, true);
    });

    it("emits prose unchanged and stays unsuppressed", () => {
        const text = "The Deployment is out of sync; compare 2 < 3 and <toolbar> in the UI.";
        const { emitted, suppressed } = stream(text);
        assert.equal(emitted, text);
        assert.equal(suppressed, false);
    });

    it("never emits a character it has not seen, and only ever appends", () => {
        const text = 'Checking <toolkit> now.\n<tool name="x">{}</tool>';
        const filter = createToolMarkerFilter();
        let previous = "";
        for (let i = 1; i <= text.length; i++) {
            const out = filter.push(text.slice(0, i));
            if (out === null) continue;
            assert.ok(text.startsWith(out), `emitted text not a prefix of the input: ${out}`);
            assert.ok(out.startsWith(previous) || filter.suppressed, "emission was not append-only");
            previous = out;
        }
    });

    it("returns null for every push once suppressed", () => {
        const filter = createToolMarkerFilter();
        filter.push('<tool name="x">');
        assert.equal(filter.suppressed, true);
        assert.equal(filter.push('<tool name="x">{}</tool> trailing'), null);
    });

    it("keeps a long unbroken fragment out of the reply only while it could still be a marker", () => {
        // A "<" further back than the longest possible tag cannot be one, so it must be released
        // rather than withheld for the rest of the stream.
        const text = `<${"｜".repeat(80)}not-a-tool and then prose`;
        const { emitted, suppressed } = stream(text);
        assert.equal(emitted, text);
        assert.equal(suppressed, false);
    });
});
