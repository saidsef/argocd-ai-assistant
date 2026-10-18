// Accepted tool-call shapes: see docs/architecture.md#tool-call-formats.
const BAR = "[|｜]";
const SENTINEL_BODY_MAX = 32;
// DeepSeek puts a space after the sentinel: `<｜｜DSML｜｜ invoke name="x">`.
const SENTINEL = `(?:${BAR}{1,2}[^\\s<>"|｜]{0,${SENTINEL_BODY_MAX}}${BAR}{1,2} ?)?`;

// `tool` is the prompted tag. DeepSeek's native `invoke` sits in a `function_calls` or `calls` tag.
const CALL_TAG = "(?:tool|invoke)";
const WRAPPER_TAG = "(?:function_calls|calls)";

/** Regex source for an opening call tag, sentinel and all, up to but not including `name="..."`. */
export const TOOL_OPEN = `<${SENTINEL}${CALL_TAG}`;

/** Regex source for the tag a tool block starts with: a call tag or the wrapper around several. */
export const TOOL_MARKER = `<${SENTINEL}(?:${CALL_TAG}|${WRAPPER_TAG})`;

/** Longest text TOOL_MARKER can match, which bounds how much of a stream can be a partial tag. */
export const MAX_TOOL_MARKER = "<".length + 2 + SENTINEL_BODY_MAX + 2 + " ".length + "function_calls".length;

/** Regex source for a string that may still grow into a TOOL_MARKER as more text streams in. */
export const PARTIAL_TOOL_MARKER = `^<(?:${BAR}{1,2}[^\\s<>"|｜]{0,${SENTINEL_BODY_MAX}}(?:${BAR}{1,2} ?)?)?[a-z_]*$`;

// One element per argument, where `string="true"` marks a raw string and anything else is JSON.
const PARAM = new RegExp(`<${SENTINEL}parameter\\s+name="([^"]+)"([^>]*)>([\\s\\S]*?)</${SENTINEL}parameter>`, "g");
const STRAY_PARAM = new RegExp(`</?${SENTINEL}parameter\\b[^>]*>`, "g");

/** The structural subset of McpTool this module needs; McpTool is assignable to it. */
export interface ToolSpec {
    name: string;
    description?: string;
    inputSchema?: any;
}

export interface ToolCall {
    name: string;
    arguments: any;
}

/** Every tool call in a reply, in order, since a model may batch several into one reply. */
export function parseToolCalls(text: string, tools?: ToolSpec[]): ToolCall[] {
    // The closing tag must name the opening tag, though its sentinel may differ.
    const block = new RegExp(`<${SENTINEL}(tool|invoke)\\s+name="([^"]+)">\\s*([\\s\\S]*?)\\s*</${SENTINEL}\\1>`, "g");
    const calls: ToolCall[] = [];
    const seen = new Set<string>();
    let sawBlock = false;

    for (let xml = block.exec(text); xml; xml = block.exec(text)) {
        sawBlock = true;
        const name = xml[2];
        // Skips the prompt's own EXACT_TOOL_NAME template and tool syntax quoted in an answer.
        if (!tools || !tools.some(t => t.name === name)) continue;
        const args = parseArguments(xml[3]);
        // An identical repeat would spend a round trip on the result the first call returns.
        const key = JSON.stringify([name, args]);
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({ name, arguments: args });
    }

    // A block naming no available tool is still an attempt, so the JSON heuristic must not run.
    if (sawBlock) return calls;

    const bare = parseBareJsonCall(text, tools);
    return bare ? [bare] : [];
}

// The body of a call block: JSON, or the native form's `parameter` elements.
function parseArguments(body: string): any {
    const args: Record<string, any> = {};
    let named = false;
    for (const [, key, attrs, value] of body.matchAll(PARAM)) {
        named = true;
        if (/\bstring="true"/.test(attrs)) {
            args[key] = value;
            continue;
        }
        try {
            args[key] = JSON.parse(value);
        } catch (_e) {
            args[key] = value;
        }
    }
    if (named) return args;
    // A model mixing the two forms closes its JSON body with an unopened parameter tag.
    try {
        return JSON.parse(body.replace(STRAY_PARAM, "").trim());
    } catch (_e) {
        return {};
    }
}

/** The first tool call in `text`, or null when there is none. */
export function parseToolCall(text: string, tools?: ToolSpec[]): ToolCall | null {
    return parseToolCalls(text, tools)[0] ?? null;
}

// The model emitted a bare or fenced JSON object instead of the <tool> wrapper.
function parseBareJsonCall(text: string, tools?: ToolSpec[]): ToolCall | null {
    const json = extractJsonObject(text);
    if (!json || typeof json.value !== "object") return null;
    // A real call ends the reply, so prose after the object marks it as an example.
    if (text.slice(json.end).replace(/```/g, "").trim()) return null;
    const obj = json.value;

    // The object may name the tool explicitly.
    const named = obj.name ?? obj.tool;
    const namedArgs = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters;
    if (typeof named === "string" && namedArgs && typeof namedArgs === "object"
        && tools && tools.some(t => t.name === named)) {
        return { name: named, arguments: namedArgs };
    }

    // Otherwise infer the tool from the argument shape, and only when exactly one tool fits.
    if (tools && tools.length > 0) {
        const keys = Object.keys(obj);
        if (keys.length === 0) return null;
        const matches = tools.filter(t => argsFitSchema(keys, t.inputSchema));
        if (matches.length === 1) {
            return { name: matches[0].name, arguments: obj };
        }
    }
    return null;
}

// The first brace-balanced JSON object in `text` and the index just past it, or null.
export function extractJsonObject(text: string): { value: any; end: number } | null {
    const start = text.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                try { return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }; }
                catch (_e) { return null; }
            }
        }
    }
    return null;
}

// True when every provided arg key is a known schema property and all required props are set.
export function argsFitSchema(keys: string[], schema: any): boolean {
    if (keys.length === 0) return false;
    const props = schemaProperties(schema);
    if (!props) return false;
    const known = Object.keys(props);
    if (!keys.every(k => known.includes(k))) return false;
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    return required.every(r => keys.includes(r));
}

// A minimal example arguments object for the prompt, derived from a tool's schema.
export function exampleArgs(tool: ToolSpec): string {
    const schema = tool.inputSchema;
    const props = schemaProperties(schema) ?? {};
    const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
    const keys = required.length ? required : Object.keys(props).slice(0, 1);
    const obj: Record<string, any> = {};
    for (const k of keys) {
        const t = props[k]?.type;
        obj[k] = t === "integer" || t === "number" ? 1 : t === "boolean" ? true : "value";
    }
    return JSON.stringify(obj);
}

// A schema's `properties` map, or null when the schema declares none.
function schemaProperties(schema: any): Record<string, any> | null {
    const props = schema?.properties;
    if (!props || typeof props !== "object") return null;
    return Object.keys(props).length > 0 ? props : null;
}
