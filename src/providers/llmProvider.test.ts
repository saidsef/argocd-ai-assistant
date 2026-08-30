import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AssistantSettings, AttachmentType, ChatTurn, QueryContext } from "../model/provider";
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURN_CHARS } from "../util/context";
import { chatCompletionsUrl, DEFAULT_SYSTEM_PROMPT, emptyReplyMessage, LlmProvider, modelChoiceMessage, modelsUrl, parseModelList } from "./llmProvider";

// Stub the chat-completions endpoint and hand back the request body the provider actually sent, so
// prompt assembly is asserted on the wire rather than through a private method.
function captureRequest(): { body: () => any } {
    let captured: any;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body));
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`));
                controller.close();
            },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    return { body: () => captured };
}

describe("chatCompletionsUrl", () => {
    it("accepts a base URL with or without the version segment", () => {
        // Every documented example includes /v1, which used to produce /v1/v1/chat/completions -> 404.
        assert.equal(chatCompletionsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
        assert.equal(chatCompletionsUrl("https://api.openai.com"), "https://api.openai.com/v1/chat/completions");
        assert.equal(chatCompletionsUrl("http://ollama:11434/v1/"), "http://ollama:11434/v1/chat/completions");
        assert.equal(chatCompletionsUrl("http://host//"), "http://host/v1/chat/completions");
    });

    it("only strips a trailing /v1, not one in the middle of a path", () => {
        assert.equal(chatCompletionsUrl("https://gw.example.com/v1/openai"), "https://gw.example.com/v1/openai/v1/chat/completions");
    });
});

describe("modelsUrl", () => {
    it("resolves the same roots chatCompletionsUrl does", () => {
        assert.equal(modelsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
        assert.equal(modelsUrl("http://ollama:11434"), "http://ollama:11434/v1/models");
        assert.equal(modelsUrl("http://host//"), "http://host/v1/models");
    });
});

describe("parseModelList", () => {
    it("reads the ids out of an OpenAI-shaped body", () => {
        assert.deepEqual(parseModelList({ object: "list", data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
    });

    it("drops anything that is not a usable name", () => {
        // This runs against whatever a deployment points at, so a junk entry must not reach a
        // completion request or an error message as a model name.
        assert.deepEqual(parseModelList({ data: [{ id: "a" }, { id: "" }, { id: 7 }, null, "b"] }), ["a", "b"]);
    });

    it("returns nothing for a body that is not a model list", () => {
        assert.deepEqual(parseModelList({}), []);
        assert.deepEqual(parseModelList({ data: "nope" }), []);
        assert.deepEqual(parseModelList(undefined), []);
    });
});

describe("modelChoiceMessage", () => {
    it("names what the backend offered so a name can be copied out of it", () => {
        const message = modelChoiceMessage(["llama3", "mistral"]);
        assert.match(message, /llama3, mistral/);
        assert.match(message, /argocdAssistantSettings/);
    });

    it("asks for the setting when the backend reported nothing", () => {
        assert.match(modelChoiceMessage([]), /not configured/);
    });
});

describe("emptyReplyMessage", () => {
    it("names the cause rather than reporting one generic failure", () => {
        assert.match(emptyReplyMessage("content_filter"), /filtered/i);
        assert.match(emptyReplyMessage("length"), /token limit/i);
        assert.match(emptyReplyMessage(undefined), /OpenAI-compatible/i);
        assert.match(emptyReplyMessage(""), /OpenAI-compatible/i);
        assert.match(emptyReplyMessage("tool_calls"), /tool_calls/);
    });
});

describe("history budget on the wire", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    const settings: AssistantSettings = { model: "test-model", data: { baseURL: "http://llm.test/v1" } };
    const context: QueryContext = { attachments: [], settings };

    it("caps the total history sent, dropping the oldest turns", async () => {
        const request = captureRequest();
        // What ChatInterface hands over at its own limit: 20 turns, each at the per-turn cap.
        const history: ChatTurn[] = Array.from({ length: 20 }, (_v, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `T${i} ` + "x".repeat(MAX_HISTORY_TURN_CHARS),
        }));

        const response = await new LlmProvider().query(context, "latest question", () => { }, undefined, history);
        assert.equal(response.success, true);

        const messages = request.body().messages as Array<{ role: string; content: string }>;
        const historyMessages = messages.slice(1, -1); // drop the system prompt and the live prompt
        const historyChars = historyMessages.reduce((n, m) => n + m.content.length, 0);

        assert.ok(historyChars <= MAX_HISTORY_CHARS, `history was ${historyChars} chars`);
        // 20 x 4000 = 80,000 chars before the cap existed.
        assert.ok(historyChars < 80000);
        // The newest turns are the ones kept, and the live prompt is never dropped.
        assert.match(historyMessages[historyMessages.length - 1].content, /^T19 /);
        assert.equal(messages[messages.length - 1].content, "latest question");
    });

    it("sends a short conversation unchanged", async () => {
        const request = captureRequest();
        const history: ChatTurn[] = [
            { role: "user", content: "why is it degraded?" },
            { role: "assistant", content: "the readiness probe fails" },
        ];

        await new LlmProvider().query(context, "how do I fix it?", () => { }, undefined, history);

        const messages = request.body().messages as Array<{ role: string; content: string }>;
        assert.deepEqual(messages.slice(1, -1).map((m) => m.content), history.map((h) => h.content));
    });
});

// The accuracy rules are the whole reason the default prompt is as long as it is, so they are pinned
// here rather than left to drift: each of the four named failure modes must be forbidden by name.
// Matched on the rule's own wording, not on a whole sentence, so the prompt can still be reworded.
describe("DEFAULT_SYSTEM_PROMPT", () => {
    it("forbids each of the four failure modes by name", () => {
        assert.match(DEFAULT_SYSTEM_PROMPT, /No guessing\./);
        assert.match(DEFAULT_SYSTEM_PROMPT, /No assuming\./);
        assert.match(DEFAULT_SYSTEM_PROMPT, /No lying\./);
        assert.match(DEFAULT_SYSTEM_PROMPT, /No waffling\./);
    });

    it("makes each rule checkable rather than an adjective", () => {
        // A model can satisfy "be accurate" while filling gaps with defaults, so the prompt has to
        // say what unknown means, that uncertainty is an acceptable answer, and that a truncated
        // attachment is a fragment - the three places a plausible answer gets invented.
        assert.match(DEFAULT_SYSTEM_PROMPT, /unknown, not default/);
        assert.match(DEFAULT_SYSTEM_PROMPT, /Say when you cannot tell/);
        assert.match(DEFAULT_SYSTEM_PROMPT, /\[truncated: \.\.\.\]/);
        assert.match(DEFAULT_SYSTEM_PROMPT, /Never claim to have run a command/);
    });

    it("describes no attachment that may be absent", () => {
        // This is prepended to every request, including from deployments with no MCP configured at
        // all, where MCP wording is pure cost and describes something that is not there. It lives
        // with the roster instead (see mcpPrompt.mcpRoster), which is emitted only when servers are.
        assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /MCP/);
    });

    it("stays short enough to be worth sending on every request", () => {
        // A guard against the rules growing back into prose, not a tuned budget: the whole point of
        // one line per rule is that it does not creep. Roughly 400 tokens.
        assert.ok(DEFAULT_SYSTEM_PROMPT.length < 1800, `prompt is ${DEFAULT_SYSTEM_PROMPT.length} chars`);
    });
});

describe("system prompt assembly", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    const base: AssistantSettings = { model: "test-model", data: { baseURL: "http://llm.test/v1" } };
    const manifest = {
        content: '{"kind":"Deployment"}',
        mimeType: "application/json",
        type: AttachmentType.MANIFEST,
    };

    const systemMessage = async (settings: AssistantSettings, attachments = [manifest]) => {
        const request = captureRequest();
        await new LlmProvider().query({ attachments, settings }, "why is it degraded?", () => { });
        return (request.body().messages as Array<{ role: string; content: string }>)[0].content;
    };

    it("sends the default persona when no override is configured", async () => {
        const system = await systemMessage(base);
        assert.ok(system.startsWith(DEFAULT_SYSTEM_PROMPT), "the default persona leads the system message");
    });

    it("falls back to the default when the override is blank", async () => {
        // `systemPrompt: ""` in a hand-edited ConfigMap must not strip the accuracy rules and leave
        // the model with nothing but the attachments.
        for (const systemPrompt of ["", "   ", "\n\t "]) {
            const system = await systemMessage({ ...base, systemPrompt });
            assert.ok(system.startsWith(DEFAULT_SYSTEM_PROMPT), JSON.stringify(systemPrompt));
        }
    });

    it("replaces the persona with a configured override", async () => {
        const system = await systemMessage({ ...base, systemPrompt: "You are a terse operator." });
        assert.ok(system.startsWith("You are a terse operator."));
        assert.ok(!system.includes("No waffling."), "the default persona is replaced, not appended to");
    });

    it("still attaches the context to an overridden persona", async () => {
        // The override replaces the persona only. Losing the attachments with it would silently
        // unground every answer in that deployment.
        const system = await systemMessage({ ...base, systemPrompt: "You are a terse operator." });
        assert.match(system, /\[Manifest - application\/json\]:/);
        assert.match(system, /"kind":"Deployment"/);
    });

    it("omits the context block when nothing is attached", async () => {
        const system = await systemMessage(base, []);
        assert.equal(system, DEFAULT_SYSTEM_PROMPT);
    });
});

describe("model discovery on the wire", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    // Serve /v1/models from `models` and stream a one-token completion for anything else, recording
    // every URL asked for so the "already configured" case can be shown to skip the lookup.
    function backend(models: string[] | null): { urls: string[]; model: () => string | undefined } {
        const urls: string[] = [];
        let sent: string | undefined;
        globalThis.fetch = (async (url: string, init: RequestInit) => {
            urls.push(String(url));
            if (String(url).endsWith("/v1/models")) {
                if (models === null) return new Response("no such endpoint", { status: 404 });
                return new Response(JSON.stringify({ object: "list", data: models.map(id => ({ id })) }), {
                    headers: { "content-type": "application/json" },
                });
            }
            sent = JSON.parse(String(init.body)).model;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(
                        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`));
                    controller.close();
                },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }) as unknown as typeof fetch;
        return { urls, model: () => sent };
    }

    const ask = (settings: AssistantSettings) =>
        new LlmProvider().query({ attachments: [], settings } as QueryContext, "hi", () => { });

    it("uses the only model a backend reports when none is configured", async () => {
        const stub = backend(["mistral-small"]);
        const response = await ask({ data: { baseURL: "http://llm.test/v1" } });
        assert.equal(response.success, true);
        assert.equal(stub.model(), "mistral-small");
    });

    it("names the candidates rather than picking one", async () => {
        const stub = backend(["llama3", "mistral"]);
        const response = await ask({ data: { baseURL: "http://llm.test/v1" } });
        assert.equal(response.success, false);
        assert.equal(response.error?.status, 400);
        assert.match(response.error!.message, /llama3, mistral/);
        assert.equal(stub.model(), undefined, "no completion is sent without a model");
    });

    it("still asks for the setting when the backend has no models endpoint", async () => {
        const stub = backend(null);
        const response = await ask({ data: { baseURL: "http://llm.test/v1" } });
        assert.equal(response.success, false);
        assert.match(response.error!.message, /not configured/);
        assert.equal(stub.model(), undefined);
    });

    it("does not look anything up when the model is configured", async () => {
        const stub = backend(["ignored"]);
        const response = await ask({ model: "gpt-4", data: { baseURL: "http://llm.test/v1" } });
        assert.equal(response.success, true);
        assert.equal(stub.model(), "gpt-4");
        assert.deepEqual(stub.urls, ["http://llm.test/v1/chat/completions"]);
    });
});
