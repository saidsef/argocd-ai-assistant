import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolMarkerFilter } from "./toolMarker";

// One character per push, the worst case for the incremental scan, returning the last emission.
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

    it("hides a native DSML call from its wrapper onward", () => {
        const reply = 'Checking.\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="docs_get_current_date_time">\n{}</｜｜DSML｜｜ parameter>';
        const { emitted, suppressed } = stream(reply);
        assert.equal(emitted, "Checking.");
        assert.equal(suppressed, true);
    });

    it("hides the unspaced function_calls wrapper too", () => {
        const { emitted, suppressed } = stream('<｜DSML｜function_calls>\n<｜DSML｜invoke name="x">');
        assert.equal(emitted, null);
        assert.equal(suppressed, true);
    });

    it("emits prose unchanged and stays unsuppressed", () => {
        const text = "The Deployment is out of sync; compare 2 < 3 and <toolbar> in the UI.";
        const { emitted, suppressed } = stream(text);
        assert.equal(emitted, text);
        assert.equal(suppressed, false);
    });

    it("never emits a character it has not seen, and only ever appends", () => {
        const text = 'Checking <toolkit>, <｜x｜ y> and <a href> now.\n<｜｜DSML｜｜ calls>\n<tool name="x">{}</tool>';
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
        // A "<" further back than the longest possible tag cannot start one.
        const text = `<${"｜".repeat(80)}not-a-tool and then prose`;
        const { emitted, suppressed } = stream(text);
        assert.equal(emitted, text);
        assert.equal(suppressed, false);
    });
});
