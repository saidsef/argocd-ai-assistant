import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readLines, sseData } from "./stream";

// A ReadableStream emitting the given byte chunks, so line reassembly can be tested at exact splits.
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
}

async function collect(chunks: string[]): Promise<string[]> {
    const out: string[] = [];
    for await (const line of readLines(streamOf(chunks))) out.push(line);
    return out;
}

describe("sseData", () => {
    it("accepts the payload with or without the optional space", () => {
        assert.equal(sseData("data: {\"a\":1}"), '{"a":1}');
        // The space after the colon is optional in the SSE grammar; requiring it silently yielded
        // empty successful replies against backends that emit `data:{...}`.
        assert.equal(sseData("data:{\"a\":1}"), '{"a":1}');
    });

    it("returns null for non-data lines, blanks and the terminator", () => {
        for (const line of ["", ":comment", "event: message", "data:", "data: ", "data: [DONE]", "id: 1"]) {
            assert.equal(sseData(line), null, `expected null for ${JSON.stringify(line)}`);
        }
    });
});

describe("readLines", () => {
    it("reassembles a line split across chunks", () => {
        return collect(["data: {\"a\":", "1}\n"]).then((lines) => {
            assert.deepEqual(lines, ['data: {"a":1}']);
        });
    });

    it("yields a final line with no trailing newline", async () => {
        assert.deepEqual(await collect(["one\ntwo"]), ["one", "two"]);
    });

    it("preserves blank lines, which separate SSE events", async () => {
        assert.deepEqual(await collect(["a\n\nb\n"]), ["a", "", "b"]);
    });

    it("yields nothing for an empty stream", async () => {
        assert.deepEqual(await collect([]), []);
        assert.deepEqual(await collect([""]), []);
    });

    it("releases the reader when the consumer breaks out early", async () => {
        const body = streamOf(["a\nb\nc\n"]);
        for await (const line of readLines(body)) {
            if (line === "a") break;
        }
        // A dangling lock would make this throw; the generator's finally must have released it.
        assert.doesNotThrow(() => body.getReader());
    });
});
