import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	parseRelayEd25519PublicKey,
	RelayPublicKeyError,
	relayEd25519KeyId,
} from "./relay-ed25519.js";

function sshString(bytes: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
}

function syntheticPublicKey() {
	// Only a synthetic public key leaves this helper. Private material stays in memory.
	const { publicKey } = generateKeyPairSync("ed25519");
	const jwk = publicKey.export({ format: "jwk" });
	if (!jwk.x) throw new Error("Synthetic Ed25519 public JWK has no x coordinate");
	const rawKey = Buffer.from(jwk.x, "base64url");
	const wireKey = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(rawKey)]);
	return { rawKey, wireKey, text: `ssh-ed25519 ${wireKey.toString("base64")}` };
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("relay Ed25519 public-key format", () => {
	it.each(["", " synthetic test key", " comment with spaces !"])(
		"parses the exact JWK public bytes with comment %j",
		(comment) => {
			// Arrange
			const key = syntheticPublicKey();
			// Act
			const parsed = parseRelayEd25519PublicKey(key.text + comment);
			// Assert
			expect(parsed.rawKey).toBeInstanceOf(Uint8Array);
			expect(Buffer.from(parsed.rawKey)).toEqual(key.rawKey);
			expect(Buffer.from(parsed.wireKey)).toEqual(key.wireKey);
			expect(parsed.wireKey.byteLength).toBe(51);
		},
	);

	it("matches the existing identity and native SHA-256 of the canonical SSH blob", async () => {
		// Arrange
		const key = syntheticPublicKey();
		// Act
		const id = await relayEd25519KeyId(key.text);
		const commentedId = await relayEd25519KeyId(`${key.text} synthetic comment`);
		const existingId = await ed25519KeyId(key.text);
		// Assert
		expect(id).toBe(sha256(key.wireKey));
		expect(id).toBe(existingId);
		expect(commentedId).toBe(id);
		expect(id).not.toBe(sha256(key.rawKey));
		expect(id).not.toBe(sha256(key.text));
	});

	it("returns independent owned raw and wire bytes on every parse", () => {
		// Arrange
		const key = syntheticPublicKey();
		const first = parseRelayEd25519PublicKey(key.text);
		const second = parseRelayEd25519PublicKey(key.text);
		// Act
		first.rawKey.fill(0);
		// Assert
		expect(Buffer.from(first.wireKey)).toEqual(key.wireKey);
		expect(Buffer.from(second.rawKey)).toEqual(key.rawKey);
		// Act
		first.wireKey.fill(255);
		// Assert
		expect(Buffer.from(second.wireKey)).toEqual(key.wireKey);
		expect(Buffer.from(second.rawKey)).toEqual(key.rawKey);
	});
});

describe("relay Ed25519 malformed public keys", () => {
	const malformed = [
		["empty text", () => ""],
		["missing blob", () => "ssh-ed25519"],
		[
			"outer key type",
			(key: ReturnType<typeof syntheticPublicKey>) => key.text.replace("ssh-ed25519", "ssh-rsa"),
		],
		["invalid base64 alphabet", () => "ssh-ed25519 !!!!!"],
		[
			"base64 with padding on a 51-byte blob",
			(key: ReturnType<typeof syntheticPublicKey>) => `${key.text}=`,
		],
		[
			"base64 with embedded whitespace",
			(key: ReturnType<typeof syntheticPublicKey>) => key.text.replace("AAAAC3", "AAA AC3"),
		],
		["truncated base64", (key: ReturnType<typeof syntheticPublicKey>) => key.text.slice(0, -1)],
		["newline before key", (key: ReturnType<typeof syntheticPublicKey>) => `\n${key.text}`],
		[
			"newline in comment",
			(key: ReturnType<typeof syntheticPublicKey>) => `${key.text} test\nsecond line`,
		],
		[
			"CR in comment",
			(key: ReturnType<typeof syntheticPublicKey>) => `${key.text} test\rsecond line`,
		],
		[
			"wrong inner type",
			(key: ReturnType<typeof syntheticPublicKey>) => {
				const wire = Buffer.from(key.wireKey);
				wire[4] = 120;
				return `ssh-ed25519 ${wire.toString("base64")}`;
			},
		],
		[
			"inner type length",
			(key: ReturnType<typeof syntheticPublicKey>) => {
				const wire = Buffer.from(key.wireKey);
				wire.writeUInt32BE(10, 0);
				return `ssh-ed25519 ${wire.toString("base64")}`;
			},
		],
		[
			"oversized inner length",
			(key: ReturnType<typeof syntheticPublicKey>) => {
				const wire = Buffer.from(key.wireKey);
				wire.writeUInt32BE(0xffffffff, 0);
				return `ssh-ed25519 ${wire.toString("base64")}`;
			},
		],
		[
			"wrong public-key length",
			(key: ReturnType<typeof syntheticPublicKey>) => {
				const wire = Buffer.from(key.wireKey);
				wire.writeUInt32BE(31, 15);
				return `ssh-ed25519 ${wire.toString("base64")}`;
			},
		],
		[
			"truncated wire bytes",
			(key: ReturnType<typeof syntheticPublicKey>) =>
				`ssh-ed25519 ${key.wireKey.subarray(0, 50).toString("base64")}`,
		],
		[
			"trailing wire bytes",
			(key: ReturnType<typeof syntheticPublicKey>) =>
				`ssh-ed25519 ${Buffer.concat([key.wireKey, Buffer.from([0])]).toString("base64")}`,
		],
		[
			"noncanonical base64 pad bits",
			(key: ReturnType<typeof syntheticPublicKey>) => {
				const encoded = key.wireKey.subarray(0, 50).toString("base64");
				const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
				const last = alphabet.indexOf(encoded.at(-2) ?? "");
				return `ssh-ed25519 ${encoded.slice(0, -2)}${alphabet[last + 1]}=`;
			},
		],
	] as const;

	it.each(malformed)("rejects %s in both parsing and identity", async (_name, makeText) => {
		// Arrange
		const text = makeText(syntheticPublicKey());
		// Act
		const parse = () => parseRelayEd25519PublicKey(text);
		const identify = relayEd25519KeyId(text);
		// Assert
		expect(parse).toThrow(RelayPublicKeyError);
		await expect(identify).rejects.toBeInstanceOf(RelayPublicKeyError);
	});
});
