// Parsing for the tool-call wire format this extension prompts the model to emit:
// `<tool name="EXACT_TOOL_NAME">{ JSON arguments }</tool>` (authored in LlmProvider.buildMessages).
//
// Kept beside the provider that writes that prompt, and pure, so the parser and the template it
// mirrors stay in one place. Models frequently deviate from the template, hence the fallbacks below.

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

export function parseToolCall(text: string, tools?: ToolSpec[]): ToolCall | null {
    // Primary: a <tool name="X">{json}</tool> block anywhere in the reply (tolerate a preamble).
    const xml = text.match(/<tool\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/tool>/);
    if (xml) {
        const name = xml[1];
        // Only a real tool name is a call; this ignores the prompt's own name="EXACT_TOOL_NAME"
        // template and any <tool> syntax the model quotes inside a normal answer.
        if (!tools || !tools.some(t => t.name === name)) return null;
        try {
            return { name, arguments: JSON.parse(xml[2].trim()) };
        } catch (_e) {
            return { name, arguments: {} };
        }
    }

    // Fallback: the model emitted a bare or fenced JSON object instead of the wrapper.
    const json = extractJsonObject(text);
    if (!json || typeof json.value !== "object") return null;
    // A real bare-JSON call ends the model's turn; if prose follows the object it is incidental
    // JSON inside an answer, not a call, so ignore it (tolerate only a trailing ``` fence).
    if (text.slice(json.end).replace(/```/g, "").trim()) return null;
    const obj = json.value;

    // The object may name the tool explicitly.
    const named = obj.name ?? obj.tool;
    const namedArgs = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters;
    if (typeof named === "string" && namedArgs && typeof namedArgs === "object"
        && tools && tools.some(t => t.name === named)) {
        return { name: named, arguments: namedArgs };
    }

    // Otherwise infer the tool from the argument shape - only when exactly one tool fits, to
    // avoid guessing wrong (this recovers a nameless args object like {query, max_results}).
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

// Extract the first brace-balanced JSON object from arbitrary text (handles a ```json fence or
// a bare object amid prose), skipping braces inside strings. Returns the parsed value and the
// index just past its closing brace (so the caller can inspect what follows), or null.
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
