import { createHash } from "node:crypto";

export const RELAY_NOISE_OPENING_BYTES = 34;

/** The sole wire-format check outside the library: pinned XX Message A, with no payload. */
export class RelayNoiseOpening {
	private readonly bytes = Buffer.alloc(RELAY_NOISE_OPENING_BYTES);
	private length = 0;
	private terminal = false;

	append(chunk: Uint8Array): Uint8Array | undefined {
		if (this.terminal) throw new Error("Noise opening already consumed");
		if (!(chunk instanceof Uint8Array) || chunk.byteLength > this.bytes.length - this.length) {
			this.terminal = true;
			throw new Error("Extra early Noise data");
		}
		this.bytes.set(chunk, this.length);
		this.length += chunk.byteLength;
		if (this.length >= 2 && this.bytes.readUInt16BE(0) !== 32) {
			this.terminal = true;
			throw new Error("Invalid Noise opening length");
		}
		if (this.length !== this.bytes.length) return;
		this.terminal = true;
		return Uint8Array.from(this.bytes);
	}

	end(): void {
		this.terminal = true;
		if (this.length !== this.bytes.length) throw new Error("Truncated Noise opening");
	}
}

export function relayNoiseOpeningDigest(bytes: Uint8Array): string {
	const opening = new RelayNoiseOpening();
	opening.append(bytes);
	opening.end();
	return createHash("sha256").update(bytes).digest("hex");
}

/** The caller must independently verify admission before supplying this digest. */
export function validateRelayNoiseOpeningDigest(digest: string): void {
	if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
		throw new Error("Invalid verified Noise opening digest");
	}
}
