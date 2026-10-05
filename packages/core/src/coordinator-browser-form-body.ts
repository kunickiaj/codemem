import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { decodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";

export const BROWSER_FORM_BODY_MAX_BYTES = 4096;
export type BrowserFormAction =
	| "transaction_attempt"
	| "session_logout"
	| "signin_start"
	| "link_start";
type FormInvalid = Readonly<{ ok: false; error: "form_invalid" }>;
type ReadResult =
	| Readonly<{ ok: true; bytes: Uint8Array<ArrayBuffer> }>
	| FormInvalid
	| Readonly<{ ok: false; error: "body_too_large" }>;
type ParseResult =
	| FormInvalid
	| Readonly<{ ok: true; action: "session_logout"; csrf: string }>
	| Readonly<{ ok: true; action: "signin_start"; csrf: string }>
	| Readonly<{ ok: true; action: "link_start"; csrf: string; attemptId: string; startCode: string }>
	| Readonly<{ ok: true; action: "transaction_attempt"; csrf: string; attemptId: string }>;
const FORM_INVALID: FormInvalid = Object.freeze({ ok: false, error: "form_invalid" });
const BODY_TOO_LARGE = Object.freeze({ ok: false, error: "body_too_large" } as const);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const streamLocked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get;

function ownData(input: unknown, key: string): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw FORM_INVALID;
	const descriptor = Object.getOwnPropertyDescriptor(input, key);
	if (!descriptor || !Object.hasOwn(descriptor, "value")) throw FORM_INVALID;
	return descriptor.value;
}

function declaredLengthError(value: unknown): FormInvalid | typeof BODY_TOO_LARGE | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length < 1 || value.length > 10) return FORM_INVALID;
	// Keep the final character explicitly within the declared-length grammar.
	if (!/^[0-9]+$/.test(value) || !/^[0-9]$/.test(value.slice(-1))) return FORM_INVALID;
	if (Number(value) > BROWSER_FORM_BODY_MAX_BYTES) return BODY_TOO_LARGE;
	return null;
}

function nativeByteLength(value: unknown): number {
	if (typedArrayTag?.call(value) !== "Uint8Array") throw FORM_INVALID;
	const length: unknown = typedArrayLength?.call(value);
	if (typeof length !== "number") throw FORM_INVALID;
	return length;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		// Untrusted teardown can outlive this call; never wait for its completion.
		void ReadableStreamDefaultReader.prototype.cancel.call(reader).catch(() => {});
	} catch {
		// Cleanup cannot replace the fixed public error.
	}
}

async function collectBytes(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadResult> {
	try {
		// One owned allocation bounds storage, even with thousands of tiny chunks.
		const bytes = new Uint8Array(BROWSER_FORM_BODY_MAX_BYTES);
		let total = 0;
		for (;;) {
			const chunk = await ReadableStreamDefaultReader.prototype.read.call(reader);
			if (chunk.done) return Object.freeze({ ok: true, bytes: bytes.subarray(0, total) });
			const length = nativeByteLength(chunk.value);
			if (length > BROWSER_FORM_BODY_MAX_BYTES - total) {
				cancelReader(reader);
				return BODY_TOO_LARGE;
			}
			// Copy before the next read can let a producer reuse or mutate its buffer.
			Uint8Array.prototype.set.call(bytes, chunk.value, total);
			total += length;
		}
	} catch {
		cancelReader(reader);
		return FORM_INVALID;
	} finally {
		try {
			ReadableStreamDefaultReader.prototype.releaseLock.call(reader);
		} catch {
			// A failed release must not reject the caller's promise.
		}
	}
}

/** Byte limits only. Slow-sender deadlines must be enforced by the transport. */
export async function readBrowserFormBody(input: {
	body: ReadableStream<Uint8Array> | null;
	contentLength: unknown;
}): Promise<ReadResult> {
	try {
		const body = ownData(input, "body");
		const error = declaredLengthError(ownData(input, "contentLength"));
		if (error) return error;
		if (body === null || streamLocked?.call(body) !== false) return FORM_INVALID;
		// Fetch body extraction rejects disturbed streams without reading them.
		new Response(body as ReadableStream<Uint8Array>);
		const reader = ReadableStream.prototype.getReader.call(
			body,
		) as ReadableStreamDefaultReader<Uint8Array>;
		return await collectBytes(reader);
	} catch {
		return FORM_INVALID;
	}
}

function decodeRawBody(bytes: Uint8Array): string {
	const length = nativeByteLength(bytes);
	if (length === 0 || length > BROWSER_FORM_BODY_MAX_BYTES) throw FORM_INVALID;
	// Preserve BOM so the ASCII grammar rejects it instead of silently stripping it.
	const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	if (
		raw.length > BROWSER_FORM_BODY_MAX_BYTES ||
		!/^[A-Za-z0-9*._%+=&-]+$/.test(raw) ||
		!/^[A-Za-z0-9*._%+=&-]+$/.test(raw.slice(-1))
	) {
		throw FORM_INVALID;
	}
	return raw;
}

function decodeFields(raw: string, action: BrowserFormAction): Readonly<Record<string, string>> {
	const fields: Record<string, string> = Object.create(null);
	for (const segment of raw.split("&")) {
		const equals = segment.indexOf("=");
		if (equals < 1 || equals !== segment.lastIndexOf("=")) throw FORM_INVALID;
		const key = decodeURIComponent(segment.slice(0, equals).replaceAll("+", " "));
		const attemptField =
			key === "attempt_id" && (action === "transaction_attempt" || action === "link_start");
		const startField = key === "start_code" && action === "link_start";
		if (key !== "csrf" && !attemptField && !startField) {
			throw FORM_INVALID;
		}
		if (Object.hasOwn(fields, key)) throw FORM_INVALID;
		fields[key] = decodeURIComponent(segment.slice(equals + 1).replaceAll("+", " "));
	}
	return Object.freeze(fields);
}

/** Grammar and field checks only; this does not authenticate CSRF or an attempt. */
export function parseBrowserFormBody(bytes: Uint8Array, action: BrowserFormAction): ParseResult {
	try {
		if (
			action !== "session_logout" &&
			action !== "transaction_attempt" &&
			action !== "signin_start" &&
			action !== "link_start"
		)
			return FORM_INVALID;
		const fields = decodeFields(decodeRawBody(bytes), action);
		if (!Object.hasOwn(fields, "csrf")) return FORM_INVALID;
		const csrf = fields.csrf;
		if (typeof csrf !== "string") return FORM_INVALID;
		if (action === "session_logout" || action === "signin_start") {
			return Object.freeze({ ok: true, action, csrf });
		}
		const attemptId = fields.attempt_id;
		if (!isAuthControllerId(attemptId)) return FORM_INVALID;
		if (action === "link_start") {
			const startCode = fields.start_code;
			if (typeof startCode !== "string" || !decodeCoordinatorAuthProof32(startCode))
				return FORM_INVALID;
			return Object.freeze({ ok: true, action, csrf, attemptId, startCode });
		}
		return Object.freeze({ ok: true, action, csrf, attemptId });
	} catch {
		return FORM_INVALID;
	}
}
