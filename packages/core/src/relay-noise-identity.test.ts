import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	importRelayNoiseIdentity,
	relayNoiseExpectedPeer,
	relayNoisePrologue,
	verifyRelayNoisePeer,
} from "./relay-noise-identity.js";

function syntheticIdentity(seed = 1) {
	// Disposable deterministic seeds never leave this process.
	const der = Buffer.concat([
		Buffer.from("302e020100300506032b657004220420", "hex"),
		Buffer.alloc(32, seed),
	]);
	const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
	const publicKey = createPublicKey(key);
	const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	return { key, der, publicKey, raw, pin: `ssh-ed25519 ${wire.toString("base64")}` };
}

afterEach(() => vi.restoreAllMocks());

describe("relay Noise identity continuity", () => {
	it.each(["KeyObject", "PKCS8", "PKCS8 view"])(
		"imports %s with the existing key and native signatures",
		async (format) => {
			// Arrange: the contract reuses Ed25519 identity without creating persisted copies.
			const identity = syntheticIdentity();
			const backing = Buffer.concat([Buffer.alloc(7, 255), identity.der, Buffer.alloc(9, 255)]);
			let key: typeof identity.key | Uint8Array = identity.key;
			if (format === "PKCS8") key = identity.der;
			if (format === "PKCS8 view") key = backing.subarray(7, 7 + identity.der.length);
			const original = Buffer.from(identity.der);
			const writeSync = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
				throw new Error("Unexpected persistence");
			});
			const writeAsync = vi
				.spyOn(fsPromises, "writeFile")
				.mockRejectedValue(new Error("Unexpected persistence"));
			const message = Buffer.concat([
				Buffer.from("noise-libp2p-static-key:"),
				Buffer.alloc(32, 42),
			]);
			// Act
			const imported = importRelayNoiseIdentity({ key, expectedPin: identity.pin });
			const signature = await imported.privateKey.sign(message);
			const nativeSignature = sign(null, message, identity.key);
			// Assert
			expect(Buffer.from(imported.privateKey.publicKey.raw)).toEqual(identity.raw);
			expect(imported.peerId.equals(relayNoiseExpectedPeer(identity.pin).peerId)).toBe(true);
			expect(Buffer.from(signature)).toEqual(nativeSignature);
			expect(verify(null, message, identity.publicKey, signature)).toBe(true);
			expect(await imported.privateKey.publicKey.verify(message, nativeSignature)).toBe(true);
			expect(verify(null, Buffer.from("changed"), identity.publicKey, signature)).toBe(false);
			expect(identity.der).toEqual(original);
			expect(identity.key.export({ format: "der", type: "pkcs8" })).toEqual(original);
			expect(writeSync).not.toHaveBeenCalled();
			expect(writeAsync).not.toHaveBeenCalled();
		},
	);

	it("retains an independent imported key after caller-owned PKCS8 is erased", async () => {
		// Arrange
		const identity = syntheticIdentity();
		const imported = importRelayNoiseIdentity({ key: identity.der, expectedPin: identity.pin });
		const message = Buffer.from("noise-libp2p-static-key:synthetic");
		// Act
		identity.der.fill(0);
		const signature = await imported.privateKey.sign(message);
		// Assert
		expect(verify(null, message, identity.publicKey, signature)).toBe(true);
	});

	it.each(["public", "x25519", "secret", "malformed DER", "unsupported", "wrong pin"])(
		"rejects %s local identity",
		(kind) => {
			// Arrange
			const identity = syntheticIdentity();
			const keys: Record<string, unknown> = {
				public: identity.publicKey,
				x25519: generateKeyPairSync("x25519").privateKey,
				secret: Buffer.alloc(32),
				"malformed DER": identity.der.subarray(0, 20),
				unsupported: "private-key-text",
				"wrong pin": identity.key,
			};
			const expectedPin = kind === "wrong pin" ? syntheticIdentity(2).pin : identity.pin;
			// Act
			const act = () =>
				Reflect.apply(importRelayNoiseIdentity, undefined, [{ key: keys[kind], expectedPin }]);
			// Assert
			expect(act).toThrow();
		},
	);
});

describe("relay Noise peer pin boundary", () => {
	it("derives the same peer for strict pins with comments and returns owned public bytes", () => {
		// Arrange
		const identity = syntheticIdentity();
		const expected = relayNoiseExpectedPeer(identity.pin);
		// Act
		const commented = relayNoiseExpectedPeer(`${identity.pin} disposable comment`);
		expected.rawKey.fill(0);
		// Assert
		expect(commented.peerId.equals(expected.peerId)).toBe(true);
		expect(Buffer.from(commented.rawKey)).toEqual(identity.raw);
		expect(Buffer.from(expected.peerId.publicKey?.raw ?? [])).toEqual(identity.raw);
	});

	it("accepts the observed peer only for its existing pin", () => {
		// Arrange
		const identity = syntheticIdentity();
		const observed = importRelayNoiseIdentity({
			key: identity.key,
			expectedPin: identity.pin,
		}).peerId;
		// Act
		const result = verifyRelayNoisePeer(observed, identity.pin);
		// Assert
		expect(result).toBeUndefined();
		expect(() => verifyRelayNoisePeer(observed, syntheticIdentity(2).pin)).toThrow(
			"Noise remote pin mismatch",
		);
	});

	it.each(["", "ssh-rsa invalid", "ssh-ed25519 !!!!!", null, 12])(
		"rejects malformed pin %j at every identity boundary",
		(pin) => {
			// Arrange
			const identity = syntheticIdentity();
			const observed = relayNoiseExpectedPeer(identity.pin).peerId;
			// Act
			const importKey = () =>
				Reflect.apply(importRelayNoiseIdentity, undefined, [
					{ key: identity.key, expectedPin: pin },
				]);
			const derivePeer = () => Reflect.apply(relayNoiseExpectedPeer, undefined, [pin]);
			const verifyPeer = () => Reflect.apply(verifyRelayNoisePeer, undefined, [observed, pin]);
			// Assert
			expect(importKey).toThrow();
			expect(derivePeer).toThrow();
			expect(verifyPeer).toThrow();
		},
	);

	it.each([
		undefined,
		{ type: "RSA", raw: new Uint8Array(32) },
		{ type: "Ed25519", raw: new Uint8Array(31) },
		{ type: "Ed25519", raw: new Uint8Array(32) },
	])(
		"rejects an inconsistent observed public key %j even if peer equality claims success",
		(publicKey) => {
			// Arrange
			const pin = syntheticIdentity().pin;
			const observed = { equals: () => true, publicKey };
			// Act
			const act = () => Reflect.apply(verifyRelayNoisePeer, undefined, [observed, pin]);
			// Assert
			expect(act).toThrow("Noise remote pin mismatch");
		},
	);
});

describe("relay Noise prologue", () => {
	it.each([1, 2, 3] as const)(
		"encodes the exact contract vector for transport %i from a byte view",
		(transportLabel) => {
			// Arrange
			const backing = Uint8Array.from([255, ...Array.from({ length: 16 }, (_, i) => i), 254]);
			const sessionId = backing.subarray(1, 17);
			const expectedHex = `636f64656d656d2d706565722d73747265616d2f31000${transportLabel}000102030405060708090a0b0c0d0e0f`;
			// Act
			const prologue = relayNoisePrologue({ transportLabel, sessionId });
			sessionId.fill(255);
			// Assert
			expect(Buffer.from(prologue).toString("hex")).toBe(expectedHex);
			expect(prologue).toHaveLength(39);
		},
	);

	it("returns independent output buffers without mutating the session ID", () => {
		// Arrange
		const sessionId = new Uint8Array(16).fill(42);
		const context = { transportLabel: 1 as const, sessionId };
		const first = relayNoisePrologue(context);
		// Act
		first.fill(0);
		const second = relayNoisePrologue(context);
		// Assert
		expect(sessionId).toEqual(new Uint8Array(16).fill(42));
		expect(Uint8Array.from(second.subarray(-16))).toEqual(sessionId);
		expect(second[0]).toBe(99);
	});

	it("separates traversal from relay and coordinator-free direct for the same session", () => {
		const sessionId = Uint8Array.from({ length: 16 }, (_, i) => i);

		const prologues = ([1, 2, 3] as const).map((transportLabel) =>
			relayNoisePrologue({ transportLabel, sessionId }),
		);

		expect(new Set(prologues.map((bytes) => Buffer.from(bytes).toString("hex"))).size).toBe(3);
		for (const prologue of prologues) {
			expect(Uint8Array.from(prologue.subarray(-16))).toEqual(sessionId);
		}
	});

	it.each([0, 4, -1, 256, 1.5, Number.NaN, "1", "3", null, undefined])(
		"rejects unknown runtime transport label %j",
		(transportLabel) => {
			// Arrange
			const context = { transportLabel, sessionId: new Uint8Array(16) };
			// Act
			const act = () => Reflect.apply(relayNoisePrologue, undefined, [context]);
			// Assert
			expect(act).toThrow("Invalid Noise transport context");
		},
	);

	it.each([
		new Uint8Array(0),
		new Uint8Array(15),
		new Uint8Array(17),
		new Array(16).fill(0),
		new ArrayBuffer(16),
		null,
	])("rejects invalid session context %j", (sessionId) => {
		// Arrange
		const context = { transportLabel: 1, sessionId };
		// Act
		const act = () => Reflect.apply(relayNoisePrologue, undefined, [context]);
		// Assert
		expect(act).toThrow("Invalid Noise transport context");
	});
});
