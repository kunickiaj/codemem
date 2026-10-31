import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	decodeRelayCheckPacket,
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
	type RelayAdmissionBody,
	type RelayCheckPacket,
} from "./relay-admission-codec.js";
import {
	type RelayProofExpectation,
	type RelayProofVerificationOptions,
	verifyRelayCheckProof,
} from "./relay-admission-proof.js";
import { buildCanonicalRequest } from "./sync-auth.js";

const PATH = "/v1/relay/admission-check";
const PREFIXED_PATH = `/configured/coordinator${PATH}`;
const NONCE = "0123456789abcdef".repeat(2);
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function syntheticKey() {
	// Disposable key material never leaves memory or reaches a configured identity.
	const keys = generateKeyPairSync("ed25519");
	const spki = keys.publicKey.export({ type: "spki", format: "der" });
	const raw = spki.subarray(-32);
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	return {
		...keys,
		raw,
		spki,
		wire,
		text: `ssh-ed25519 ${wire.toString("base64")} disposable fixture`,
		keyId: sha256(wire),
	};
}

function fixture(
	expected: RelayProofExpectation = { kind: "admission", role: "source" },
	overrides: Partial<RelayAdmissionBody> = {},
) {
	const key = syntheticKey();
	const body: RelayAdmissionBody = {
		role: "source",
		authorityId: "a".repeat(64),
		groupId: "e\u0301-group",
		sourceDeviceId: "source",
		sourceKeyId: key.keyId,
		targetDeviceId: "target",
		targetKeyId: "c".repeat(64),
		relayAudienceId: "d".repeat(64),
		routeSessionId: "e".repeat(32),
		messageADigest: "f".repeat(64),
		createdAt: 100,
		admitBefore: 130,
		routeNotAfter: 155,
		...overrides,
	};
	if (expected.kind === "admission") Object.assign(body, { role: expected.role });
	const value =
		expected.kind === "registration"
			? {
					authorityId: body.authorityId,
					groupId: body.groupId,
					deviceId: body.sourceDeviceId,
					keyId: body.sourceKeyId,
					relayAudienceId: body.relayAudienceId,
					socketChallengeId: body.routeSessionId,
					createdAt: body.createdAt,
					admitBefore: body.admitBefore,
				}
			: body;
	const bodyBytes =
		"role" in value ? encodeRelayAdmissionBody(value) : encodeRelayRegistrationBody(value);
	function signedPacket(
		options: {
			bytes?: Uint8Array;
			method?: string;
			path?: string;
			timestamp?: string;
			signedTimestamp?: string;
			nonce?: string;
			suffix?: string;
		} = {},
	) {
		const bytes = options.bytes ?? bodyBytes;
		const timestamp = options.timestamp ?? String(value.createdAt);
		const nonce = options.nonce ?? NONCE;
		const canonical = buildCanonicalRequest(
			options.method ?? "POST",
			options.path ?? PATH,
			options.signedTimestamp ?? timestamp,
			nonce,
			Buffer.from(bytes),
		);
		const signatureBytes = sign(
			null,
			Buffer.concat([canonical, Buffer.from(options.suffix ?? "")]),
			key.privateKey,
		);
		return encodeRelayCheckPacket({ bodyBytes: bytes, timestamp, nonce, signatureBytes });
	}
	const packet = { ...signedPacket() };
	const signer = { deviceId: "source", publicKey: key.text };
	const options: RelayProofVerificationOptions = {
		packet,
		expected,
		signer,
		deviceHeader: "source",
		externalPathname: PATH,
	};
	return { key, body, value, bodyBytes, signedPacket, packet, signer, expected, options };
}

function hashBarrier() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
	vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
		entered.resolve();
		await release.promise;
		return digest(...args);
	});
	return { entered, release };
}

function countAccessorReads(options: {
	object: object;
	field: string;
	name: string;
	reads: Map<string, number>;
	first: unknown;
	later: unknown;
}) {
	Object.defineProperty(options.object, options.field, {
		enumerable: true,
		get() {
			const count = (options.reads.get(options.name) ?? 0) + 1;
			options.reads.set(options.name, count);
			return count === 1 ? options.first : options.later;
		},
	});
}

function instrumentInputs(f: ReturnType<typeof fixture>, initial: string) {
	const reads = new Map<string, number>();
	const groups = [
		["packet", f.packet],
		["expected", f.expected],
		["signer", f.signer],
		["options", f.options],
	] as const;
	for (const [group, object] of groups) {
		for (const field of Object.keys(object)) {
			const value: unknown = Reflect.get(object, field);
			const name = `${group}.${field}`;
			const invalid = name === "signer.publicKey" && initial === "invalid";
			countAccessorReads({
				object,
				field,
				name,
				reads,
				first: invalid ? "invalid" : value,
				later: invalid ? value : undefined,
			});
		}
	}
	return reads;
}

afterEach(() => vi.restoreAllMocks());

describe("relay proof native signatures and evidence", () => {
	it.each(["source", "relay", "responder"] as const)(
		"verifies %s admission signed by the source, regardless of the forwarder role",
		async (role) => {
			// Arrange
			const f = fixture({ kind: "admission", role });
			// Act
			const proof = await verifyRelayCheckProof(f.options);
			// Assert: old timestamps prove possession only, never current admission authority.
			expect(proof).toEqual({
				...decodeRelayCheckPacket(f.packet),
				signer: { ...f.signer, keyId: sha256(f.key.wire) },
				packetDigest: sha256(f.bodyBytes),
			});
			expect(proof?.value).toEqual(f.value);
			for (const field of ["eligible", "registered", "remainingMs", "grant"]) {
				expect(proof).not.toHaveProperty(field);
			}
			expect(proof?.signer.keyId).not.toBe(sha256(f.key.raw));
			expect(proof?.signer.keyId).not.toBe(sha256(f.key.spki));
			expect(proof?.signer.keyId).not.toBe(sha256(f.key.text));
		},
	);

	it("verifies registration with the registration device pin", async () => {
		// Arrange
		const f = fixture({ kind: "registration" });
		// Act
		const proof = await verifyRelayCheckProof(f.options);
		// Assert
		expect(proof).toMatchObject({
			kind: "registration",
			value: f.value,
			signer: { ...f.signer, keyId: f.key.keyId },
			packetDigest: sha256(f.bodyBytes),
		});
		expect(Buffer.from(proof?.bodyBytes ?? [])).toEqual(Buffer.from(f.bodyBytes));
	});

	it("binds the actual configured prefix and preserves the exact nonce and original bytes", async () => {
		// Arrange
		const f = fixture();
		const packet = f.signedPacket({ path: PREFIXED_PATH });
		const options = { ...f.options, packet, externalPathname: PREFIXED_PATH };
		// Act
		const proof = await verifyRelayCheckProof(options);
		const rewritten = await verifyRelayCheckProof({ ...options, externalPathname: PATH });
		// Assert
		expect(proof?.nonce).toBe(NONCE);
		expect(proof?.timestamp).toBe("100");
		expect(proof?.packetDigest).toBe(sha256(f.bodyBytes));
		expect(Buffer.from(proof?.bodyBytes ?? [])).toEqual(Buffer.from(f.bodyBytes));
		expect(rewritten).toBeNull();
	});

	it("returns independent owned arrays, values, and signer evidence on repeated verification", async () => {
		// Arrange
		const f = fixture();
		const first = await verifyRelayCheckProof(f.options);
		const second = await verifyRelayCheckProof(f.options);
		const originalSignature = Buffer.from(f.packet.signature.slice(3), "base64");
		// Act
		first?.bodyBytes.fill(0);
		first?.signatureBytes.fill(0);
		if (first) {
			Object.assign(first.value, { groupId: "changed" });
			Object.assign(first.signer, { deviceId: "changed" });
		}
		f.packet.body = "changed";
		f.signer.publicKey = "changed";
		// Assert
		expect(first).not.toBeNull();
		expect(second?.value).toEqual(f.value);
		expect(second?.signer).toEqual({
			deviceId: "source",
			publicKey: f.key.text,
			keyId: f.key.keyId,
		});
		expect(Buffer.from(second?.bodyBytes ?? [])).toEqual(Buffer.from(f.bodyBytes));
		expect(Buffer.from(second?.signatureBytes ?? [])).toEqual(originalSignature);
		expect(second?.packetDigest).toBe(sha256(f.bodyBytes));
	});
});

describe("relay proof rejects substitutions", () => {
	it.each([
		{ authorityId: "1".repeat(64) },
		{ groupId: "other-group" },
		{ sourceDeviceId: "other-source" },
		{ sourceKeyId: "2".repeat(64) },
		{ targetDeviceId: "other-target" },
		{ targetKeyId: "3".repeat(64) },
		{ relayAudienceId: "4".repeat(64) },
		{ routeSessionId: "5".repeat(32) },
		{ messageADigest: "6".repeat(64) },
		{ createdAt: 101, admitBefore: 131, routeNotAfter: 156 },
	])("rejects a different valid canonical body %j with the original signature", async (change) => {
		// Arrange: all replacements pass the codec so signature/context checks must reject them.
		const f = fixture();
		const bytes = encodeRelayAdmissionBody({ ...f.body, ...change });
		const packet = {
			...f.packet,
			body: Buffer.from(bytes).toString("base64url"),
			timestamp: String(change.createdAt ?? f.body.createdAt),
		};
		expect(() => decodeRelayCheckPacket(packet)).not.toThrow();
		// Act
		const proof = await verifyRelayCheckProof({ ...f.options, packet });
		// Assert
		expect(proof).toBeNull();
	});

	it.each(["GET", "path", "timestamp", "nonce", "newline", "signature"])(
		"rejects a signature substituted across %s",
		async (fault) => {
			// Arrange
			const f = fixture();
			let packet: RelayCheckPacket = f.packet;
			if (fault === "GET") packet = f.signedPacket({ method: "GET" });
			if (fault === "path") packet = f.signedPacket({ path: PREFIXED_PATH });
			if (fault === "timestamp") packet = f.signedPacket({ signedTimestamp: "101" });
			if (fault === "nonce") packet = { ...f.packet, nonce: "a".repeat(32) };
			if (fault === "newline") packet = f.signedPacket({ suffix: "\n" });
			if (fault === "signature") packet = { ...f.packet, signature: fixture().packet.signature };
			// Act
			const proof = await verifyRelayCheckProof({ ...f.options, packet });
			// Assert
			expect(proof).toBeNull();
		},
	);

	it.each(["source", "relay", "responder", "registration"] as const)(
		"rejects wrong pin, key ID, header, or signer identity for %s",
		async (kind) => {
			// Arrange
			const expected: RelayProofExpectation =
				kind === "registration" ? { kind } : { kind: "admission", role: kind };
			const f = fixture(expected);
			const wrongKeyId = fixture(expected, { sourceKeyId: "9".repeat(64) });
			const inputs = [
				{ ...f.options, signer: { ...f.signer, publicKey: syntheticKey().text } },
				wrongKeyId.options,
				{ ...f.options, deviceHeader: "forwarder" },
				{ ...f.options, signer: { ...f.signer, deviceId: "forwarder" } },
				{ ...f.options, deviceHeader: "forwarder", signer: { ...f.signer, deviceId: "forwarder" } },
				{ ...f.options, signer: { ...f.signer, publicKey: "ssh-ed25519 invalid" } },
			];
			// Act
			const proofs = await Promise.all(inputs.map(verifyRelayCheckProof));
			// Assert
			expect(proofs).toEqual(inputs.map(() => null));
		},
	);

	it.each([
		{ kind: "registration" },
		{ kind: "admission", role: "relay" },
		{ kind: "admission", role: "responder" },
		{ kind: "unknown" },
		{ kind: "admission", role: "unknown" },
		null,
	])("rejects unexpected purpose or role %j", async (expected) => {
		// Arrange
		const f = fixture();
		// Act: Reflect exercises invalid JavaScript inputs without suppressing type checks.
		const proof = await Reflect.apply(verifyRelayCheckProof, undefined, [
			{ ...f.options, expected },
		]);
		// Assert
		expect(proof).toBeNull();
	});

	it("rejects a valid registration packet in an admission context", async () => {
		// Arrange
		const f = fixture({ kind: "registration" });
		// Act
		const proof = await verifyRelayCheckProof({
			...f.options,
			expected: { kind: "admission", role: "source" },
		});
		// Assert
		expect(proof).toBeNull();
	});
});

describe("relay proof path and packet syntax", () => {
	it.each([
		"v1/relay/admission-check",
		`https://coordinator.example.test${PATH}`,
		`${PATH}?query=1`,
		`${PATH}#fragment`,
		`${PATH}\n`,
		`${PATH}\r`,
		`/prefix\u0000${PATH}`,
		`/prefix\u007f${PATH}`,
		`/prefix\\${PATH}`,
		`${PATH}/`,
		"/v1/relay/other-check",
		`/\ud800${PATH}`,
		`/\udfff${PATH}`,
	])("rejects non-path or wrong endpoint %j even if signed exactly", async (path) => {
		// Arrange
		const f = fixture({ kind: "registration" });
		const packet = f.signedPacket({ path });
		// Act
		const proof = await verifyRelayCheckProof({ ...f.options, packet, externalPathname: path });
		// Assert
		expect(proof).toBeNull();
	});

	it("rejects distinct malformed prefixes that encode to identical signature bytes", async () => {
		// Arrange: Node replaces both unpaired surrogates with the same UTF-8 replacement scalar.
		const f = fixture({ kind: "registration" });
		const signedPath = `/\ud800${PATH}`;
		const substitutedPath = `/\ud801${PATH}`;
		const packet = f.signedPacket({ path: signedPath });
		expect(Buffer.from(signedPath)).toEqual(Buffer.from(substitutedPath));
		// Act
		const proof = await verifyRelayCheckProof({
			...f.options,
			packet,
			externalPathname: substitutedPath,
		});
		// Assert
		expect(proof).toBeNull();
	});

	it("verifies a literal Unicode and astral prefix without normalizing the signed path", async () => {
		// Arrange
		const f = fixture({ kind: "registration" });
		const path = `/組/😀/e\u0301${PATH}`;
		const packet = f.signedPacket({ path });
		// Act
		const proof = await verifyRelayCheckProof({ ...f.options, packet, externalPathname: path });
		const normalized = await verifyRelayCheckProof({
			...f.options,
			packet,
			externalPathname: path.normalize("NFC"),
		});
		// Assert
		expect(proof?.packetDigest).toBe(sha256(f.bodyBytes));
		expect(proof?.signer.keyId).toBe(f.key.keyId);
		expect(normalized).toBeNull();
	});

	it.each(["v1", "body-padding", "noncanonical-json", "nonce-case", "extra"])(
		"returns generic null for malformed %s",
		async (fault) => {
			// Arrange
			const f = fixture();
			const packet = { ...f.packet };
			if (fault === "v1") packet.signature = packet.signature.replace("v2:", "v1:");
			if (fault === "body-padding") packet.body += "=";
			if (fault === "noncanonical-json")
				packet.body = Buffer.from(` ${Buffer.from(f.bodyBytes).toString()}`).toString("base64url");
			if (fault === "nonce-case") packet.nonce = NONCE.toUpperCase();
			if (fault === "extra") Object.assign(packet, { publicKey: f.key.text });
			// Act
			const proof = await verifyRelayCheckProof({ ...f.options, packet });
			// Assert
			expect(proof).toBeNull();
		},
	);
});

describe("relay proof captures caller inputs before asynchronous crypto", () => {
	it.each(["valid", "invalid"])("keeps the %s first snapshot during hashing", async (initial) => {
		// Arrange
		const f = fixture();
		if (initial === "invalid") f.packet.signature = fixture().packet.signature;
		const original = { ...f.packet };
		const barrier = hashBarrier();
		// Act
		const pending = verifyRelayCheckProof(f.options);
		await Promise.race([barrier.entered.promise, pending.then(() => undefined)]);
		if (initial === "invalid") {
			// A replacement that would pass cannot repair the captured invalid signature.
			Object.assign(f.packet, f.signedPacket());
		} else {
			Object.assign(f.packet, f.signedPacket({ nonce: "a".repeat(32) }));
			Object.assign(f.signer, { deviceId: "changed", publicKey: syntheticKey().text });
			Object.assign(f.expected, { kind: "registration", role: "relay" });
			Object.assign(f.options, {
				deviceHeader: "changed",
				externalPathname: PREFIXED_PATH,
				packet: fixture().packet,
				signer: fixture().signer,
				expected: { kind: "registration" },
			});
		}
		barrier.release.resolve();
		const proof = await pending;
		// Assert
		if (initial === "invalid") expect(proof).toBeNull();
		else
			expect(proof).toEqual({
				...decodeRelayCheckPacket(original),
				signer: { deviceId: "source", publicKey: f.key.text, keyId: f.key.keyId },
				packetDigest: sha256(f.bodyBytes),
			});
	});

	it.each(["valid", "invalid"])(
		"reads each %s accessor once, including outer options",
		async (initial) => {
			// Arrange
			const f = fixture();
			const reads = instrumentInputs(f, initial);
			// Act
			const proof = await verifyRelayCheckProof(f.options);
			// Assert
			if (initial === "valid") {
				expect(proof?.packetDigest).toBe(sha256(f.bodyBytes));
				expect(reads.size).toBe(13);
			} else expect(proof).toBeNull();
			for (const count of reads.values()) expect(count).toBe(1);
		},
	);
});

describe("relay proof crypto failures are private", () => {
	it.each(["digest", "importKey", "verify"] as const)(
		"returns null without logging a %s exception",
		async (method) => {
			// Arrange
			const f = fixture();
			const logs = [
				vi.spyOn(console, "log"),
				vi.spyOn(console, "warn"),
				vi.spyOn(console, "error"),
			];
			vi.spyOn(globalThis.crypto.subtle, method).mockRejectedValueOnce(
				new Error("synthetic crypto failure"),
			);
			// Act
			const proof = await verifyRelayCheckProof(f.options);
			// Assert
			expect(proof).toBeNull();
			for (const log of logs) expect(log).not.toHaveBeenCalled();
		},
	);
});
