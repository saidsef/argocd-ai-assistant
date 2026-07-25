// Byte ceilings for everything that goes into a prompt.
//
// The distillers in service/ already cap by *item* count (MAX_EVENTS, MAX_LIST, MAX_LINES), but an
// item has no size limit: one ConfigMap with an embedded file, one 8KB log line, or one MCP tool
// result can be larger than the whole rest of the prompt and blow the backend's context window. These
// caps are the missing dimension. Truncation is always announced in the text so the model knows it is
// looking at a fragment rather than silently reasoning over a half-manifest.
//
// Sized in characters (roughly 4 characters per token for JSON/YAML), so the defaults below total
// ~20k tokens of context in the worst case, leaving room for the conversation in a 32k window.

export const MAX_MANIFEST_CHARS = 24000;
export const MAX_APP_SUMMARY_CHARS = 12000;
export const MAX_EVENTS_CHARS = 12000;
export const MAX_LOG_CHARS = 24000;
export const MAX_TOOL_RESULT_CHARS = 16000;
export const MAX_HISTORY_TURN_CHARS = 4000;

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
