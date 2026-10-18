// Hides a streaming tool block from the UI: see docs/architecture.md#tool-blocks-in-the-stream.

import { MAX_TOOL_MARKER, PARTIAL_TOOL_MARKER, TOOL_MARKER } from "./toolCall";

export interface ToolMarkerFilter {
    /** Takes the cumulative reply and returns the append-only text safe to show, or null. */
    push(text: string): string | null;
    /** True once a marker has been seen; from then on push() always returns null. */
    readonly suppressed: boolean;
}

export function createToolMarkerFilter(): ToolMarkerFilter {
    // Per instance, since a shared RegExp's stale lastIndex could skip past a marker.
    const marker = new RegExp(`${TOOL_MARKER}[\\s>]`, "g");
    const partial = new RegExp(PARTIAL_TOOL_MARKER);
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

            // Hold back a trailing "<" that may become a marker, as shown text cannot be retracted.
            const from = Math.max(scanFrom, text.length - MAX_TOOL_MARKER);
            const tail = text.slice(from);
            const open = tail.lastIndexOf("<");
            scanFrom = open >= 0 && partial.test(tail.slice(open)) ? from + open : text.length;
            return text.slice(0, scanFrom) || null;
        },
    };
}
