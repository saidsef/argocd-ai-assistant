// Keep raw `<tool ...>` XML out of the UI while a completion streams.
//
// A tool block is internal: the visible answer comes from a later completion, and streaming the
// block would corrupt the cumulative deltas the UI derives (see ChatInterface's transport). So the
// filter forwards any preamble once and then withholds everything from the first marker onward.
//
// The marker is the opening tag of ./toolCall's wire format - `<tool`, or the same name behind a
// model's own sentinel tokens - followed by whitespace or ">". Never a bare word boundary: the
// latter transiently matches "...<tool" mid-stream, so <toolbar> / <toolkit> in prose would get
// their tail wrongly hidden.
//
// Scanning is incremental. The caller feeds cumulative text, so re-running a regex (and a
// lastIndexOf) over the whole reply on every SSE delta is O(n^2) in the answer length - and the
// lastIndexOf is worst-case on the common input, prose containing no "<" at all. Instead we keep
// `scanFrom`, the index below which no complete *or partial* marker can begin, and only ever look
// forward from there.

import { MAX_TOOL_OPEN, TOOL_OPEN } from "./toolCall";

export interface ToolMarkerFilter {
    /**
     * Feed the cumulative reply text (each call must extend the previous call's text). Returns the
     * text safe to display so far, or null when there is nothing to emit. The returned value is
     * cumulative and append-only, except for one trailing-whitespace trim when a marker is found.
     */
    push(text: string): string | null;
    /** True once a marker has been seen; from then on push() always returns null. */
    readonly suppressed: boolean;
}

export function createToolMarkerFilter(): ToolMarkerFilter {
    // Per instance, not module-level: `lastIndex` is mutable state on the RegExp, so a shared one
    // would let a stale index from another stream skip past a marker and leak raw XML into the UI.
    const marker = new RegExp(`${TOOL_OPEN}[\\s>]`, "g");
    let scanFrom = 0;
    let suppressed = false;

    return {
        get suppressed() {
            return suppressed;
        },
        push(text: string): string | null {
            if (suppressed) return null;

            // exec() mutates lastIndex, so always re-seed it and never read it back.
            marker.lastIndex = scanFrom;
            const m = marker.exec(text);
            if (m) {
                suppressed = true;
                return text.slice(0, m.index).trimEnd() || null;
            }

            // A trailing "<" with no whitespace or ">" after it may begin a marker whose delimiter
            // has not streamed yet. Withhold it - downstream deltas are append-only, so a "<" shown
            // now could never be retracted once we learn it began a (suppressed) block - and resume
            // the next scan from it.
            //
            // Only the last MAX_TOOL_OPEN characters are examined, which keeps the work per delta
            // constant. A "<" further back than that is already followed by every character a marker
            // could contain, so the scan above would have matched it had it been one.
            const from = Math.max(scanFrom, text.length - MAX_TOOL_OPEN);
            const tail = text.slice(from);
            const open = tail.lastIndexOf("<");
            scanFrom = open >= 0 && !/[\s>]/.test(tail.slice(open)) ? from + open : text.length;
            return text.slice(0, scanFrom) || null;
        },
    };
}
