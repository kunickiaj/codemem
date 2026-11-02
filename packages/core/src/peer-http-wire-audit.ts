import { PEER_HTTP_LIMITS, PeerHttpExchangeError } from "./peer-http-policy.js";

export type PeerHttpWireAuditState = "headers" | "body" | "ended" | "failed";

export interface PeerHttpWireAuditOptions {
	direction: "request" | "response";
	maxHeaderBytes?: number;
	maxBodyBytes?: number;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const nativeTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const nativeValues = Uint8Array.prototype.values;

function lowerLimit(value: number | undefined, minimum: number, maximum: number): number {
	const limit = value === undefined ? maximum : value;
	if (!Number.isSafeInteger(limit) || limit < minimum || limit > maximum)
		throw new PeerHttpExchangeError("framing");
	return limit;
}

function captureLimits(options: PeerHttpWireAuditOptions) {
	try {
		const { direction, maxHeaderBytes, maxBodyBytes } = options;
		if (direction !== "request" && direction !== "response")
			throw new PeerHttpExchangeError("framing");
		const bodyCap =
			direction === "request" ? PEER_HTTP_LIMITS.requestBytes : PEER_HTTP_LIMITS.responseBytes;
		return {
			header: lowerLimit(maxHeaderBytes, 4, PEER_HTTP_LIMITS.headerBytes),
			body: lowerLimit(maxBodyBytes, 0, bodyCap),
		};
	} catch {
		throw new PeerHttpExchangeError("framing");
	}
}

/** Constant-space byte accounting only. Native HTTP still owns syntax and body policy.
 * Install the observer BEFORE the native parser on an owned pure-JS RelayNoiseDuplex,
 * excluding native Socket parser.consume bypass. Catch throws and destroy the owned connection.
 * Retain observation through plaintext EOF after parser removal, then call finish(), never at
 * HTTP message end. Success also requires native completion/body policy and clean raw I/O/disposal.
 * This audit alone proves neither HTTP syntax, authentication, completeness nor RTC bounds. */
export class PeerHttpWireAudit {
	private readonly limits: ReturnType<typeof captureLimits>;
	private current: PeerHttpWireAuditState = "headers";
	private failure?: PeerHttpExchangeError;
	private total = 0;
	private headerBytes = 0;
	private matched = 0;
	private expectedBody?: number;

	constructor(options: PeerHttpWireAuditOptions) {
		this.limits = captureLimits(options);
	}

	get state(): PeerHttpWireAuditState {
		return this.current;
	}

	private fail(): never {
		this.failure ??= new PeerHttpExchangeError("framing");
		this.current = "failed";
		throw this.failure;
	}

	private requireActive(): void {
		if (this.current === "failed" || this.current === "ended") this.fail();
	}

	observe(chunk: unknown): void {
		try {
			this.requireActive();
			if (nativeTag?.call(chunk) !== "Uint8Array") this.fail();
			// Validates attachment without consulting caller metadata, species or iteration hooks.
			nativeValues.call(chunk as Uint8Array);
			const length: number = nativeByteLength?.call(chunk);
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > this.limits.header + this.limits.body - this.total
			)
				this.fail();
			this.total += length;
			for (let index = 0; index < length && this.current === "headers"; index++) {
				this.observeHeaderByte((chunk as Uint8Array)[index] ?? 0);
			}
			this.checkBodyLength();
		} catch {
			this.fail();
		}
	}

	private observeHeaderByte(byte: number): void {
		this.headerBytes++;
		const expected = this.matched === 0 || this.matched === 2 ? 13 : 10;
		if (byte === expected) this.matched++;
		else this.matched = byte === 13 ? 1 : 0;
		if (this.matched === 4) {
			this.current = "body";
			return;
		}
		if (this.headerBytes >= this.limits.header) this.fail();
	}

	private checkBodyLength(): void {
		if (this.current !== "body") return;
		const bodyBytes = this.total - this.headerBytes;
		if (
			bodyBytes > this.limits.body ||
			(this.expectedBody !== undefined && bodyBytes > this.expectedBody)
		)
			this.fail();
	}

	/** Call once from the native message event after validating rawHeaders and Content-Length. */
	expectBodyBytes(length: number): void {
		this.requireActive();
		if (
			this.current !== "body" ||
			this.expectedBody !== undefined ||
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > this.limits.body
		)
			this.fail();
		this.expectedBody = length;
		this.checkBodyLength();
	}

	/** Plaintext EOF only. Repeated successful finish() calls are idempotent. */
	finish(): void {
		if (this.current === "ended") return;
		this.requireActive();
		if (
			this.current !== "body" ||
			this.expectedBody === undefined ||
			this.total !== this.headerBytes + this.expectedBody
		)
			this.fail();
		this.current = "ended";
	}
}
