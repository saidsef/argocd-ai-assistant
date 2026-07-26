// Keep raw `<tool ...>` XML out of the UI while a completion streams.
//
// A tool block is internal: the visible answer comes from a later completion, and streaming the
// block would corrupt the cumulative deltas the UI derives (see ChatInterface's transport). So the
// filter forwards any preamble once and then withholds everything from the first marker onward.
//
// The marker is `<tool` followed by whitespace or ">" (the prompt's `<tool name="...">` shape),
// never a bare word boundary: the latter transiently matches "...<tool" mid-stream, so <toolbar> /
// <toolkit> in prose would get their tail wrongly hidden.
//
// Scanning is incremental. The caller feeds cumulative text, so re-running a regex (and a
// lastIndexOf) over the whole reply on every SSE delta is O(n^2) in the answer length - and the
// lastIndexOf is worst-case on the common input, prose containing no "<" at all. Instead we keep
// `scanFrom`, the index below which no complete *or partial* marker can begin, and only ever look
// forward from there.

const MARKER = "<tool";

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
    const marker = /<tool[\s>]/g;
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

            // A trailing "<", "<t", "<to", "<too" or "<tool" may begin a marker whose delimiter has
            // not streamed yet. Withhold it - downstream deltas are append-only, so a "<" shown now
            // could never be retracted once we learn it began a (suppressed) block - and resume the
            // next scan from it. A full match is 6 characters, so its longest proper prefix is
            // MARKER itself: 5 characters is the exact bound on what can be pending.
            let hold = 0;
            for (let k = Math.min(MARKER.length, text.length); k >= 1; k--) {
                if (MARKER.startsWith(text.slice(text.length - k))) {
                    hold = k;
                    break;
                }
            }
            scanFrom = text.length - hold;
            return text.slice(0, scanFrom) || null;
        },
    };
}
