import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	decodeTraversalSignalPacket,
	encodeTraversalSignalBody,
	type TraversalSignalPhase,
} from "./peer-traversal-signal-codec.js";
import {
	type TraversalSignalProofSigner,
	type TraversalSignalProofVerificationOptions,
	type VerifiedTraversalSignalProof,
	verifyTraversalSignalProof,
} from "./peer-traversal-signal-proof.js";

const PATH = "/v1/traversal/signal";
const NONCE = "0123456789abcdef".repeat(2);
const phases = ["prepare", "offer", "offer-check", "answer", "answer-check"] as const;
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function disposableKey() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const pin = `ssh-ed25519 ${wire.toString("base64")} disposable fixture`;
	return { privateKey, raw, pin, keyId: sha256(Buffer.from(pin.split(" ")[1] ?? "", "base64")) };
}

function fixture(phase: TraversalSignalPhase = "prepare", path = PATH) {
	const source = disposableKey();
	const target = disposableKey();
	const actor = phase === "offer-check" || phase === "answer" ? "target" : "source";
	const key = actor === "source" ? source : target;
	// Literal field positions and purpose bytes keep the signing oracle independent of the codec.
	const fields: unknown[] = [
		`codemem-traversal-webrtc-${phase}-v1`,
		"a".repeat(64),
		"e\u0301-group",
		"source",
		source.keyId,
		"target",
		target.keyId,
		"d".repeat(32),
		"e".repeat(64),
		0,
		30,
		55,
	];
	if (phase !== "prepare") fields.push("f".repeat(64));
	if (phase === "offer") fields.push(Buffer.from("opaque offer 🌲").toString("base64url"));
	if (phase === "offer-check" || phase === "answer" || phase === "answer-check")
		fields.push("1".repeat(64));
	if (phase === "answer") fields.push(Buffer.from("opaque answer 🌲").toString("base64url"));
	if (phase === "answer-check") fields.push("2".repeat(64));
	const bodyBytes = Buffer.from(JSON.stringify(fields));
	function signedPacket(
		overrides: {
			path?: string;
			method?: string;
			timestamp?: string;
			nonce?: string;
			bytes?: Uint8Array;
			suffix?: string;
		} = {},
	) {
		const bytes = overrides.bytes ?? bodyBytes;
		const timestamp = overrides.timestamp ?? "0";
		const nonce = overrides.nonce ?? NONCE;
		const canonical = [
			overrides.method ?? "POST",
			overrides.path ?? path,
			timestamp,
			nonce,
			sha256(bytes),
		].join("\n");
		const signature = sign(null, Buffer.from(canonical + (overrides.suffix ?? "")), key.privateKey);
		return {
			body: Buffer.from(bytes).toString("base64url"),
			timestamp,
			nonce,
			signature: `v2:${signature.toString("base64")}`,
		};
	}
	const packet = signedPacket();
	const signer: TraversalSignalProofSigner = { deviceId: actor, publicKey: key.pin };
	const options: TraversalSignalProofVerificationOptions = {
		packet,
		signer,
		expectedPhase: phase,
		deviceHeader: actor,
		externalPathname: path,
	};
	const expected: VerifiedTraversalSignalProof = {
		...decodeTraversalSignalPacket(packet),
		signer: { ...signer, keyId: key.keyId },
		packetDigest: sha256(bodyBytes),
	};
	return { source, target, key, actor, bodyBytes, packet, signer, options, signedPacket, expected };
}

afterEach(() => vi.restoreAllMocks());

describe("traversal signal native proof evidence", () => {
	it.each(phases)(
		"verifies the exact actor, SSH wire hash and canonical bytes for %s",
		async (phase) => {
			const f = fixture(phase);

			const proof = await verifyTraversalSignalProof(f.options);

			expect(proof).toEqual(f.expected);
			expect(proof?.signer.keyId).not.toBe(sha256(f.key.raw));
			expect(proof?.signer.keyId).not.toBe(sha256(f.key.pin));
		},
	);

	it.each(phases)(
		"rejects a different actor, header, key ID or expected phase for %s",
		async (phase) => {
			const f = fixture(phase);
			const otherActor = f.actor === "source" ? "target" : "source";
			const otherKey = f.actor === "source" ? f.target : f.source;
			const decoded = decodeTraversalSignalPacket(f.packet).value;
			const actorKeyField = f.actor === "source" ? "sourceKeyId" : "targetKeyId";
			const bytes = encodeTraversalSignalBody({ ...decoded, [actorKeyField]: sha256(f.key.raw) });
			const inputs = [
				{
					...f.options,
					expectedPhase: phase === "prepare" ? ("offer" as const) : ("prepare" as const),
				},
				{ ...f.options, deviceHeader: otherActor },
				{ ...f.options, signer: { ...f.signer, deviceId: otherActor } },
				{
					...f.options,
					deviceHeader: otherActor,
					signer: { deviceId: otherActor, publicKey: otherKey.pin },
				},
				{ ...f.options, signer: { ...f.signer, publicKey: disposableKey().pin } },
				{ ...f.options, packet: f.signedPacket({ bytes }) },
			];

			const proofs = await Promise.all(inputs.map(verifyTraversalSignalProof));

			expect(proofs).toEqual(inputs.map(() => null));
		},
	);

	it("accepts ancient creation times and repeated nonces as possession evidence only", async () => {
		const f = fixture();
		Object.freeze(f.packet);
		Object.freeze(f.signer);
		Object.freeze(f.options);

		const proofs = await Promise.all([
			verifyTraversalSignalProof(f.options),
			verifyTraversalSignalProof(f.options),
		]);

		expect(proofs).toEqual([f.expected, f.expected]);
		expect(proofs[0]?.value.createdAt).toBe(0);
	});

	it("owns returned bodies, descriptions, signatures and signer metadata independently", async () => {
		const f = fixture("offer");
		const first = await verifyTraversalSignalProof(f.options);
		const second = await verifyTraversalSignalProof(f.options);

		first?.bodyBytes.fill(0);
		first?.signatureBytes.fill(0);
		if (first && "descriptionBytes" in first.value) first.value.descriptionBytes.fill(0);
		if (first) {
			Object.assign(first.value, { groupId: "changed" });
			Object.assign(first.signer, { deviceId: "changed" });
		}
		f.packet.body = "changed";
		Object.assign(f.signer, { publicKey: "changed" });

		expect(first).not.toBeNull();
		expect(second).toEqual(f.expected);
	});
});

describe("traversal signal signature domain", () => {
	it.each(["authorityId", "sessionId", "messageADigest", "descriptionBytes"] as const)(
		"rejects substituted %s without re-signing",
		async (field) => {
			const f = fixture("offer");
			const value = decodeTraversalSignalPacket(f.packet).value;
			const replacements = {
				authorityId: "9".repeat(64),
				sessionId: "9".repeat(32),
				messageADigest: "8".repeat(64),
				descriptionBytes: Buffer.from("changed opaque description"),
			};
			const bytes = encodeTraversalSignalBody({ ...value, [field]: replacements[field] });
			const packet = { ...f.packet, body: Buffer.from(bytes).toString("base64url") };
			expect(() => decodeTraversalSignalPacket(packet)).not.toThrow();

			const proof = await verifyTraversalSignalProof({ ...f.options, packet });

			expect(proof).toBeNull();
		},
	);

	it("rejects a body purpose changed to another valid phase with the original signature", async () => {
		const f = fixture("prepare");
		const value = decodeTraversalSignalPacket(f.packet).value;
		if (value.phase !== "prepare") throw new Error("Unexpected fixture phase");
		const bodyBytes = encodeTraversalSignalBody({
			...value,
			phase: "offer",
			prepareDigest: "f".repeat(64),
			descriptionBytes: Buffer.from("opaque offer"),
		});
		const packet = { ...f.packet, body: Buffer.from(bodyBytes).toString("base64url") };

		const proof = await verifyTraversalSignalProof({
			...f.options,
			expectedPhase: "offer",
			packet,
		});

		expect(proof).toBeNull();
	});

	it.each(["method", "path", "timestamp", "nonce", "newline", "signature", "v1"] as const)(
		"rejects a substituted signature domain: %s",
		async (fault) => {
			const f = fixture();
			const packets = {
				method: f.signedPacket({ method: "GET" }),
				path: f.signedPacket({ path: `/other${PATH}` }),
				timestamp: { ...f.signedPacket({ timestamp: "1" }), timestamp: "0" },
				nonce: { ...f.packet, nonce: "a".repeat(32) },
				newline: f.signedPacket({ suffix: "\n" }),
				signature: { ...f.packet, signature: fixture().packet.signature },
				v1: { ...f.packet, signature: f.packet.signature.replace("v2:", "v1:") },
			};

			const proof = await verifyTraversalSignalProof({ ...f.options, packet: packets[fault] });

			expect(proof).toBeNull();
		},
	);

	it.each([`/configured/coordinator${PATH}`, `/a%2fb/組/😀/e\u0301${PATH}`])(
		"retains exact trusted pathname bytes %s",
		async (path) => {
			const f = fixture("answer", path);

			const proof = await verifyTraversalSignalProof(f.options);
			const rewritten = await verifyTraversalSignalProof({ ...f.options, externalPathname: PATH });
			const normalized = await verifyTraversalSignalProof({
				...f.options,
				externalPathname: decodeURIComponent(path).normalize("NFC"),
			});

			expect(proof).toEqual(f.expected);
			expect(rewritten).toBeNull();
			if (path.includes("%")) expect(normalized).toBeNull();
		},
	);

	it.each([
		"v1/traversal/signal",
		`https://example.test${PATH}`,
		`/${PATH}`,
		`${PATH}/`,
		`${PATH}?x=1`,
		`${PATH}#x`,
		"/v1/traversal/other",
		`/prefix\\${PATH}`,
		`/a b${PATH}`,
		`/a\0${PATH}`,
		`/a\n${PATH}`,
		`/a\x7f${PATH}`,
		`/a\u0085${PATH}`,
		`/\ud800${PATH}`,
		`/\udfff${PATH}`,
	])("rejects invalid pathname %j even when signed exactly", async (path) => {
		const f = fixture("prepare", path);

		const proof = await verifyTraversalSignalProof(f.options);

		expect(proof).toBeNull();
	});
});

describe("traversal signal malformed inputs and crypto failures", () => {
	it.each([null, undefined, false, "private-payload", {}, { body: "bad" }])(
		"returns null for malformed packet %j without logging",
		async (packet) => {
			const f = fixture();
			const logs = [
				vi.spyOn(console, "log"),
				vi.spyOn(console, "warn"),
				vi.spyOn(console, "error"),
			];

			const proof = await verifyTraversalSignalProof({ ...f.options, packet });

			expect(proof).toBeNull();
			for (const log of logs) expect(log).not.toHaveBeenCalled();
		},
	);

	it.each(["", "ssh-rsa invalid", "ssh-ed25519 !!!!!", null, 42])(
		"returns null for malformed pin %j",
		async (publicKey) => {
			const f = fixture();

			const proof = await Reflect.apply(verifyTraversalSignalProof, undefined, [
				{ ...f.options, signer: { ...f.signer, publicKey } },
			]);

			expect(proof).toBeNull();
		},
	);

	it.each([null, "constructor", "registration", "PREPARE"])(
		"rejects invalid expected purpose %j",
		async (expectedPhase) => {
			const f = fixture();

			const proof = await Reflect.apply(verifyTraversalSignalProof, undefined, [
				{ ...f.options, expectedPhase },
			]);

			expect(proof).toBeNull();
		},
	);

	it.each(["digest", "importKey", "verify"] as const)(
		"returns null without logging %s failures",
		async (method) => {
			const f = fixture();
			const logs = [
				vi.spyOn(console, "log"),
				vi.spyOn(console, "warn"),
				vi.spyOn(console, "error"),
			];
			vi.spyOn(globalThis.crypto.subtle, method).mockRejectedValueOnce(
				new Error("private crypto failure"),
			);

			const proof = await verifyTraversalSignalProof(f.options);

			expect(proof).toBeNull();
			for (const log of logs) expect(log).not.toHaveBeenCalled();
		},
	);

	it("returns null for throwing input accessors without exposing their message", async () => {
		const f = fixture();
		const options = {
			...f.options,
			get packet(): unknown {
				throw new Error("private input");
			},
		};

		const proof = await verifyTraversalSignalProof(options);

		expect(proof).toBeNull();
	});
});

describe("traversal signal captures inputs before asynchronous crypto", () => {
	it.each(["valid", "invalid"] as const)(
		"retains the %s initial snapshot while caller inputs change",
		async (initial) => {
			const f = fixture("offer");
			if (initial === "invalid") f.packet.signature = fixture("offer").packet.signature;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let hashingStarted = false;
			const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
			vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
				hashingStarted = true;
				entered.resolve();
				await release.promise;
				return digest(...args);
			});

			const pending = verifyTraversalSignalProof(f.options);
			await Promise.race([entered.promise, pending.then(() => undefined)]);
			try {
				if (initial === "invalid") {
					Object.assign(f.packet, f.signedPacket());
				} else {
					Object.assign(f.packet, f.signedPacket({ nonce: "a".repeat(32) }));
					Object.assign(f.signer, { deviceId: "changed", publicKey: disposableKey().pin });
					Object.assign(f.options, {
						packet: fixture().packet,
						signer: fixture().signer,
						expectedPhase: "answer",
						deviceHeader: "changed",
						externalPathname: `/other${PATH}`,
					});
				}
			} finally {
				release.resolve();
			}
			const proof = await pending;

			expect(hashingStarted).toBe(true);
			if (initial === "valid") expect(proof).toEqual(f.expected);
			else expect(proof).toBeNull();
		},
	);
});
