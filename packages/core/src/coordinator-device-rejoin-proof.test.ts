import { createHash, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deviceKey, NOW, signedHeaders } from "./coordinator-device-headless-link-test-fixtures.js";
import {
	type DeviceRejoinProof,
	deviceRejoinProofMessage,
	verifyDeviceRejoinProof,
} from "./coordinator-device-rejoin-proof.js";
import { SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";

const origin = "https://coordinator.example.test";
const attemptId = "rejoin-fixture-attempt";
const deviceId = "rejoin-fixture-device";
const key = deviceKey(deviceId);
const otherKey = deviceKey("fixture-other-device");
const keyId = createHash("sha256")
	.update(Buffer.from(key.publicKey.split(" ")[1] ?? "", "base64"))
	.digest("hex");
const common = { origin, attemptId, deviceId, keyId };
const start = {
	...common,
	operation: "start",
	publicKey: key.publicKey,
	browserStartHash: "1".repeat(64),
	loopbackRedirect: "http://127.0.0.1:12345/rejoin",
	timestampMs: NOW,
} as const;
const status = { ...common, operation: "status", timestampMs: NOW } as const;
const finalize = {
	...common,
	operation: "finalize",
	coordinatorId: "fixture-coordinator-id",
	authConfigRevision: "2".repeat(64),
	publicKey: key.publicKey,
	fingerprint: key.fingerprint,
	issuer: "https://issuer.example.test",
	identityId: "fixture-identity",
	bindingId: "fixture-binding",
	removalDigest: "3".repeat(64),
	confirmation: "4".repeat(64),
	completion: Buffer.alloc(32, 5).toString("base64url"),
} as const;

// Literal protocol arrays are an oracle independent of the production encoder.
const vectors = [
	{
		proof: start,
		wire: [
			"codemem-device-rejoin-start-v1",
			origin,
			attemptId,
			deviceId,
			key.publicKey,
			keyId,
			start.browserStartHash,
			start.loopbackRedirect,
			NOW,
		],
	},
	{
		proof: status,
		wire: ["codemem-device-rejoin-status-v1", origin, attemptId, deviceId, keyId, NOW],
	},
	{
		proof: finalize,
		wire: [
			"codemem-device-rejoin-finalize-v1",
			finalize.coordinatorId,
			origin,
			finalize.authConfigRevision,
			attemptId,
			deviceId,
			key.publicKey,
			keyId,
			key.fingerprint,
			finalize.issuer,
			finalize.identityId,
			finalize.bindingId,
			finalize.removalDigest,
			finalize.confirmation,
			finalize.completion,
		],
	},
] as const;

const signWire = (wire: readonly (string | number)[], signingKey = key) =>
	sign(null, Buffer.from(JSON.stringify(wire), "utf8"), signingKey.privateKey).toString(
		"base64url",
	);

const verify = (proof: DeviceRejoinProof, signature: string, tombstonePublicKey = key.publicKey) =>
	verifyDeviceRejoinProof(proof, { tombstonePublicKey, signature });

describe("device rejoin signatures", () => {
	it.each(vectors)("matches the protocol bytes for $proof.operation", async ({ proof, wire }) => {
		expect(deviceRejoinProofMessage(proof)).toBe(JSON.stringify(wire));
		expect(await verify(proof, signWire(wire))).toBe(true);
	});

	it.each(vectors)(
		"will not replay $proof.operation proof into another operation",
		async ({ proof, wire }) => {
			const signature = signWire(wire);
			for (const other of vectors.filter((entry) => entry.proof.operation !== proof.operation))
				expect(await verify(other.proof, signature)).toBe(false);
		},
	);

	it.each(vectors)(
		"checks $proof.operation against the recorded tombstone key",
		async ({ proof, wire }) => {
			expect(await verify(proof, signWire(wire, otherKey))).toBe(false);
			expect(await verify(proof, signWire(wire), otherKey.publicKey)).toBe(false);
			expect(await verify({ ...proof, keyId: "0".repeat(64) }, signWire(wire))).toBe(false);
		},
	);

	it("binds origin, attempt ID, and the signed start and status timestamps", async () => {
		const startSignature = signWire(vectors[0].wire);
		expect(await verify({ ...start, origin: "https://other.example.test" }, startSignature)).toBe(
			false,
		);
		expect(await verify({ ...start, attemptId: "another-attempt" }, startSignature)).toBe(false);
		expect(await verify({ ...start, timestampMs: NOW + 1 }, startSignature)).toBe(false);
		expect(await verify({ ...status, timestampMs: NOW + 1 }, signWire(vectors[1].wire))).toBe(
			false,
		);
	});

	it("binds the finalize completion, confirmation, and removal digest", async () => {
		const signature = signWire(vectors[2].wire);
		expect(await verify({ ...finalize, completion: "changed-completion" }, signature)).toBe(false);
		expect(await verify({ ...finalize, confirmation: "changed-confirmation" }, signature)).toBe(
			false,
		);
		expect(await verify({ ...finalize, removalDigest: "changed-removal" }, signature)).toBe(false);
	});

	it("refuses a signed claim for a different key than the tombstone", async () => {
		const mismatched = { ...start, publicKey: otherKey.publicKey };
		const wire = [...vectors[0].wire];
		wire[4] = otherKey.publicKey;
		expect(await verify(mismatched, signWire(wire))).toBe(false);
	});

	it("refuses a signed key ID that does not describe the tombstone key", async () => {
		const wrongKeyId = "0".repeat(64);
		const wire = [...vectors[1].wire];
		wire[4] = wrongKeyId;
		expect(await verify({ ...status, keyId: wrongKeyId }, signWire(wire))).toBe(false);
	});

	it("verifies against a tombstone with the same canonical key and different key text", async () => {
		expect(await verify(start, signWire(vectors[0].wire), `${key.publicKey} stored-comment`)).toBe(
			true,
		);
	});

	it("requires the canonical unpadded base64url signature", async () => {
		const signature = signWire(vectors[0].wire);
		expect(await verify(start, `${signature}==`)).toBe(false);
		expect(await verify(start, `${signature.slice(0, -1)}B`)).toBe(false);
		expect(await verify(start, signature.slice(0, -1))).toBe(false);
	});
});

it("does not exchange ordinary signed coordinator requests and rejoin proofs in either direction", async () => {
	const method = "POST";
	const pathWithQuery = "/v1/peers/revocations?group_id=fixture-group";
	const body = JSON.stringify({ peers: [] });
	const headers = signedHeaders(key, method, pathWithQuery, body);
	const signature = headers["X-Opencode-Signature"];
	const signedRequest = {
		method,
		pathWithQuery,
		bodyBytes: Buffer.from(body),
		timestamp: headers["X-Opencode-Timestamp"],
		nonce: headers["X-Opencode-Nonce"],
		publicKey: key.publicKey,
	};
	const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
	try {
		expect(verifySignature({ ...signedRequest, signature })).toBe(true);
		const ordinaryRaw = Buffer.from(signature.split(":")[1] ?? "", "base64").toString("base64url");
		for (const { proof, wire } of vectors) {
			expect(await verify(proof, signature)).toBe(false);
			expect(await verify(proof, ordinaryRaw)).toBe(false);
			const rejoinRaw = Buffer.from(signWire(wire), "base64url").toString("base64");
			expect(
				verifySignature({ ...signedRequest, signature: `${SIGNATURE_VERSION}:${rejoinRaw}` }),
			).toBe(false);
		}
	} finally {
		clock.mockRestore();
	}
});
