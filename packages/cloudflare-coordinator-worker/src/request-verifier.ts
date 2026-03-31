import {
	type CoordinatorRequestVerifier,
	DEFAULT_TIME_WINDOW_S,
} from "@codemem/core/internal/cloudflare-coordinator";

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function buildSpkiDer(rawKey: Uint8Array): Uint8Array {
	const prefix = Uint8Array.from([
		0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
	]);
	const spki = new Uint8Array(prefix.length + rawKey.length);
	spki.set(prefix, 0);
	spki.set(rawKey, prefix.length);
	return spki;
}

async function importSshEd25519PublicKey(publicKey: string): Promise<CryptoKey> {
	const parts = publicKey.trim().split(/\s+/);
	if (parts.length < 2 || parts[0] !== "ssh-ed25519") {
		throw new Error("not an ssh-ed25519 key");
	}
	const wire = base64ToBytes(parts[1]!);
	if (wire.length < 4) throw new Error("truncated wire format");
	const typeLen = readUint32BE(wire, 0);
	const typeEnd = 4 + typeLen;
	if (wire.length < typeEnd + 4) throw new Error("truncated wire format");
	const keyLen = readUint32BE(wire, typeEnd);
	const keyStart = typeEnd + 4;
	if (wire.length < keyStart + keyLen) throw new Error("truncated wire format");
	const rawKey = wire.slice(keyStart, keyStart + keyLen);
	if (rawKey.length !== 32) throw new Error(`unexpected Ed25519 key length: ${rawKey.length}`);
	return crypto.subtle.importKey(
		"spki",
		toArrayBuffer(buildSpkiDer(rawKey)),
		{ name: "Ed25519" },
		false,
		["verify"],
	);
}

async function buildCanonicalRequest(
	method: string,
	pathWithQuery: string,
	timestamp: string,
	nonce: string,
	bodyBytes: Uint8Array,
): Promise<Uint8Array> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bodyBytes)));
	const canonical = [
		method.toUpperCase(),
		pathWithQuery,
		timestamp,
		nonce,
		bytesToHex(digest),
	].join("\n");
	return textEncoder.encode(canonical);
}

export const verifyCloudflareCoordinatorRequest: CoordinatorRequestVerifier = async (input) => {
	if (!/^\d+$/.test(input.timestamp)) return false;
	const timestamp = Number.parseInt(input.timestamp, 10);
	if (Number.isNaN(timestamp)) return false;
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - timestamp) > DEFAULT_TIME_WINDOW_S) return false;

	const colonIndex = input.signature.indexOf(":");
	if (colonIndex < 1) return false;
	const version = input.signature.slice(0, colonIndex);
	if (!version || !["v1", "v2"].includes(version)) return false;
	const encodedSignature = input.signature.slice(colonIndex + 1);
	if (!encodedSignature) return false;

	try {
		const [key, canonical, signatureBytes] = await Promise.all([
			importSshEd25519PublicKey(input.publicKey),
			buildCanonicalRequest(
				input.method,
				input.pathWithQuery,
				input.timestamp,
				input.nonce,
				input.bodyBytes,
			),
			Promise.resolve(base64ToBytes(encodedSignature)),
		]);
		return await crypto.subtle.verify(
			"Ed25519",
			key,
			toArrayBuffer(signatureBytes),
			toArrayBuffer(canonical),
		);
	} catch {
		return false;
	}
};
