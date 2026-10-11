import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	type OwnerAttempt,
	ownerEnrollmentFinalMessage,
	readGrantPins,
	validAttemptTime,
	validOwnerEnrollmentReceiptMetadata,
	validWriteTime,
	verifyOwnerEnrollmentCompletion,
	verifyOwnerEnrollmentSignature,
	verifyPendingKeySignatureAndHashes,
} from "./coordinator-owner-enrollment-proof.js";

// Pure proof fixture: no DB, provider, SDK, network, or claim of current account authority.
async function proofFixture() {
	const keys = generateKeyPairSync("ed25519");
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	Buffer.from(keys.publicKey.export({ type: "spki", format: "der" }))
		.subarray(-32)
		.copy(wire, 19);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const row: OwnerAttempt = {
		coordinator_id: "coordinator-a",
		attempt_id: "attempt-a",
		purpose: "owner_enroll",
		origin: "https://coordinator.example.test",
		device_id: "device-a",
		public_key: publicKey,
		key_id: (await ed25519KeyId(publicKey)) as string,
		fingerprint: createHash("sha256").update(publicKey, "utf8").digest("hex"),
		issuer: "https://issuer.example.test",
		auth_config_revision: "b".repeat(64),
		loopback_redirect: "http://127.0.0.1:4567/complete",
		browser_start_hash: "c".repeat(64),
		browser_transaction_hash: "d".repeat(64),
		browser_binder_hash: "e".repeat(64),
		account_subject: "subject-a",
		identity_id: "identity-a",
		link_id: "link-a",
		link_attempt_id: "historical-attempt",
		link_controller_attestation_id: "historical-controller",
		link_auth_config_revision: "f".repeat(64),
		grant_revisions_json: '[{"groupId":"group-a","revision":1}]',
		confirmation_hash: "1".repeat(64),
		completion_secret_hash: createHash("sha256").update(Buffer.alloc(32, 9)).digest("hex"),
		final_key_proof_hash: null,
		state: "confirmed",
		created_at_ms: 1000,
		expires_at_ms: 601000,
		finalized_at_ms: null,
		binding_id: null,
		audit_event_id: null,
		final_outcome_json: null,
	};
	const secret = Buffer.alloc(32, 9).toString("base64url");
	const message = JSON.stringify([
		"codemem-owner-enrollment-finalize-v1",
		"owner_enroll",
		row.coordinator_id,
		row.origin,
		row.auth_config_revision,
		row.attempt_id,
		row.device_id,
		row.public_key,
		row.key_id,
		row.fingerprint,
		row.issuer,
		row.account_subject,
		row.identity_id,
		row.link_id,
		row.confirmation_hash,
		secret,
	]);
	return {
		row,
		secret,
		message,
		signMessage: (value: string) =>
			sign(null, Buffer.from(value), keys.privateKey).toString("base64url"),
		signature: sign(null, Buffer.from(message), keys.privateKey).toString("base64url"),
	};
}

it.for([
	"valid",
	"wrong-key",
	"wrong-message",
	"wrong-purpose",
	"bad-base64",
	"short",
	"long",
	"bad-key",
])("pure verifier checks %s", async (fault) => {
	// Arrange
	const f = await proofFixture();
	let publicKey = f.row.public_key;
	let message = f.message;
	let signature = f.signature;
	if (fault === "wrong-key") publicKey = (await proofFixture()).row.public_key;
	if (fault === "wrong-message") message = "changed";
	if (fault === "wrong-purpose") message = message.replace('"owner_enroll"', '"signin"');
	if (fault === "bad-base64") signature = "!".repeat(86);
	if (fault === "short") signature = signature.slice(0, -1);
	if (fault === "long") signature += "A";
	if (fault === "bad-key") publicKey = "ssh-ed25519 invalid";
	// Act
	const result = await verifyOwnerEnrollmentSignature(publicKey, message, signature);
	// Assert
	expect(result).toBe(fault === "valid");
});

it("pure final proof hashes actual completion bytes and signature text", async () => {
	// Arrange
	const f = await proofFixture();
	// Act
	const result = await verifyPendingKeySignatureAndHashes(f.row, f.secret, f.signature);
	// Assert: proof evidence alone does not authorize or enroll a device.
	expect(result).toEqual({
		completionHash: createHash("sha256").update(Buffer.alloc(32, 9)).digest("hex"),
		keyProofHash: createHash("sha256").update(f.signature).digest("hex"),
	});
	expect(ownerEnrollmentFinalMessage(f.row, f.secret)).toBe(f.message);
});

it.for(["forged-fingerprint", "key-comment"])(
	"pure completion rejects freshly signed %s fingerprint mismatch",
	async (fault) => {
		// Arrange: retain the real private key and independently re-sign every changed field.
		const f = await proofFixture();
		const parts = JSON.parse(f.message) as unknown[];
		const originalKeyId = f.row.key_id;
		if (fault === "forged-fingerprint") f.row.fingerprint = "9".repeat(64);
		else f.row.public_key += " changed-comment";
		f.row.key_id = (await ed25519KeyId(f.row.public_key)) as string;
		parts[7] = f.row.public_key;
		parts[8] = f.row.key_id;
		parts[9] = f.row.fingerprint;
		const message = JSON.stringify(parts);
		const signature = f.signMessage(message);
		// Act
		const validSignature = await verifyOwnerEnrollmentSignature(
			f.row.public_key,
			message,
			signature,
		);
		const proof = await verifyPendingKeySignatureAndHashes(f.row, f.secret, signature);
		const completion = await verifyOwnerEnrollmentCompletion(
			f.row,
			f.row.auth_config_revision,
			f.row.created_at_ms,
			f.secret,
			signature,
		);
		// Assert: valid canonical key ID and signature cannot authorize a stale text fingerprint.
		expect(f.row.key_id).toBe(originalKeyId);
		expect(f.row.key_id).toBe(await ed25519KeyId(f.row.public_key));
		expect(f.row.fingerprint).not.toBe(
			createHash("sha256").update(f.row.public_key, "utf8").digest("hex"),
		);
		expect(validSignature).toBe(true);
		expect(proof).toBeNull();
		expect(completion).toBeNull();
	},
);

const signedFields =
	"coordinator_id origin auth_config_revision attempt_id device_id public_key key_id fingerprint issuer account_subject identity_id link_id confirmation_hash".split(
		" ",
	) as (keyof OwnerAttempt)[];
it.for(signedFields)("pure final proof rejects altered signed %s", async (field) => {
	// Arrange
	const f = await proofFixture();
	const row = { ...f.row, [field]: `${f.row[field]}-changed` };
	// Act
	const result = await verifyPendingKeySignatureAndHashes(row, f.secret, f.signature);
	// Assert
	expect(result).toBeNull();
	expect(ownerEnrollmentFinalMessage(row, f.secret)).not.toBe(f.message);
});

it.for(["changed", "malformed", "padded"])(
	"pure final proof rejects %s completion secret",
	async (fault) => {
		// Arrange
		const f = await proofFixture();
		const secrets = {
			changed: Buffer.alloc(32, 4).toString("base64url"),
			malformed: "invalid",
			padded: `${f.secret}=`,
		};
		// Act
		const result = await verifyPendingKeySignatureAndHashes(
			f.row,
			secrets[fault as keyof typeof secrets],
			f.signature,
		);
		// Assert
		expect(result).toBeNull();
	},
);

it.for([
	null,
	"bad-json",
	"{}",
	"[]",
	'[{"groupId":"group-a","revision":0}]',
	'[{"groupId":" ","revision":1}]',
	'[{"groupId":" group-a","revision":1}]',
	'[{"groupId":"group-a ","revision":1}]',
	'[{"groupId":"a\\u0000b","revision":1}]',
	'[{"groupId":"group-a","revision":1.5}]',
	'[{"groupId":"group-a","revision":1},{"groupId":"group-a","revision":2}]',
	JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ groupId: `group-${i}`, revision: 1 }))),
])("pure grant parser rejects invalid pins %j", (pins) => {
	// Arrange
	const input = pins;
	// Act
	const result = readGrantPins(input);
	// Assert
	expect(result).toBeNull();
});
it("pure grant parser accepts distinct valid pins without treating them as live grants", () => {
	// Arrange
	const pins = [
		{ groupId: "group-a", revision: 1 },
		{ groupId: "group-b", revision: 2 },
	];
	// Act
	const result = readGrantPins(JSON.stringify(pins));
	// Assert
	expect(result).toEqual(pins);
});
it("pure grant parser emits fresh canonical DTOs without extra keys or input mutation", () => {
	// Arrange
	const pins = [{ groupId: "group-a", revision: 1, callerLabel: "not-authority" }];
	const before = structuredClone(pins);
	// Act
	const result = readGrantPins(JSON.stringify(pins));
	// Assert
	expect(result).toEqual([{ groupId: "group-a", revision: 1 }]);
	expect(result?.[0]).not.toBe(pins[0]);
	if (result?.[0]) result[0].revision = 2;
	expect(pins).toEqual(before);
});

it("pending-key hashes intentionally do not compare the stored completion commitment", async () => {
	// Arrange: signature and submitted secret are valid; only the stored commitment differs.
	const f = await proofFixture();
	f.row.completion_secret_hash = "9".repeat(64);
	// Act
	const result = await verifyPendingKeySignatureAndHashes(f.row, f.secret, f.signature);
	// Assert: the stronger completion helper separately rejects this mismatch.
	expect(result?.completionHash).toBe(
		createHash("sha256").update(Buffer.alloc(32, 9)).digest("hex"),
	);
	expect(result?.completionHash).not.toBe(f.row.completion_secret_hash);
});

const requiredMetadata = [
	["account_subject", 11],
	["identity_id", 12],
	["link_id", 13],
	["confirmation_hash", 14],
] as const;
it.for(
	requiredMetadata.flatMap(([field, index]) =>
		[null, ""].map((value) => ({ field, index, value })),
	),
)("pure completion rejects freshly signed missing metadata %j", async ({ field, index, value }) => {
	// Arrange: re-sign the independent manual message layout so signature denial cannot mask this check.
	const f = await proofFixture();
	f.row[field] = value;
	const parts = JSON.parse(f.message) as unknown[];
	parts[index] = value;
	const signature = f.signMessage(JSON.stringify(parts));
	// Act
	const proof = await verifyPendingKeySignatureAndHashes(f.row, f.secret, signature);
	const completion = await verifyOwnerEnrollmentCompletion(
		f.row,
		f.row.auth_config_revision,
		f.row.created_at_ms,
		f.secret,
		signature,
	);
	// Assert: real key possession and matching completion hash pass the lower layer.
	expect(proof?.completionHash).toBe(f.row.completion_secret_hash);
	expect(completion).toBeNull();
});
it.for([0, 8640000000000000, -1, 8640000000000001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
	"pure write-time validator handles %s",
	(value) => {
		// Arrange
		const expected = value === 0 || value === 8640000000000000;
		// Act
		const result = validWriteTime(value);
		// Assert
		expect(result).toBe(expected);
	},
);

it.for(["valid", "early", "deadline", "revision", "state", "purpose", "commitment", "grants"])(
	"pure completion checks %s metadata",
	async (fault) => {
		// Arrange: this helper cannot inspect a current account link or persist enrollment.
		const f = await proofFixture();
		let now = f.row.created_at_ms;
		let revision = f.row.auth_config_revision;
		if (fault === "early") now -= 1;
		if (fault === "deadline") now = f.row.expires_at_ms;
		if (fault === "revision") revision = "9".repeat(64);
		if (fault === "state") f.row.state = "pending";
		if (fault === "purpose") Object.assign(f.row, { purpose: "signin" });
		if (fault === "commitment") f.row.completion_secret_hash = "9".repeat(64);
		if (fault === "grants") f.row.grant_revisions_json = "[]";
		// Act
		const result = await verifyOwnerEnrollmentCompletion(
			f.row,
			revision,
			now,
			f.secret,
			f.signature,
		);
		// Assert
		if (fault === "valid")
			expect(result).toMatchObject({
				grants: [{ groupId: "group-a", revision: 1 }],
				completionHash: f.row.completion_secret_hash,
			});
		else expect(result).toBeNull();
	},
);

it.for([
	"valid",
	"state",
	"binding",
	"audit",
	"groups",
	"outcome",
	"time",
	"purpose",
	"null-proof",
	"empty-proof",
	"null-secret",
	"empty-secret",
])("pure receipt shape checks %s", async (fault) => {
	// Arrange: well-shaped metadata is not evidence of an actual database commit.
	const { row, signature } = await proofFixture();
	Object.assign(row, {
		state: "finalized",
		binding_id: "binding-a",
		audit_event_id: "audit-a",
		finalized_at_ms: row.created_at_ms,
		final_key_proof_hash: createHash("sha256").update(signature).digest("hex"),
		final_outcome_json: '{"kind":"finalized","bindingId":"binding-a","groups":["group-a"]}',
	});
	if (fault === "state") row.state = "confirmed";
	if (fault === "binding") row.binding_id = "other-binding";
	if (fault === "audit") row.audit_event_id = null;
	if (fault === "groups") row.grant_revisions_json = '[{"groupId":"group-b","revision":1}]';
	if (fault === "outcome") row.final_outcome_json = "bad-json";
	if (fault === "time") row.finalized_at_ms = row.expires_at_ms;
	if (fault === "purpose") Object.assign(row, { purpose: "signin" });
	if (fault === "null-proof") row.final_key_proof_hash = null;
	if (fault === "empty-proof") row.final_key_proof_hash = "";
	if (fault === "null-secret") row.completion_secret_hash = null;
	if (fault === "empty-secret") row.completion_secret_hash = "";
	// Act
	const result = validOwnerEnrollmentReceiptMetadata(row);
	// Assert
	expect(result).toBe(fault === "valid");
});
it.for(["valid", "negative", "fractional", "wrong-ttl", "overflow"])(
	"pure attempt time handles %s",
	async (fault) => {
		// Arrange
		const { row } = await proofFixture();
		if (fault === "negative") row.created_at_ms = -1;
		if (fault === "fractional") row.created_at_ms = 0.5;
		if (fault === "wrong-ttl") row.expires_at_ms += 1;
		if (fault === "overflow") row.created_at_ms = Number.MAX_SAFE_INTEGER;
		// Act
		const result = validAttemptTime(row);
		// Assert
		expect(result).toBe(fault === "valid");
	},
);
