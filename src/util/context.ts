// Byte ceilings for everything that goes into a prompt.
//
// The distillers in service/ already cap by *item* count (MAX_EVENTS, MAX_LIST, MAX_LINES), but an
// item has no size limit: one ConfigMap with an embedded file, one 8KB log line, or one MCP tool
// result can be larger than the whole rest of the prompt and blow the backend's context window. These
// caps are the missing dimension. Truncation is always announced in the text so the model knows it is
// looking at a fragment rather than silently reasoning over a half-manifest.
//
// Sized in characters (roughly 4 characters per token for JSON/YAML). The attachment ceilings below
// are *per-item*: they bound how large one entry can be, not how many there are. The worst case
// stacks manifest + app summary + events + log (72k chars) plus the roster (2k) and a tool result
// (16k). History used to be the largest term of all and the only one that grew on its own - bounded
// by turn count but not by size, it re-sent MAX_HISTORY_MESSAGES x MAX_HISTORY_TURN_CHARS = 80k
// chars on every request - so it now has an aggregate cap of its own (MAX_HISTORY_CHARS, applied by
// budgetHistory below). That brings the worst case to ~114k chars, roughly 28k tokens.
//
// In practice attachments are far smaller than their ceilings (a real Application summary is ~1.3k
// chars against a 12k cap), so the caps only bite on outliers: one ConfigMap with an embedded file,
// one 8KB log line, one enormous admission-webhook message.

export const MAX_MANIFEST_CHARS = 24000;
export const MAX_APP_SUMMARY_CHARS = 12000;
export const MAX_EVENTS_CHARS = 12000;
export const MAX_LOG_CHARS = 24000;
export const MAX_TOOL_RESULT_CHARS = 16000;
export const MAX_HISTORY_TURN_CHARS = 4000;
// Aggregate ceiling for the conversation history in one request. MAX_HISTORY_TURN_CHARS bounds a
// single turn; nothing bounded their sum, and history is the one part of the prompt that grows
// without the user attaching anything. Kept >= MAX_HISTORY_TURN_CHARS so a single capped turn always
// fits, which is what guarantees the newest turn survives.
export const MAX_HISTORY_CHARS = 24000;
// The MCP server roster. Unlike the caps above this one is not about a single oversized item: it
// bounds a list that grows with the deployment (twelve servers exposing 200 tools each would be
// ~5.5KB on every request), and it is sent whether or not the user is using MCP at all.
export const MAX_MCP_ROSTER_CHARS = 2000;

/**
 * Trim `text` to `max` characters, appending a note naming what was cut. Keeps the *end* of logs
 * (the most recent lines carry the failure) and the *start* of everything else (a manifest's opening
 * fields identify it; a truncated tail is still useful context).
 */
export function capText(text: string, max: number, what: string, keep: "start" | "end" = "start"): string {
    if (typeof text !== "string" || text.length <= max) return text;
    const marker = `\n[truncated: showing ${max} of ${text.length} characters of ${what}]`;
    return keep === "end"
        ? marker + "\n" + text.slice(text.length - max)
        : text.slice(0, max) + marker;
}

/**
 * Trim conversation turns to an aggregate character budget, dropping the *oldest* first.
 *
 * Unlike capText this never truncates a turn's text: half a question is worse than no question, and
 * the caller has already bounded each turn with capText. Callers must do that first - a single turn
 * larger than `max` cannot fit and is dropped along with everything before it.
 */
export function budgetHistory<T extends { content: string }>(turns: T[], max: number = MAX_HISTORY_CHARS): T[] {
    let budget = max;
    let first = turns.length;
    while (first > 0 && turns[first - 1].content.length <= budget) {
        first--;
        budget -= turns[first].content.length;
    }
    return turns.slice(first);
}
