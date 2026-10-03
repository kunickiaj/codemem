import { expect, it, vi } from "vitest";
import {
	parseBrowserFormBody,
	readBrowserFormBody,
} from "../../core/src/coordinator-browser-form-body.js";

const encoder = new TextEncoder();
const csrf = "A".repeat(86); // Canonical public fixture; parsing does not authenticate it.
const invalid = { ok: false, error: "form_invalid" };
const tooLarge = { ok: false, error: "body_too_large" };

it("rejects locked and partially consumed native Request bodies without pulling the valid remainder", async () => {
	// Arrange: an unread valid suffix must not disguise an already disturbed body.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	const tail = encoder.encode("csrf=tail");
	let pulls = 0;
	const source = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.enqueue(pulls++ === 0 ? encoder.encode("discarded-prefix&") : tail);
				if (pulls === 2) controller.close();
			},
		},
		{ highWaterMark: 0 },
	);
	const request = new Request("https://app.example.test/form", { method: "POST", body: source });
	const body = request.body;
	if (!body) throw new Error("Expected native Request body");
	const reader = body.getReader();
	let held = true;
	try {
		// Act: reject a held reader before consuming any bytes.
		const locked = await readBrowserFormBody({ body, contentLength: null });
		// Assert
		expect(locked).toEqual(invalid);
		expect(pulls).toBe(0);
		expect(body.locked).toBe(true);
		expect(request.bodyUsed).toBe(false);
		// Act: consume only the prefix and release the lock, leaving a valid form suffix.
		const first = await reader.read();
		reader.releaseLock();
		held = false;
		const disturbed = await readBrowserFormBody({ body, contentLength: null });
		const validTail = parseBrowserFormBody(tail, "session_logout");
		// Assert: unlocked is not unread; the helper must not read the suffix.
		expect(first).toEqual({ done: false, value: encoder.encode("discarded-prefix&") });
		expect(validTail).toEqual({ ok: true, action: "session_logout", csrf: "tail" });
		expect(disturbed).toEqual(invalid);
		expect(pulls).toBe(1);
		expect(body.locked).toBe(false);
		expect(request.bodyUsed).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		if (held) reader.releaseLock();
		void body.cancel().catch(() => {});
		fetch.mockRestore();
	}
});

it("reads native POST bodies and preserves decoded fields for only the fixed actions", async () => {
	// Arrange: no HTTP guard, MAC verification, or store lookup is exercised here.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	const attemptId = `雪${"a".repeat(255)}`;
	try {
		for (const action of ["transaction_attempt", "session_logout"] as const) {
			const form = new URLSearchParams({ csrf });
			if (action === "transaction_attempt") form.set("attempt_id", attemptId);
			const request = new Request("https://app.example.test/form", { method: "POST", body: form });
			const snapshot = { body: request.body, contentLength: request.headers.get("Content-Length") };
			// Act
			const read = await readBrowserFormBody(snapshot);
			if (!read.ok) throw new Error("Expected body bytes");
			const parsed = parseBrowserFormBody(read.bytes, action);
			const wrongFields = parseBrowserFormBody(
				encoder.encode(action === "session_logout" ? `${form}&attempt_id=extra` : `csrf=${csrf}`),
				action,
			);
			// Assert: native stream consumption and immutable parsed data, not authorization.
			expect(request.bodyUsed).toBe(true);
			expect(snapshot.body?.locked).toBe(false);
			expect(read.bytes).toEqual(encoder.encode(form.toString()));
			expect(parsed).toEqual(
				action === "session_logout"
					? { ok: true, action, csrf }
					: { ok: true, action, csrf, attemptId },
			);
			expect(Object.isFrozen(parsed)).toBe(true);
			expect(wrongFields).toEqual(invalid);
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("owns chunk bytes at the exact cap and rejects actual or declared overflow without leaking locks", async () => {
	// Arrange: highWaterMark zero avoids producer prefill before a read is requested.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	const reused = new Uint8Array(2048).fill(65);
	let pulls = 0;
	const exact = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (pulls === 2) return controller.close();
				reused.fill(pulls++ === 0 ? 65 : 66);
				controller.enqueue(reused);
			},
		},
		{ highWaterMark: 0 },
	);
	const cancel = vi.fn(() => Promise.reject(new Error("private cancellation diagnostic")));
	let overflowPulls = 0;
	const overflow = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.enqueue(new Uint8Array(overflowPulls++ === 0 ? 4096 : 1));
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	const earlyPull = vi.fn();
	const early = new ReadableStream<Uint8Array>({ pull: earlyPull }, { highWaterMark: 0 });
	try {
		// Act
		const accepted = await readBrowserFormBody({ body: exact, contentLength: null });
		const denied = await readBrowserFormBody({ body: overflow, contentLength: "10" });
		const declared = await readBrowserFormBody({ body: early, contentLength: "4097" });
		reused.fill(99);
		// Assert: copied bytes survive reuse; small declared sizes cannot bypass the actual cap.
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error("Expected exact-cap bytes");
		expect(accepted.bytes).toEqual(
			Uint8Array.from({ length: 4096 }, (_, i) => (i < 2048 ? 65 : 66)),
		);
		expect(denied).toEqual(tooLarge);
		expect(declared).toEqual(tooLarge);
		expect(cancel).toHaveBeenCalledOnce();
		expect(overflowPulls).toBe(2);
		expect(earlyPull).not.toHaveBeenCalled();
		for (const stream of [exact, overflow, early]) expect(stream.locked).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("returns fixed errors for native stream failures and rejects malformed browser form encodings", async () => {
	// Arrange: malformed data is local fixture input, never fetched or logged.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	const failed = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.error(new Error("private read diagnostic"));
			},
		},
		{ highWaterMark: 0 },
	);
	const cancel = vi.fn();
	const nonbyte = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.enqueue("private chunk diagnostic" as unknown as Uint8Array);
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	const malformed = [
		`csrf=${csrf}&csrf=${csrf}`,
		`csrf=${csrf}&%63srf=${csrf}`,
		`csrf=${csrf}&__proto__=private`,
		`csrf=${csrf}&unknown=private`,
		`csrf=${csrf}&attempt_id=%`,
		`csrf=${csrf}&attempt_id=%FF`,
		`csrf=${csrf}&attempt_id=雪`,
		`\uFEFFcsrf=${csrf}&attempt_id=ok`,
		`csrf=${csrf}&attempt_id=${"a".repeat(257)}`,
		`csrf=${csrf}&attempt_id=+ok`,
		`csrf=${csrf}&attempt_id=%00`,
		`csrf=${csrf}&attempt_id=ok&`,
	];
	try {
		// Act
		const errors = await Promise.all(
			[failed, nonbyte].map((body) => readBrowserFormBody({ body, contentLength: null })),
		);
		const valid = parseBrowserFormBody(
			encoder.encode(`csrf=${csrf}&attempt_id=a%2Bb+c`),
			"transaction_attempt",
		);
		const denied = malformed.map((raw) =>
			parseBrowserFormBody(encoder.encode(raw), "transaction_attempt"),
		);
		const invalidUtf8 = parseBrowserFormBody(new Uint8Array([0xff]), "session_logout");
		// Assert: percent-encoded plus and form spaces differ; errors never echo private input.
		expect(valid).toEqual({ ok: true, action: "transaction_attempt", csrf, attemptId: "a+b c" });
		expect(errors).toEqual([invalid, invalid]);
		expect(denied).toEqual(malformed.map(() => invalid));
		expect(invalidUtf8).toEqual(invalid);
		expect(cancel).toHaveBeenCalledOnce();
		expect(failed.locked).toBe(false);
		expect(nonbyte.locked).toBe(false);
		expect(JSON.stringify(errors)).not.toContain("private");
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});
