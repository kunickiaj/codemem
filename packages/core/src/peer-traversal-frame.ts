export const TRAVERSAL_FRAME_VERSION = 1;
export const TRAVERSAL_FRAME_HEADER_BYTES = 2;
export const TRAVERSAL_MAX_FRAME_PAYLOAD_BYTES = 8192;
export const TRAVERSAL_MAX_FRAME_BYTES =
	TRAVERSAL_FRAME_HEADER_BYTES + TRAVERSAL_MAX_FRAME_PAYLOAD_BYTES;

export type TraversalFrame =
	| { readonly kind: "data"; readonly payload: Uint8Array }
	| { readonly kind: "end" };
export type TraversalFrameEncoderState = "open" | "ended" | "failed";
export type TraversalFrameDecoderState = TraversalFrameEncoderState | "truncated";

const typedArrayByteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;

export class TraversalFrameError extends Error {
	constructor(readonly code: string) {
		super("Invalid traversal frame or codec state.");
		this.name = "TraversalFrameError";
	}
}

function requireOpen(state: TraversalFrameEncoderState): void {
	if (state !== "open") throw new TraversalFrameError("codec_closed");
}

function readByteLength(bytes: Uint8Array, errorCode: string): number {
	let length: unknown;
	try {
		// Ignore shadowed properties and reject objects without real typed-array storage.
		length = typedArrayByteLength?.call(bytes);
	} catch {
		throw new TraversalFrameError(errorCode);
	}
	if (typeof length !== "number" || !Number.isInteger(length)) {
		throw new TraversalFrameError(errorCode);
	}
	return length;
}

function capturePayload(payload: unknown) {
	if (!(payload instanceof Uint8Array)) {
		throw new TraversalFrameError("invalid_payload_length");
	}
	const length = readByteLength(payload, "invalid_payload_length");
	if (length < 1 || length > TRAVERSAL_MAX_FRAME_PAYLOAD_BYTES) {
		throw new TraversalFrameError("invalid_payload_length");
	}
	return { bytes: payload, length };
}

/** Pure outer framing only. It creates no transport and authenticates no bytes. */
export class TraversalFrameEncoder {
	private status: TraversalFrameEncoderState = "open";

	get state(): TraversalFrameEncoderState {
		return this.status;
	}

	encodeData(payload: unknown): Uint8Array {
		try {
			requireOpen(this.status);
			const captured = capturePayload(payload);
			const bytes = new Uint8Array(TRAVERSAL_FRAME_HEADER_BYTES + captured.length);
			bytes[0] = TRAVERSAL_FRAME_VERSION;
			bytes[1] = 0;
			bytes.set(captured.bytes, TRAVERSAL_FRAME_HEADER_BYTES);
			return bytes;
		} catch (error) {
			this.status = "failed";
			throw error;
		}
	}

	encodeEnd(): Uint8Array {
		try {
			requireOpen(this.status);
			const bytes = new Uint8Array([TRAVERSAL_FRAME_VERSION, 1]);
			this.status = "ended";
			return bytes;
		} catch (error) {
			this.status = "failed";
			throw error;
		}
	}
}

function decodeFrame(bytes: unknown): TraversalFrame {
	if (!(bytes instanceof Uint8Array)) {
		throw new TraversalFrameError("invalid_frame");
	}
	const frameLength = readByteLength(bytes, "invalid_frame");
	if (frameLength < TRAVERSAL_FRAME_HEADER_BYTES) {
		throw new TraversalFrameError("invalid_frame");
	}
	// This bounds our returned copy, not the RTC library's earlier reassembly.
	if (frameLength > TRAVERSAL_MAX_FRAME_BYTES) {
		throw new TraversalFrameError("frame_too_large");
	}
	if (bytes[0] !== TRAVERSAL_FRAME_VERSION) {
		throw new TraversalFrameError("unsupported_version");
	}
	if (bytes[1] === 1) {
		if (frameLength !== TRAVERSAL_FRAME_HEADER_BYTES) {
			throw new TraversalFrameError("invalid_end");
		}
		return { kind: "end" };
	}
	if (bytes[1] !== 0) throw new TraversalFrameError("unsupported_kind");
	const payloadLength = frameLength - TRAVERSAL_FRAME_HEADER_BYTES;
	if (payloadLength < 1) throw new TraversalFrameError("invalid_payload_length");
	const payload = new Uint8Array(payloadLength);
	// Typed-array subarray still invokes caller-controlled Symbol.species constructors.
	for (let index = 0; index < payloadLength; index++) {
		const byte = bytes[index + TRAVERSAL_FRAME_HEADER_BYTES];
		if (byte === undefined) throw new TraversalFrameError("invalid_frame");
		payload[index] = byte;
	}
	return { kind: "data", payload };
}

/** Accepts complete ordered messages. EOF is not application completeness or an ACK. */
export class TraversalFrameDecoder {
	private status: TraversalFrameDecoderState = "open";

	get state(): TraversalFrameDecoderState {
		return this.status;
	}

	decode(bytes: unknown): TraversalFrame {
		// Late callbacks cannot turn a lost transport into a clean end.
		if (this.status === "truncated" || this.status === "failed") {
			throw new TraversalFrameError("codec_closed");
		}
		try {
			if (this.status === "ended") throw new TraversalFrameError("after_end");
			const frame = decodeFrame(bytes);
			if (frame.kind === "end") this.status = "ended";
			return frame;
		} catch (error) {
			this.status = "failed";
			throw error;
		}
	}

	/** Does not retain or discard returned payloads. The future adapter must drain them. */
	close(): Exclude<TraversalFrameDecoderState, "open"> {
		if (this.status === "open") this.status = "truncated";
		return this.status;
	}
}
