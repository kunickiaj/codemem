export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_DATA_FRAME_KIND = 1;
export const RELAY_DATA_FRAME_HEADER_BYTES = 22;
export const RELAY_MAX_NOISE_FRAGMENT_BYTES = 65_536;

export interface RelayDataFrame {
	readonly sessionId: string;
	readonly payload: Uint8Array;
}

export class RelayFrameError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "RelayFrameError";
		this.code = code;
	}
}

function validatePayloadLength(length: number): void {
	if (!Number.isInteger(length) || length < 1 || length > RELAY_MAX_NOISE_FRAGMENT_BYTES) {
		throw new RelayFrameError("invalid_payload_length", "Invalid relay payload length.");
	}
}

export function encodeRelayDataFrame(frame: RelayDataFrame): Uint8Array {
	if (
		typeof frame !== "object" ||
		frame === null ||
		typeof frame.sessionId !== "string" ||
		frame.sessionId.length !== 32 ||
		!/^[0-9a-f]{32}$/.test(frame.sessionId)
	) {
		throw new RelayFrameError("invalid_session_id", "Invalid relay session ID.");
	}
	if (!(frame.payload instanceof Uint8Array)) {
		throw new RelayFrameError("invalid_payload_length", "Invalid relay payload byte buffer.");
	}
	validatePayloadLength(frame.payload.byteLength);
	const bytes = new Uint8Array(RELAY_DATA_FRAME_HEADER_BYTES + frame.payload.byteLength);
	bytes[0] = RELAY_PROTOCOL_VERSION;
	bytes[1] = RELAY_DATA_FRAME_KIND;
	for (let index = 0; index < 16; index += 1) {
		bytes[index + 2] = Number.parseInt(frame.sessionId.slice(index * 2, index * 2 + 2), 16);
	}
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
		18,
		frame.payload.byteLength,
	);
	bytes.set(frame.payload, RELAY_DATA_FRAME_HEADER_BYTES);
	return bytes;
}

export function decodeRelayDataFrame(bytes: Uint8Array): RelayDataFrame {
	if (!(bytes instanceof Uint8Array)) {
		throw new RelayFrameError("invalid_frame", "Invalid relay frame byte buffer.");
	}
	if (bytes.byteLength < RELAY_DATA_FRAME_HEADER_BYTES) {
		throw new RelayFrameError("truncated_header", "Incomplete relay frame header.");
	}
	if (bytes.byteLength > RELAY_DATA_FRAME_HEADER_BYTES + RELAY_MAX_NOISE_FRAGMENT_BYTES) {
		throw new RelayFrameError("frame_too_large", "Relay frame exceeds the size limit.");
	}
	if (bytes[0] !== RELAY_PROTOCOL_VERSION) {
		throw new RelayFrameError("unsupported_version", "Unsupported relay frame version.");
	}
	if (bytes[1] !== RELAY_DATA_FRAME_KIND) {
		throw new RelayFrameError("unsupported_kind", "Unsupported relay frame kind.");
	}
	const payloadLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
		18,
	);
	validatePayloadLength(payloadLength);
	if (bytes.byteLength !== RELAY_DATA_FRAME_HEADER_BYTES + payloadLength) {
		throw new RelayFrameError("length_mismatch", "Relay frame length does not match its header.");
	}
	let sessionId = "";
	for (const byte of bytes.subarray(2, 18)) {
		sessionId += byte.toString(16).padStart(2, "0");
	}
	// Construct explicitly so Buffer inputs cannot return an aliased Buffer slice.
	const payload = new Uint8Array(bytes.subarray(RELAY_DATA_FRAME_HEADER_BYTES));
	return { sessionId, payload };
}
