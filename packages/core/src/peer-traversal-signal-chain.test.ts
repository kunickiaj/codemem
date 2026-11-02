import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type VerifiedTraversalSignalChain,
	verifyTraversalSignalChain,
} from "./peer-traversal-signal-chain.js";
import {
	decodeTraversalSignalPacket,
	type TraversalSignalPacket,
	type TraversalSignalPhase,
} from "./peer-traversal-signal-codec.js";
import { verifyTraversalSignalProof } from "./peer-traversal-signal-proof.js";

const PATH = "/configured/a%2fb/v1/traversal/signal";
const phases = ["prepare", "offer", "offer-check", "answer", "answer-check"] as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function at<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) throw new Error("Missing fixture entry");
	return value;
}
function key() {
	const keys = generateKeyPairSync("ed25519");
	const raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")} disposable fixture`;
	return {
		...keys,
		pin: publicKey,
		keyId: sha256(Buffer.from(publicKey.split(" ")[1] ?? "", "base64")),
	};
}
function fixture(change?: (fields: unknown[], index: number) => void) {
	const sourceKey = key();
	const targetKey = key();
	const expected = {
		authorityId: "a".repeat(64),
		groupId: "group",
		source: { deviceId: "source", publicKey: sourceKey.pin },
		target: { deviceId: "target", publicKey: targetKey.pin },
		sessionId: "d".repeat(32),
		messageADigest: "e".repeat(64),
	};
	const packets: TraversalSignalPacket[] = [];
	const bodies: Buffer[] = [];
	const proofs: VerifiedTraversalSignalChain["proofs"][number][] = [];
	const signer = (index: number) => (index === 2 || index === 3 ? targetKey : sourceKey);
	function signed(fields: unknown[], index: number, path = PATH, signingKey = signer(index)) {
		const body = Buffer.from(JSON.stringify(fields));
		const timestamp = String(fields[9]);
		const nonce = "0123456789abcdef".repeat(2);
		const canonical = ["POST", path, timestamp, nonce, sha256(body)].join("\n");
		const signature = sign(null, Buffer.from(canonical), signingKey.privateKey);
		return {
			body: body.toString("base64url"),
			timestamp,
			nonce,
			signature: `v2:${signature.toString("base64")}`,
		};
	}
	for (const [index, phase] of phases.entries()) {
		// Deliberately nonmonotonic later timestamps carry the PREPARE deadline unchanged.
		const createdAt = at([0, 100, 4, 1, 200], index);
		const fields: unknown[] = [
			`codemem-traversal-webrtc-${phase}-v1`,
			expected.authorityId,
			expected.groupId,
			"source",
			sourceKey.keyId,
			"target",
			targetKey.keyId,
			expected.sessionId,
			expected.messageADigest,
			createdAt,
			createdAt + 30,
			55,
		];
		if (index > 0) fields.push(sha256(at(bodies, 0)));
		if (index === 1) fields.push(Buffer.from("opaque offer 🌲").toString("base64url"));
		if (index >= 2) fields.push(sha256(at(bodies, 1)));
		if (index === 3) fields.push(Buffer.from("opaque answer 🌲").toString("base64url"));
		if (index === 4) fields.push(sha256(at(bodies, 3)));
		change?.(fields, index);
		const packet = signed(fields, index);
		const body = Buffer.from(packet.body, "base64url");
		packets.push(packet);
		bodies.push(body);
		proofs.push({
			...decodeTraversalSignalPacket(packet),
			signer: {
				deviceId: index === 2 || index === 3 ? "target" : "source",
				publicKey: signer(index).pin,
				keyId: signer(index).keyId,
			},
			packetDigest: sha256(body),
		});
	}
	const options = {
		packets,
		expectedPhase: "answer-check" as TraversalSignalPhase,
		expected,
		externalPathname: PATH,
	};
	const fields = (index: number): unknown[] => JSON.parse(at(bodies, index).toString());
	return { options, packets, expected, proofs, fields, signed, sourceKey, targetKey };
}

afterEach(() => vi.restoreAllMocks());

describe("traversal signal signed prefixes", () => {
	it.each(phases)("verifies the exact ordered prefix through %s", async (expectedPhase) => {
		const f = fixture();
		const count = phases.indexOf(expectedPhase) + 1;
		const options = { ...f.options, expectedPhase, packets: f.packets.slice(0, count) };

		const chain = await verifyTraversalSignalChain(options);

		expect(chain).toEqual({
			proofs: f.proofs.slice(0, count),
			phase: expectedPhase,
			attemptNotAfter: 55,
		});
	});

	it("accepts nonmonotonic ancient timestamps and nonce reuse as transcript evidence only", async () => {
		const f = fixture();
		for (const packet of f.packets) Object.freeze(packet);
		Object.freeze(f.packets);
		Object.freeze(f.expected.source);
		Object.freeze(f.expected.target);
		Object.freeze(f.expected);
		Object.freeze(f.options);

		const chains = await Promise.all([
			verifyTraversalSignalChain(f.options),
			verifyTraversalSignalChain(f.options),
		]);

		expect(chains).toEqual(
			[0, 1].map(() => ({ proofs: f.proofs, phase: "answer-check", attemptNotAfter: 55 })),
		);
		expect(chains[0]?.proofs.map((proof) => proof.value.createdAt)).toEqual([0, 100, 4, 1, 200]);
	});

	it("owns all returned bytes, descriptions and metadata independently across calls", async () => {
		const f = fixture();
		const first = await verifyTraversalSignalChain(f.options);
		const second = await verifyTraversalSignalChain(f.options);

		for (const proof of first?.proofs ?? []) {
			proof.bodyBytes.fill(0);
			proof.signatureBytes.fill(0);
			if ("descriptionBytes" in proof.value) proof.value.descriptionBytes.fill(0);
			Object.assign(proof.value, { groupId: "changed" });
			Object.assign(proof.signer, { deviceId: "changed", publicKey: "changed" });
		}
		Object.assign(at(f.packets, 4), { body: "changed" });
		Object.assign(f.expected.source, { publicKey: "changed" });

		expect(first).not.toBeNull();
		expect(second).toEqual({ proofs: f.proofs, phase: "answer-check", attemptNotAfter: 55 });
	});
});

describe("traversal signal prefix structure", () => {
	it.each([
		"empty",
		"missing",
		"extra",
		"reorder",
		"hole",
		"wrong-phase",
		"unknown-phase",
		"non-array",
	] as const)("rejects %s transcript structure", async (fault) => {
		const f = fixture();
		const malformed = [...f.packets];
		delete malformed[2];
		const cases = {
			empty: [],
			missing: f.packets.slice(0, 4),
			extra: [...f.packets, at(f.packets, 4)],
			reorder: [at(f.packets, 1), at(f.packets, 0), ...f.packets.slice(2)],
			hole: malformed,
			"wrong-phase": f.packets,
			"unknown-phase": f.packets,
			"non-array": { 0: at(f.packets, 0), length: 1 },
		};
		const expectedPhase = fault === "unknown-phase" ? "registration" : "answer-check";
		const phase = fault === "wrong-phase" ? "answer" : expectedPhase;

		const chain = await Reflect.apply(verifyTraversalSignalChain, undefined, [
			{ ...f.options, packets: cases[fault], expectedPhase: phase },
		]);

		expect(chain).toBeNull();
	});

	it.each([null, undefined, false, "private input", {}])(
		"returns null for malformed options %j",
		async (options) => {
			const chain = await Reflect.apply(verifyTraversalSignalChain, undefined, [options]);

			expect(chain).toBeNull();
		},
	);
});

describe("traversal signal expected tuple", () => {
	it.each([
		"authority",
		"group",
		"source-id",
		"target-id",
		"source-pin",
		"target-pin",
		"session",
		"opening",
	] as const)("rejects the wrong trusted %s", async (fault) => {
		const f = fixture();
		const changes = {
			authority: { authorityId: "9".repeat(64) },
			group: { groupId: "other-group" },
			"source-id": { source: { ...f.expected.source, deviceId: "other-source" } },
			"target-id": { target: { ...f.expected.target, deviceId: "other-target" } },
			"source-pin": { source: { ...f.expected.source, publicKey: key().pin } },
			"target-pin": { target: { ...f.expected.target, publicKey: key().pin } },
			session: { sessionId: "9".repeat(32) },
			opening: { messageADigest: "9".repeat(64) },
		};

		const chain = await verifyTraversalSignalChain({
			...f.options,
			expected: { ...f.expected, ...changes[fault] },
		});

		expect(chain).toBeNull();
	});

	it.each(phases.flatMap((_, index) => [1, 2, 7, 8].map((field) => [index, field] as const)))(
		"rejects correctly re-signed phase %i field %i despite valid individual proofs",
		async (index, field) => {
			const replacement = new Map<number, unknown>([
				[1, "9".repeat(64)],
				[2, "other-group"],
				[7, "9".repeat(32)],
				[8, "9".repeat(64)],
			]);
			const f = fixture((fields, phaseIndex) => {
				if (phaseIndex === index) fields[field] = replacement.get(field);
			});
			const individual = await Promise.all(
				f.packets.map((packet, index) =>
					verifyTraversalSignalProof({
						packet,
						expectedPhase: at(phases, index),
						signer: at(f.proofs, index).signer,
						deviceHeader: at(f.proofs, index).signer.deviceId,
						externalPathname: PATH,
					}),
				),
			);

			const chain = await verifyTraversalSignalChain(f.options);

			expect(individual.every((proof) => proof !== null)).toBe(true);
			expect(chain).toBeNull();
		},
	);

	it.each(phases.flatMap((_, index) => [3, 4, 5, 6].map((field) => [index, field] as const)))(
		"rejects re-signed endpoint identity at phase %i field %i",
		async (index, field) => {
			const replacement = field === 3 || field === 5 ? "other-device" : "9".repeat(64);
			const f = fixture((fields, phaseIndex) => {
				if (phaseIndex === index) fields[field] = replacement;
			});

			const chain = await verifyTraversalSignalChain(f.options);

			expect(chain).toBeNull();
		},
	);

	it("rejects a PREPARE-only malicious target key ID even with a valid source signature", async () => {
		const f = fixture((fields, index) => {
			if (index === 0) fields[6] = "9".repeat(64);
		});
		const packet = at(f.packets, 0);
		const individual = await verifyTraversalSignalProof({
			packet,
			expectedPhase: "prepare",
			signer: f.expected.source,
			deviceHeader: "source",
			externalPathname: PATH,
		});

		const chain = await verifyTraversalSignalChain({
			...f.options,
			expectedPhase: "prepare",
			packets: [packet],
		});

		expect(individual).not.toBeNull();
		expect(chain).toBeNull();
	});
});

describe("traversal signal deadlines, links and signatures", () => {
	it.each([1, 2, 3, 4])(
		"rejects re-signed phase %i with a different attempt deadline",
		async (index) => {
			const f = fixture((fields, phaseIndex) => {
				if (phaseIndex === index) fields[11] = 56;
			});

			const chain = await verifyTraversalSignalChain(f.options);

			expect(chain).toBeNull();
		},
	);

	it.each([
		[1, 12],
		[2, 12],
		[3, 12],
		[4, 12],
		[2, 13],
		[3, 13],
		[4, 13],
		[4, 14],
	])("rejects re-signed phase %i with substituted digest link %i", async (index, field) => {
		const f = fixture((fields, phaseIndex) => {
			if (phaseIndex === index) fields[field] = "9".repeat(64);
		});

		const chain = await verifyTraversalSignalChain(f.options);

		expect(chain).toBeNull();
	});

	it.each(["wrong-signer", "wrong-path", "raw-body"] as const)(
		"rejects %s in an otherwise complete transcript",
		async (fault) => {
			const f = fixture();
			const fields = f.fields(3);
			const replacements = {
				"wrong-signer": f.signed(fields, 3, PATH, f.sourceKey),
				"wrong-path": f.signed(fields, 3, "/v1/traversal/signal"),
				"raw-body": {
					...at(f.packets, 3),
					body: Buffer.from(` ${JSON.stringify(fields)}`).toString("base64url"),
				},
			};
			f.packets[3] = replacements[fault];

			const chain = await verifyTraversalSignalChain(f.options);

			expect(chain).toBeNull();
		},
	);

	it("returns generic null without logging private malformed input or crypto failures", async () => {
		const f = fixture();
		const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		const invalid = {
			...f.options,
			get expected(): never {
				throw new Error("private expected tuple");
			},
		};
		vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(
			new Error("private crypto failure"),
		);

		const chains = await Promise.all([
			verifyTraversalSignalChain(invalid),
			verifyTraversalSignalChain(f.options),
		]);

		expect(chains).toEqual([null, null]);
		for (const log of logs) expect(log).not.toHaveBeenCalled();
	});
});

describe("traversal signal chain captures the entire transcript before awaiting", () => {
	it.each(["valid", "invalid"] as const)(
		"retains the %s original later packet and trusted inputs during hashing",
		async (initial) => {
			const f = fixture();
			const originalLast = { ...at(f.packets, 4) };
			if (initial === "invalid") at(f.packets, 4).signature = at(fixture().packets, 4).signature;
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

			const pending = verifyTraversalSignalChain(f.options);
			await Promise.race([entered.promise, pending.then(() => undefined)]);
			try {
				if (initial === "invalid") Object.assign(at(f.packets, 4), originalLast);
				else {
					Object.assign(at(f.packets, 3), { body: "changed", signature: "changed" });
					f.packets[4] = at(fixture().packets, 4);
					f.packets.length = 1;
					Object.assign(f.expected.source, { deviceId: "changed", publicKey: key().pin });
					Object.assign(f.expected.target, { deviceId: "changed", publicKey: key().pin });
					Object.assign(f.expected, {
						authorityId: "9".repeat(64),
						groupId: "changed",
						sessionId: "9".repeat(32),
						messageADigest: "9".repeat(64),
					});
					Object.assign(f.options, {
						packets: [],
						expectedPhase: "prepare",
						expected: fixture().expected,
						externalPathname: "/v1/traversal/signal",
					});
				}
			} finally {
				release.resolve();
			}
			const chain = await pending;

			expect(hashingStarted).toBe(true);
			if (initial === "valid")
				expect(chain).toEqual({ proofs: f.proofs, phase: "answer-check", attemptNotAfter: 55 });
			else expect(chain).toBeNull();
		},
	);
});
