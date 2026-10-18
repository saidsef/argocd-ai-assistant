// Native tool calling on the Chat Completions endpoint: `tools` on the request, `tool_calls` in the
// stream. See docs/architecture.md#tool-calling-modes.

import type { ChatMessage, ChatToolCall, ToolCallingMode } from "../model/provider";
import type { McpTool } from "./mcpClient";
import { resultsNote } from "./mcpPrompt";

// OpenAI's function-name rule. MCP tool names are not held to it.
const MAX_NAME_CHARS = 64;
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9_-]/g;

/** The `toolCalling` setting. Anything but "native" or "text" means "auto". */
export function toolCallingSetting(value: unknown): "auto" | ToolCallingMode {
    return value === "native" || value === "text" ? value : "auto";
}

/** True when a request that carried `tools` may have failed because of them. */
export function toolsRejected(status: number | undefined): boolean {
    return status === 400 || status === 422;
}

export interface ChatTools {
    /** The request's `tools` array. */
    tools: any[];
    /** Each name as sent, mapped back to its MCP tool. */
    byName: Map<string, McpTool>;
}

/** MCP tools in the request's `tools` format, with names a provider will accept. */
export function toChatTools(mcpTools: McpTool[]): ChatTools {
    const byName = new Map<string, McpTool>();
    const tools = mcpTools.map(tool => {
        const name = uniqueName(tool.name.replace(UNSAFE_NAME_CHARS, "_").slice(0, MAX_NAME_CHARS) || "tool", byName);
        byName.set(name, tool);
        return {
            type: "function",
            function: {
                name,
                ...(tool.description ? { description: tool.description } : {}),
                parameters: objectSchema(tool.inputSchema),
            },
        };
    });
    return { tools, byName };
}

function uniqueName(base: string, taken: Map<string, unknown>): string {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const suffix = `_${n}`;
        const candidate = base.slice(0, MAX_NAME_CHARS - suffix.length) + suffix;
        if (!taken.has(candidate)) return candidate;
    }
}

// Function parameters are a JSON Schema object, so a missing or partial schema is completed as one.
function objectSchema(schema: any): any {
    const s = schema && typeof schema === "object" && !Array.isArray(schema) ? { ...schema } : {};
    if (!s.type) s.type = "object";
    if (s.type === "object" && (!s.properties || typeof s.properties !== "object")) s.properties = {};
    return s;
}

export interface ToolCallAccumulator {
    /** Feed one chunk's `delta.tool_calls`. */
    push(deltas: unknown): void;
    /** The calls so far, each with an id, a type and an arguments string. */
    calls(): ChatToolCall[];
}

/** Joins streamed `delta.tool_calls` fragments into whole calls, keeping every field a provider sends. */
export function createToolCallAccumulator(): ToolCallAccumulator {
    const slots: any[] = [];
    const byIndex = new Map<number, any>();
    const byId = new Map<string, any>();

    const open = (index: unknown, id: unknown) => {
        const slot = { function: { name: "", arguments: "" } };
        slots.push(slot);
        if (typeof index === "number") byIndex.set(index, slot);
        if (typeof id === "string" && id) byId.set(id, slot);
        return slot;
    };

    return {
        push(deltas: unknown) {
            if (!Array.isArray(deltas)) return;
            for (const delta of deltas) {
                if (!delta || typeof delta !== "object") continue;
                const { index, id, function: fn, ...rest } = delta as any;
                let slot = typeof index === "number" ? byIndex.get(index) : typeof id === "string" ? byId.get(id) : slots[slots.length - 1];
                // A new id at a used index is a new call, not a continuation.
                if (slot && typeof id === "string" && id && slot.id && slot.id !== id) slot = undefined;
                slot = slot ?? open(index, id);
                if (typeof id === "string" && id) {
                    slot.id = id;
                    byId.set(id, slot);
                }
                Object.assign(slot, rest);
                if (fn && typeof fn === "object") {
                    const { name, arguments: args, ...fnRest } = fn;
                    Object.assign(slot.function, fnRest);
                    if (typeof name === "string" && name && !slot.function.name) slot.function.name = name;
                    if (typeof args === "string") slot.function.arguments += args;
                    else if (args && typeof args === "object") slot.function.arguments = JSON.stringify(args);
                }
            }
        },
        calls(): ChatToolCall[] {
            return slots.map((slot, i) => ({
                ...slot,
                id: slot.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`,
                type: slot.type || "function",
                function: { ...slot.function, arguments: slot.function.arguments || "{}" },
            }));
        },
    };
}

/** A call's arguments string as an object, or the reason it is not one. */
export function parseArguments(raw: string | undefined): { value?: Record<string, any>; error?: string } {
    if (!raw || !raw.trim()) return { value: {} };
    try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) return { value };
        return { error: "the arguments are not a JSON object" };
    } catch (_e) {
        return { error: "the arguments are not valid JSON" };
    }
}

/**
 * A native exchange rewritten in the text protocol, for a backend that rejects `tools` partway
 * through a query. Each call becomes a `<tool>` block and each run of results one user note.
 */
export function toTextMessages(messages: ChatMessage[], byName: Map<string, McpTool>): ChatMessage[] {
    const out: ChatMessage[] = [];
    const names = new Map<string, string>();
    let notes: string[] = [];
    const flush = () => {
        if (notes.length) out.push({ role: "user", content: resultsNote(notes) });
        notes = [];
    };
    for (const message of messages) {
        if (message.role === "tool") {
            notes.push(`Tool result for ${names.get(message.tool_call_id) ?? "a tool"}:\n${message.content}`);
            continue;
        }
        flush();
        if (message.role === "assistant" && message.tool_calls?.length) {
            const blocks = message.tool_calls.map(call => {
                const name = byName.get(call.function?.name)?.name ?? call.function?.name ?? "";
                names.set(call.id, name);
                return `<tool name="${name}">${call.function?.arguments || "{}"}</tool>`;
            });
            out.push({ role: "assistant", content: [message.content, ...blocks].filter(Boolean).join("\n") });
            continue;
        }
        out.push(message);
    }
    flush();
    return out;
}
