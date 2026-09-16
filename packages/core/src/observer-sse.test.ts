import { describe, expect, it } from "vitest";
import { parseObserverSSE } from "./observer-sse.js";

const encoder = new TextEncoder();

function chunkedBody(text: string, chunkSizes: number[]): ReadableStream<Uint8Array> {
	const bytes = encoder.encode(text);
	let offset = 0;
	let chunkIndex = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const size = chunkSizes[chunkIndex % chunkSizes.length] ?? bytes.length;
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
			chunkIndex++;
		},
	});
}

const extractDelta = (event: Record<string, unknown>) =>
	typeof event.delta === "string" ? event.delta : null;

describe("observer SSE framing", () => {
	it("parses multiline CRLF events across arbitrary byte boundaries", async () => {
		const body = chunkedBody(
			[
				": keepalive\r\n",
				"data: not-json\r\n\r\n",
				'data: {"delta":"héllo",\r\n',
				'data: "usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}\r\n\r\n',
				"data: [DONE]\r\n\r\n",
			].join(""),
			[1, 2, 5, 3],
		);

		await expect(parseObserverSSE(body, extractDelta)).resolves.toMatchObject({
			raw: "héllo",
			usageFields: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
		});
	});

	it("discards an unterminated final event", async () => {
		const body = chunkedBody('data: {"delta":"complete"}\n\ndata: {"delta":"truncated"}\n', [7]);

		await expect(parseObserverSSE(body, extractDelta)).resolves.toMatchObject({
			raw: "complete",
		});
	});

	it("caps buffered wire data for an event that never completes", async () => {
		const body = chunkedBody(`data: ${"x".repeat(1024 * 1024 + 1)}`, [4096]);

		await expect(parseObserverSSE(body, extractDelta)).rejects.toThrow(
			"Buffered data exceeded max buffer size",
		);
	});
});
