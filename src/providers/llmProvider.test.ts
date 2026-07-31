import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AssistantSettings, ChatTurn, QueryContext } from "../model/provider";
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURN_CHARS } from "../util/context";
import { chatCompletionsUrl, emptyReplyMessage, LlmProvider } from "./llmProvider";

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
