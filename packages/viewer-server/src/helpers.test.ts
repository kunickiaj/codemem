import { describe, expect, it } from "vitest";
import { parseJsonObjectBody, queryInt } from "./helpers.js";

describe("queryInt", () => {
	it("parses full integer strings", () => {
		expect(queryInt("10", 25)).toBe(10);
		expect(queryInt("  -7  ", 25)).toBe(-7);
	});

	it("rejects partial or non-integer strings", () => {
		expect(queryInt("10abc", 25)).toBe(25);
		expect(queryInt("1.0", 25)).toBe(25);
		expect(queryInt("1e2", 25)).toBe(25);
		expect(queryInt("", 25)).toBe(25);
	});
});

describe("parseJsonObjectBody", () => {
	function makeContext(body: BodyInit | null, headers: Record<string, string> = {}) {
		const request = new Request("http://viewer.test/api/raw-events", {
			method: "POST",
			body,
			headers,
			// Required by undici for stream bodies, and harmless for null bodies.
			duplex: "half",
		});
		return {
			req: {
				header: (name: string) => request.headers.get(name) ?? undefined,
				raw: request,
			},
			json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
		};
	}

	it("rejects oversized bodies with 413 based on the declared content-length", async () => {
		// A stream body so the browser-style content-length recompute
		// cannot override the declared header.
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("{}"));
				controller.close();
			},
		});
		const result = await parseJsonObjectBody(
			makeContext(stream, { "content-length": "999999" }),
			1024,
		);
		expect(result).toBeInstanceOf(Response);
		const response = result as Response;
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "payload too large", max_bytes: 1024 });
	});

	it("rejects oversized bodies with 413 while streaming when no content-length is declared", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x".repeat(800)));
				controller.enqueue(new TextEncoder().encode("y".repeat(800)));
				controller.close();
			},
		});
		const result = await parseJsonObjectBody(makeContext(stream), 1024);
		expect(result).toBeInstanceOf(Response);
		const response = result as Response;
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "payload too large", max_bytes: 1024 });
	});

	it("parses a well-formed JSON object body", async () => {
		const result = await parseJsonObjectBody(makeContext(JSON.stringify({ events: [] })), 1024);
		expect(result).toEqual({ events: [] });
	});

	it("rejects invalid JSON with 400", async () => {
		const result = await parseJsonObjectBody(makeContext("{ nope"), 1024);
		expect(result).toBeInstanceOf(Response);
		const response = result as Response;
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid json" });
	});

	it("rejects non-object JSON payloads with 400", async () => {
		const result = await parseJsonObjectBody(makeContext("[1,2,3]"), 1024);
		expect(result).toBeInstanceOf(Response);
		const response = result as Response;
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "payload must be an object" });
	});
});
