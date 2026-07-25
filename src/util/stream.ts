/**
 * Read a `fetch` response body as newline-delimited text.
 *
 * The chat-completion SSE stream, the MCP JSON-RPC SSE stream and the Argo CD logs stream all need
 * the same loop: pull a chunk, decode it, split on newlines, and hold back the trailing partial line
 * so an event split across two chunks is reassembled rather than dropped. This is that loop, once.
 *
 * The reader is always released - including when the consumer breaks out early, because a `return`
 * inside `for await` runs the generator's `finally`. Without that, an error mid-stream leaves the
 * connection dangling until the tab is closed.
 */
export async function* readLines(
    body: ReadableStream<Uint8Array>,
    /** Called as each network chunk arrives, whether or not it completed a line. Lets a caller run
     *  an inactivity watchdog against real traffic rather than against parsed output. */
    onChunk?: () => void
): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            onChunk?.();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) yield line;
        }
        // Flush a final line when the stream ends without a trailing newline.
        if (buffer) yield buffer;
    } finally {
        // cancel() tells the server we are done (a no-op on an already-finished stream) but does
        // *not* drop the lock, so release it too - otherwise the body stays locked forever after an
        // early break. Swallow the rejection: the consumer's own error must win.
        await reader.cancel().catch(() => { });
        try { reader.releaseLock(); } catch (_e) { /* already released */ }
    }
}

/**
 * The payload of an SSE `data:` line, or null for anything else (comments, `event:`, blank lines,
 * and the terminal `[DONE]` sentinel).
 *
 * The space after the colon is optional in the SSE grammar, so matching `"data: "` literally - as
 * every hand-rolled parser here used to - silently yields an empty *successful* reply against a
 * backend that emits `data:{...}`.
 */
export function sseData(line: string): string | null {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    return data && data !== "[DONE]" ? data : null;
}
