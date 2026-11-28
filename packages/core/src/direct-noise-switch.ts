/**
 * How the client reads a listener's answer to a direct Noise upgrade. Only a
 * complete, well-formed 404 means "this listener has no Noise", which is the
 * one answer that may lead a legacy peer to plaintext. Busy answers are
 * retried. Everything else refuses the request.
 */

/** A complete, well-formed 404: the listener has no Noise. */
export class DirectNoiseNotOffered extends Error {
	constructor(readonly detail: string) {
		super(`peer did not accept an encrypted connection (${detail})`);
		this.name = "DirectNoiseNotOffered";
	}
}

/**
 * The listener is at a cap right now: 503 for its handshake or stream caps,
 * 429 for its per-address request limit, or "closed" when it closed the
 * connection before sending any byte, which is how its socket caps refuse.
 * Retry later. This never means the peer lacks Noise.
 */
export class DirectNoiseBusy extends Error {
	constructor(
		readonly status: 429 | 503 | "closed",
		/** The listener's Retry-After, in seconds, when it sent one. */
		readonly retryAfterS: number | undefined,
	) {
		super(`peer is busy (${status})`);
		this.name = "DirectNoiseBusy";
	}
}

/**
 * Any other answer: another status, a malformed or partial reply, or one that
 * is too large. The listener may speak Noise, or something on the path may
 * have forged or cut the reply, so it never leads to plaintext.
 */
export class DirectNoiseRejected extends Error {
	constructor(readonly detail: string) {
		super(`peer refused the encrypted connection (${detail})`);
		this.name = "DirectNoiseRejected";
	}
}

/** Head and body together. A listener without Noise sends a short 404. */
export const MAX_SWITCH_RESPONSE_BYTES = 16 * 1024;

export type SwitchReading =
	| { readonly kind: "pending" }
	| { readonly kind: "switched" }
	| { readonly kind: "refused"; readonly error: Error };

const PENDING: SwitchReading = { kind: "pending" };
const STATUS_LINE = /^HTTP\/1\.1 (\d{3})(?: [\t !-~]*)?$/;
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\t !-~]*?)[ \t]*$/;

const refused = (error: Error): SwitchReading => ({ kind: "refused", error });

function parseHead(head: string): { status: string; headers: Map<string, string> } | null {
	const [statusLine = "", ...lines] = head.split("\r\n");
	const status = STATUS_LINE.exec(statusLine)?.[1];
	if (!status) return null;
	const headers = new Map<string, string>();
	for (const line of lines) {
		const match = HEADER_LINE.exec(line);
		if (!match?.[1]) return null;
		const name = match[1].toLowerCase();
		// A repeated framing header could hide where the body ends.
		if (headers.has(name) && (name === "content-length" || name === "transfer-encoding"))
			return null;
		headers.set(name, match[2] ?? "");
	}
	return { status, headers };
}

/** The end of a complete chunked body, -1 while incomplete, or null when malformed. */
function chunkedEnd(body: Buffer): number | null {
	let offset = 0;
	for (;;) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd < 0) return -1;
		const sizeText = body.subarray(offset, lineEnd).toString("latin1");
		if (!/^[0-9a-fA-F]{1,6}$/.test(sizeText)) return null;
		const size = Number.parseInt(sizeText, 16);
		const dataEnd = lineEnd + 2 + size;
		if (body.byteLength < dataEnd + 2) return -1;
		if (body.subarray(dataEnd, dataEnd + 2).toString("latin1") !== "\r\n") return null;
		offset = dataEnd + 2;
		if (size === 0) return offset;
	}
}

type BodyState = "complete" | "pending" | "malformed";

function lengthBodyState(length: string, body: Buffer): BodyState {
	if (!/^\d{1,5}$/.test(length)) return "malformed";
	const expected = Number(length);
	if (body.byteLength < expected) return "pending";
	return body.byteLength === expected ? "complete" : "malformed";
}

function chunkedBodyState(body: Buffer): BodyState {
	const end = chunkedEnd(body);
	if (end === null) return "malformed";
	if (end < 0) return "pending";
	return end === body.byteLength ? "complete" : "malformed";
}

/** Bytes the body needs: complete, still waiting, or malformed. */
function bodyState(headers: Map<string, string>, body: Buffer): BodyState {
	const length = headers.get("content-length");
	const encoding = headers.get("transfer-encoding");
	if (length !== undefined && encoding !== undefined) return "malformed";
	if (length !== undefined) return lengthBodyState(length, body);
	if (encoding?.toLowerCase() === "chunked") return chunkedBodyState(body);
	// Without a length, a body cut short looks the same as a whole one.
	return "malformed";
}

function retryAfterS(headers: Map<string, string>): number | undefined {
	const value = headers.get("retry-after");
	return value && /^\d{1,4}$/.test(value) ? Number(value) : undefined;
}

function readNonSwitch(
	status: string,
	headers: Map<string, string>,
	body: Buffer,
	closed: boolean,
) {
	if (status === "429" || status === "503")
		return refused(new DirectNoiseBusy(status === "429" ? 429 : 503, retryAfterS(headers)));
	if (status !== "404") return refused(new DirectNoiseRejected(`status ${status}`));
	const state = bodyState(headers, body);
	if (state === "complete") return refused(new DirectNoiseNotOffered("status 404"));
	if (state === "pending" && !closed) return PENDING;
	return refused(new DirectNoiseRejected(state === "pending" ? "partial 404" : "malformed 404"));
}

/**
 * Reads what the listener has sent so far. `closed` says the connection has
 * ended, so nothing more will arrive.
 */
export function readSwitchResponse(buffered: Buffer, closed: boolean): SwitchReading {
	if (closed && buffered.byteLength === 0) return refused(new DirectNoiseBusy("closed", undefined));
	if (buffered.byteLength > MAX_SWITCH_RESPONSE_BYTES)
		return refused(new DirectNoiseRejected("reply too large"));
	const end = buffered.indexOf("\r\n\r\n");
	if (end < 0) return closed ? refused(new DirectNoiseRejected("partial reply")) : PENDING;
	const head = parseHead(buffered.subarray(0, end).toString("latin1"));
	if (!head) return refused(new DirectNoiseRejected("malformed reply"));
	const body = buffered.subarray(end + 4);
	if (head.status !== "101") return readNonSwitch(head.status, head.headers, body, closed);
	// The client sends Message A only after the switch, so nothing may follow it yet.
	if (body.byteLength !== 0) return refused(new DirectNoiseRejected("data after the switch"));
	return { kind: "switched" };
}
