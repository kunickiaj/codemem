import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { createTransportStatement, verifyTransportStatement } from "./sync-transport-statement.js";

function sshPublicKey(publicKey: KeyObject): string {
	const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
	const type = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(4 + type.length + 4 + raw.length);
	wire.writeUInt32BE(type.length, 0);
	type.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + type.length);
	raw.copy(wire, 8 + type.length);
	return `ssh-ed25519 ${wire.toString("base64")}`;
}

function device(deviceId = "device-a") {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const ssh = sshPublicKey(publicKey);
	return { deviceId, privateKey, publicKey: ssh, fingerprint: fingerprintPublicKey(ssh) };
}

function statementFor(
	signer: ReturnType<typeof device>,
	overrides: { deviceId?: string; fingerprint?: string; features?: string[] } = {},
) {
	return createTransportStatement(
		{
			deviceId: overrides.deviceId ?? signer.deviceId,
			fingerprint: overrides.fingerprint ?? signer.fingerprint,
			features: overrides.features ?? ["direct_noise_v1"],
			issuedAt: "2026-11-27T00:00:00.000Z",
		},
		signer.privateKey,
	);
}

/** Sign arbitrary payload text the same way, to build statements the builder refuses to make. */
function signRaw(signer: ReturnType<typeof device>, payload: string, domain = true) {
	const bytes = Buffer.concat([
		domain ? Buffer.from("codemem-transport-statement/1\0", "ascii") : Buffer.alloc(0),
		Buffer.from(payload, "utf8"),
	]);
	return { payload, signature: sign(null, bytes, signer.privateKey).toString("base64") };
}

describe("transport statements", () => {
	it("verifies a statement against the signer's pinned key", () => {
		const a = device();
		const content = verifyTransportStatement(
			statementFor(a, { features: ["x", "direct_noise_v1"] }),
			a,
		);
		expect(content).toEqual({
			deviceId: "device-a",
			fingerprint: a.fingerprint,
			features: ["direct_noise_v1", "x"],
			issuedAt: "2026-11-27T00:00:00.000Z",
		});
	});

	it("rejects a statement signed by a key other than the pinned one", () => {
		const a = device();
		const forger = device();
		// A coordinator that swaps in its own key and signs for that key must still fail.
		const forged = statementFor(forger, { deviceId: a.deviceId, fingerprint: a.fingerprint });
		expect(verifyTransportStatement(forged, a)).toBeNull();
		expect(verifyTransportStatement(statementFor(forger, { deviceId: a.deviceId }), a)).toBeNull();
	});

	it("rejects a statement naming another device or fingerprint", () => {
		const a = device();
		const b = device("device-b");
		expect(verifyTransportStatement(statementFor(a), { ...a, deviceId: "device-b" })).toBeNull();
		expect(verifyTransportStatement(statementFor(a, { fingerprint: b.fingerprint }), a)).toBeNull();
	});

	it("rejects tampered, non-canonical, undomained and malformed statements", () => {
		const a = device();
		const valid = statementFor(a, { features: ["direct_noise_v1", "x"] });
		const tampered = { ...valid, payload: valid.payload.replace(',"x"', "") };
		const spaced = signRaw(a, valid.payload.replace(":1,", ": 1,"));
		const unsorted = signRaw(
			a,
			valid.payload.replace('"direct_noise_v1","x"', '"x","direct_noise_v1"'),
		);
		const undomained = signRaw(a, valid.payload, false);
		const v2 = signRaw(a, valid.payload.replace('"v":1', '"v":2'));
		const cases: unknown[] = [
			tampered,
			spaced,
			unsorted,
			undomained,
			v2,
			{ ...valid, extra: true },
			{ ...valid, signature: `${valid.signature}=` },
			{ payload: valid.payload },
			signRaw(a, `${valid.payload}${" ".repeat(1024)}`),
			null,
			"statement",
			[valid],
		];
		for (const value of cases) expect(verifyTransportStatement(value, a)).toBeNull();
		expect(verifyTransportStatement(valid, a)).not.toBeNull();
	});

	it("refuses to build statements with invalid features", () => {
		const a = device();
		expect(() => statementFor(a, { features: ["Direct Noise"] })).toThrow(/features/);
		expect(() =>
			statementFor(a, { features: Array.from({ length: 17 }, (_, i) => `f${i}`) }),
		).toThrow(/features/);
	});
});
