import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBrowserFormBody, readBrowserFormBody } from "./coordinator-browser-form-body.js";

const TOKEN = "A".repeat(86);
const PRIVATE_DETAIL = "synthetic-private-body-detail";
const encoder = new TextEncoder();
type Action = Parameters<typeof parseBrowserFormBody>[1];
type ReaderInput = Parameters<typeof readBrowserFormBody>[0];

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});

function bytes(value: string): Uint8Array {
	return encoder.encode(value);
}
function stream(chunks: unknown[]) {
	let index = 0;
	const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
		if (index === chunks.length) controller.close();
		else controller.enqueue(chunks[index++] as Uint8Array);
	});
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
	return { body, pull, cancel };
}
function invalid(result: unknown, error = "form_invalid") {
	expect(result).toEqual({ ok: false, error });
	expect(Object.isFrozen(result)).toBe(true);
	// Error DTOs must not retain request bytes, tokens, or thrown private details.
	expect(Reflect.ownKeys(result as object)).toEqual(["ok", "error"]);
}
function parsed(raw: string, action: Action = "transaction_attempt") {
	return parseBrowserFormBody(bytes(raw), action);
}

describe("browser form body byte reader", () => {
	it.each([undefined, null, "0", "0000000000", "10", "0000000010", "4096"])(
		"accepts absent or valid content length %j without trusting it as the actual size",
		async (contentLength) => {
			// Arrange
			const expected = bytes(`csrf=${TOKEN}`);
			const { body } = stream([expected.subarray(0, 5), expected.subarray(5)]);
			// Act
			const result = await readBrowserFormBody({ body, contentLength });
			// Assert: raw CSRF bytes are intentionally retained internally on success.
			expect(result).toEqual({ ok: true, bytes: expected });
			expect(Object.isFrozen(result)).toBe(true);
			expect(body.locked).toBe(false);
		},
	);
	it("rejects a null body without requiring a native Request", async () => {
		// Arrange
		const input = { body: null, contentLength: null };
		// Act
		const result = await readBrowserFormBody(input);
		// Assert
		invalid(result);
	});
	it("accepts an empty stream and releases its reader", async () => {
		// Arrange
		const { body, cancel } = stream([]);
		// Act
		const result = await readBrowserFormBody({ body, contentLength: "0" });
		// Assert
		expect(result).toEqual({ ok: true, bytes: new Uint8Array() });
		expect(Object.isFrozen(result)).toBe(true);
		expect(cancel).not.toHaveBeenCalled();
		expect(body.locked).toBe(false);
	});
	it.each(
		[
			"",
			"abc",
			"-1",
			"+1",
			"1.0",
			"10, 10",
			" 10",
			"10 ",
			"10\n",
			"10\r\n",
			"１",
			"00000000000",
			10,
			{},
			[],
		].map((contentLength) => ({ contentLength })),
	)("rejects malformed content length $contentLength before reading", async ({ contentLength }) => {
		// Arrange: zero high-water mark prevents constructor prefill.
		const { body, pull } = stream([bytes(PRIVATE_DETAIL)]);
		// Act
		const result = await readBrowserFormBody({ body, contentLength });
		// Assert
		invalid(result);
		expect(pull).not.toHaveBeenCalled();
		expect(body.locked).toBe(false);
	});
	it.each(["4097", "9999999999"])(
		"denies declared oversize %s before pulling",
		async (contentLength) => {
			// Arrange
			const { body, pull } = stream([bytes(PRIVATE_DETAIL)]);
			// Act
			const result = await readBrowserFormBody({ body, contentLength });
			// Assert
			invalid(result, "body_too_large");
			expect(pull).not.toHaveBeenCalled();
			expect(body.locked).toBe(false);
		},
	);
	it("accepts exactly 4096 bytes across chunks and owns the full concatenation", async () => {
		// Arrange
		const first = Uint8Array.from({ length: 2048 }, (_, i) => i % 251);
		const second = Uint8Array.from({ length: 2048 }, (_, i) => (i + 19) % 251);
		const expected = Uint8Array.from([...first, ...second]);
		const { body, cancel } = stream([first, new Uint8Array(), second]);
		// Act
		const result = await readBrowserFormBody({ body, contentLength: undefined });
		first.fill(0);
		second.fill(0);
		// Assert
		expect(result).toEqual({ ok: true, bytes: expected });
		expect(Object.isFrozen(result)).toBe(true);
		expect(cancel).not.toHaveBeenCalled();
		expect(body.locked).toBe(false);
	});
	it.each([[4096, 1], [5000]])(
		"caps actual bytes despite a smaller declared length: %j",
		async (...sizes) => {
			// Arrange
			const { body, cancel, pull } = stream(sizes.map((size) => new Uint8Array(size)));
			// Act
			const result = await readBrowserFormBody({ body, contentLength: "10" });
			// Assert
			invalid(result, "body_too_large");
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(pull).toHaveBeenCalledTimes(sizes.length);
			expect(body.locked).toBe(false);
		},
	);
});

describe("browser form stream copying and cleanup", () => {
	it("snapshots reused producer buffers before requesting another chunk", async () => {
		// Arrange
		const reused = new Uint8Array([1, 2, 3]);
		let frame = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					frame++;
					if (frame === 1) controller.enqueue(reused);
					else if (frame === 2) {
						reused.set([4, 5, 6]);
						controller.enqueue(reused);
					} else {
						reused.fill(99);
						controller.close();
					}
				},
			},
			{ highWaterMark: 0 },
		);
		// Act
		const result = await readBrowserFormBody({ body, contentLength: null });
		// Assert
		expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) });
		expect(body.locked).toBe(false);
	});
	it.each(["csrf=secret", new DataView(new ArrayBuffer(4)), new Proxy(new Uint8Array(4), {})])(
		"normalizes a non-native byte chunk without retaining it",
		async (chunk) => {
			// Arrange
			const { body, cancel } = stream([chunk]);
			// Act
			const result = await readBrowserFormBody({ body, contentLength: null });
			// Assert
			invalid(result);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
		},
	);
	it("normalizes read rejection and releases the reader", async () => {
		// Arrange
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					throw new Error(PRIVATE_DETAIL);
				},
			},
			{ highWaterMark: 0 },
		);
		// Act
		const result = await readBrowserFormBody({ body, contentLength: null });
		// Assert
		invalid(result);
		expect(body.locked).toBe(false);
	});
	it("keeps the result fixed when reader cleanup throws after releasing", async () => {
		// Arrange
		const nativeRelease = ReadableStreamDefaultReader.prototype.releaseLock;
		const release = vi
			.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock")
			.mockImplementation(function () {
				nativeRelease.call(this);
				throw new Error(PRIVATE_DETAIL);
			});
		const { body } = stream([new Uint8Array(4097)]);
		// Act
		const result = await readBrowserFormBody({ body, contentLength: null });
		// Assert
		invalid(result, "body_too_large");
		expect(release).toHaveBeenCalledTimes(1);
		expect(body.locked).toBe(false);
	});
	it.each(["throw", "reject"])(
		"does not let cancel %s replace the oversize result",
		async (mode) => {
			// Arrange
			const cancel = vi.fn(() => {
				if (mode === "throw") throw new Error(PRIVATE_DETAIL);
				return Promise.reject(new Error(PRIVATE_DETAIL));
			});
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						controller.enqueue(new Uint8Array(4097));
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			// Act
			const result = await readBrowserFormBody({ body, contentLength: null });
			// Assert
			invalid(result, "body_too_large");
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
		},
	);
});

describe("browser form reader lifecycle and metadata", () => {
	it("rejects locked and partially disturbed streams without consuming any remaining bytes", async () => {
		// Arrange: zero prefill; the unread tail is itself a valid logout form.
		const first = bytes("csrf=x");
		const { body, pull, cancel } = stream([first, bytes(`csrf=${PRIVATE_DETAIL}`)]);
		const heldReader = body.getReader();
		try {
			// Act: a held reader must block extraction before even the first pull.
			const lockedResult = await readBrowserFormBody({ body, contentLength: null });
			// Assert
			invalid(lockedResult);
			expect(pull).toHaveBeenCalledTimes(0);
			expect(body.locked).toBe(true);
			// Arrange: consume only the first chunk, leaving a readable valid tail.
			const consumed = await heldReader.read();
			heldReader.releaseLock();
			expect(consumed).toEqual({ done: false, value: first });
			expect(pull).toHaveBeenCalledTimes(1);
			// Act: releasing the lock does not make a disturbed body reusable.
			const disturbedResult = await readBrowserFormBody({ body, contentLength: null });
			// Assert: no partial byte success or private tail may escape the fixed error.
			invalid(disturbedResult);
			expect(pull).toHaveBeenCalledTimes(1);
			expect(cancel).not.toHaveBeenCalled();
			expect(body.locked).toBe(false);
		} finally {
			heldReader.releaseLock();
		}
	});
	it("returns oversize without awaiting a hanging cancel promise", async () => {
		// Arrange: a microtask barrier, not a clock deadline or sleep.
		let notifyCancel: () => void = () => {};
		const cancellation = new Promise<void>((resolve) => {
			notifyCancel = resolve;
		});
		let finishCancel: () => void = () => {};
		const hanging = new Promise<void>((resolve) => {
			finishCancel = resolve;
		});
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(4097));
				},
				cancel() {
					notifyCancel();
					return hanging;
				},
			},
			{ highWaterMark: 0 },
		);
		// Act
		const pending = readBrowserFormBody({ body, contentLength: null });
		await cancellation;
		const barrier = Promise.resolve()
			.then(() => {})
			.then(() => {})
			.then(() => "blocked");
		const result = await Promise.race([pending, barrier]);
		finishCancel();
		// Assert
		invalid(result, "body_too_large");
		expect(body.locked).toBe(false);
		await pending;
	});
	it("ignores later metadata mutation while consuming an already selected stream", async () => {
		// Arrange
		const expected = bytes(`csrf=${TOKEN}`);
		const selected = stream([expected]);
		const replacement = stream([bytes(PRIVATE_DETAIL)]);
		const input = { body: selected.body, contentLength: null as unknown };
		// Act
		const pending = readBrowserFormBody(input);
		input.body = replacement.body;
		input.contentLength = "9999999999";
		const result = await pending;
		// Assert
		expect(result).toEqual({ ok: true, bytes: expected });
		expect(replacement.pull).not.toHaveBeenCalled();
		expect(selected.body.locked).toBe(false);
	});
	it.each(["body", "contentLength"])(
		"rejects an own %s getter without evaluating it",
		async (key) => {
			// Arrange
			const { body, pull } = stream([bytes(PRIVATE_DETAIL)]);
			const getter = vi.fn(() => {
				throw new Error(PRIVATE_DETAIL);
			});
			const input = { body, contentLength: null };
			Object.defineProperty(input, key, { get: getter });
			// Act
			const result = await readBrowserFormBody(input);
			// Assert
			invalid(result);
			expect(getter).not.toHaveBeenCalled();
			expect(pull).not.toHaveBeenCalled();
		},
	);
	it.each([
		null,
		undefined,
		1,
		"body",
		{},
		{ body: {} },
		new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw new Error(PRIVATE_DETAIL);
				},
			},
		),
	])("normalizes invalid reader input without throwing", async (input) => {
		// Arrange
		const malformed = input as ReaderInput;
		// Act
		const result = await readBrowserFormBody(malformed);
		// Assert
		invalid(result);
	});
});

describe("strict browser form parser", () => {
	it.each(["transaction_attempt", "session_logout", "signin_start"] as const)(
		"returns frozen typed fields for %s",
		(action) => {
			// Arrange
			const suffix = action === "transaction_attempt" ? "&attempt_id=attempt-1" : "";
			const expected =
				action === "transaction_attempt"
					? { ok: true, action, csrf: TOKEN, attemptId: "attempt-1" }
					: { ok: true, action, csrf: TOKEN };
			// Act
			const result = parsed(`csrf=${TOKEN}${suffix}`, action);
			// Assert: parsing the opaque token is not proof of authentication or its MAC.
			expect(result).toEqual(expected);
			expect(Object.isFrozen(result)).toBe(true);
		},
	);
	it.each(["csrf=&attempt_id=attempt-1", "attempt_id=attempt-1&%63srf="])(
		"accepts present empty csrf without validating its token shape: %s",
		(raw) => {
			// Arrange
			const expected = {
				ok: true,
				action: "transaction_attempt",
				csrf: "",
				attemptId: "attempt-1",
			};
			// Act
			const result = parsed(raw);
			// Assert
			expect(result).toEqual(expected);
		},
	);
	it("decodes escaped delimiters and distinguishes plus from escaped plus", () => {
		// Arrange
		const raw = "%63srf=a+b%2Bc%3Dd%26e&%61ttempt_id=foo%20bar";
		// Act
		const result = parsed(raw);
		// Assert
		expect(result).toEqual({
			ok: true,
			action: "transaction_attempt",
			csrf: "a b+c=d&e",
			attemptId: "foo bar",
		});
	});
	it.each(["x", "x".repeat(256), "界".repeat(256)])(
		"accepts the full valid identifier, including its 256-character boundary",
		(attemptId) => {
			// Arrange
			const raw = `csrf=${TOKEN}&attempt_id=${encodeURIComponent(attemptId)}`;
			// Act
			const result = parsed(raw);
			// Assert
			expect(result).toEqual({ ok: true, action: "transaction_attempt", csrf: TOKEN, attemptId });
		},
	);
	it.each([
		"",
		"x".repeat(257),
		"界".repeat(257),
		" x",
		"x ",
		"\tx",
		"x\n",
		"x\u0000y",
		"x\u200by",
		"x\u202ey",
		"x\ufeffy",
	])("rejects an invalid identifier rather than trimming or normalizing it", (attemptId) => {
		// Arrange
		const raw = `csrf=${TOKEN}&attempt_id=${encodeURIComponent(attemptId)}`;
		// Act
		const result = parsed(raw);
		// Assert
		invalid(result);
	});
});

describe("signin start form fields", () => {
	it.each([`csrf=${TOKEN}`, `%63srf=${TOKEN}`, "csrf="])("parses only internal csrf: %s", (raw) => {
		// Arrange
		const input = bytes(raw);
		// Act
		const result = parseBrowserFormBody(input, "signin_start");
		// Assert: token shape and authentication belong to the guard, not this parser.
		expect(result).toEqual({
			ok: true,
			action: "signin_start",
			csrf: raw.endsWith("=") ? "" : TOKEN,
		});
		expect(Object.isFrozen(result)).toBe(true);
	});
	it.each([
		"",
		"attempt_id=x",
		"csrf=x&attempt_id=x",
		"csrf=x&role=admin",
		"csrf=x&actor=x",
		"csrf=x&controller=x",
		"csrf=x&unknown=x",
		"csrf=x&__proto__=x",
		"csrf=x&%63srf=y",
		"csrf=x&%61ttempt_id=x",
		"csrf=%",
		"csrf=%ED%A0%80",
	])("rejects missing, extra, duplicate or malformed start fields: %s", (raw) => {
		// Arrange
		const input = bytes(raw);
		// Act
		const result = parseBrowserFormBody(input, "signin_start");
		// Assert
		invalid(result);
	});
});

describe("browser form grammar and untrusted inputs", () => {
	it.each([
		"",
		"csrf=x",
		"attempt_id=x",
		"csrf=x&attempt_id=",
		"csrf=x&attemptId=x",
		"csrf=x&attempt_id=x&role=admin",
		"csrf=x&attempt_id=x&__proto__=x",
		"csrf=x&attempt_id=x&constructor=x",
		"csrf=x&attempt_id=x&prototype=x",
		"csrf=x&csrf=y&attempt_id=x",
		"csrf=x&%63srf=y&attempt_id=x",
		"csrf=x&attempt_id=x&%61ttempt_id=y",
		"CSRF=x&attempt_id=x",
		"csrf=x&&attempt_id=x",
		"&csrf=x&attempt_id=x",
		"csrf=x&attempt_id=x&",
		"csrf=x=y&attempt_id=x",
		"csrf&attempt_id=x",
		"csrf=x&attempt_id=x=y",
		"csrf=x;attempt_id=x",
		"csrf=x&attempt_id=x#fragment",
		"csrf=x&attempt_id=x?",
		"csrf=x&attempt_id=foo bar",
		"csrf=x&attempt_id=foo+",
		"csrf=x&attempt_id=foo%ED%A0%80",
		"csrf=x&attempt_id=界",
		"csrf=x\n&attempt_id=x",
		"csrf=%&attempt_id=x",
		"csrf=%0&attempt_id=x",
		"csrf=%GG&attempt_id=x",
		"csrf=%C0%AF&attempt_id=x",
		"csrf=%ED%A0%80&attempt_id=x",
		"csrf=%F4%90%80%80&attempt_id=x",
		"csrf=%E2%82&attempt_id=x",
	])("rejects noncanonical grammar or unexpected keys: %s", (raw) => {
		// Arrange
		const input = bytes(raw);
		// Act
		const result = parseBrowserFormBody(input, "transaction_attempt");
		// Assert
		invalid(result);
	});
	it.each(["", "attempt_id=x", "csrf=x&attempt_id=x", "csrf=x&csrf=y", "csrf=x&unknown=y"])(
		"rejects missing or extra logout fields: %s",
		(raw) => {
			// Arrange
			const input = bytes(raw);
			// Act
			const result = parseBrowserFormBody(input, "session_logout");
			// Assert
			invalid(result);
		},
	);
	it("accepts precisely 4096 raw bytes, then rejects 4097 without returning input", () => {
		// Arrange
		const exact = bytes(`csrf=${"x".repeat(4091)}`);
		const over = bytes(`csrf=${"x".repeat(4092)}`);
		// Act
		const accepted = parseBrowserFormBody(exact, "session_logout");
		const rejected = parseBrowserFormBody(over, "session_logout");
		// Assert
		expect(accepted).toEqual({ ok: true, action: "session_logout", csrf: "x".repeat(4091) });
		invalid(rejected);
	});
	it.each([
		new Uint8Array([0xc0, 0xaf]),
		new Uint8Array([0xed, 0xa0, 0x80]),
		new Uint8Array([0xe2, 0x82]),
		new Uint8Array([0xff]),
		new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("csrf=x")]),
	])("rejects malformed UTF-8 and a raw BOM rather than replacing or stripping them", (input) => {
		// Arrange
		const action = "session_logout";
		// Act
		const result = parseBrowserFormBody(input, action);
		// Assert
		invalid(result);
	});
	it.each(
		[
			null,
			undefined,
			"csrf=x",
			[99],
			{},
			new DataView(new ArrayBuffer(4)),
			new Proxy(bytes("csrf=x"), {}),
		].map((input) => ({ input })),
	)("rejects non-native byte input without coercing it", ({ input }) => {
		// Arrange
		const coercion = vi.fn(() => {
			throw new Error(PRIVATE_DETAIL);
		});
		if (input && typeof input === "object" && !ArrayBuffer.isView(input)) {
			Object.defineProperty(input, "toString", { value: coercion });
		}
		// Act
		const result = parseBrowserFormBody(input as Uint8Array, "session_logout");
		// Assert
		invalid(result);
		expect(coercion).not.toHaveBeenCalled();
	});
	it.each([undefined, null, "transaction", "logout", "__proto__", {}])(
		"rejects unsupported action input without inferring a role",
		(action) => {
			// Arrange
			const input = bytes(`csrf=${TOKEN}&attempt_id=x`);
			// Act
			const result = parseBrowserFormBody(input, action as Action);
			// Assert
			invalid(result);
		},
	);
});
