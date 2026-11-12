// Runs the pre-port SQL authority statement beside the ported reads and decision on the
// same database. Each case changes one fact and names the original checks it must fail,
// by index into the original CHECKS array, so the matrix proves which checks it reaches.
import { afterEach, describe, expect, it } from "vitest";
import { applyAccountConnectionSchema } from "./coordinator-account-connection-schema.js";
import { insertOwnDeviceClaim } from "./coordinator-device-rebind-test-fixtures.js";
import { prepareDeviceSelfBindAuthority } from "./coordinator-device-self-bind-authority.js";
import {
	ORIGINAL_CHECK_COUNT,
	originalFailedChecks,
	originalSelfBindSnapshot,
} from "./coordinator-device-self-bind-original-sql-test-fixtures.js";
import {
	assignLegacyCompletion,
	retainOwnReviewOwnership,
	SELF_BIND_NOW,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
interface Case {
	name: string;
	/** Original checks that must fail; "unbuilt" when the original builds no statement. */
	fails: readonly number[] | "unbuilt";
	/** Defaults to "no check fails". The issuer join refuses without failing a check. */
	eligible?: boolean;
	attemptId?: string;
	/** Replaces the configured issuer. */
	issuer?: string;
	/** The case reads ownership evidence, which the SQLite fixture's minimal backend cannot. */
	readsEvidence?: true;
	change(f: Fixture, keyId: string): unknown;
}

const OWN = "device_id='device-a'";
const SIGNED = `group_id='group-a' AND ${OWN}`;
const OTHER = `group_id='group-b' AND ${OWN}`;
const sql = (f: Fixture, text: string, ...values: unknown[]) => f.db.prepare(text).run(...values);
/** Another stored text form of the signer's key. The checks must treat it as the same key. */
const aliasKey = (f: Fixture) => `${f.signer.publicKey} alias-comment`;
function insert(f: Fixture, table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	sql(
		f,
		`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		...Object.values(row),
	);
}
const enroll = (f: Fixture, row: Record<string, unknown>) =>
	insert(f, "enrolled_devices", {
		group_id: "group-a",
		device_id: "alias-device",
		public_key: aliasKey(f),
		fingerprint: "f".repeat(64),
		identity_id: null,
		enabled: 1,
		created_at: "created",
		...row,
	});
const bind = (f: Fixture, row: Record<string, unknown>) =>
	insert(f, "coordinator_device_ownership_bindings", {
		device_id: "other-device",
		key_id: "a".repeat(64),
		identity_id: f.identityId,
		coordinator_id: f.config.coordinatorId,
		binding_id: "existing",
		provenance: "owner_enrollment",
		source_ref: "existing",
		bound_at: "created",
		...row,
	});
const revoke = (f: Fixture, kind: string, value: string) =>
	insert(f, "coordinator_device_revocations", {
		subject_kind: kind,
		subject_value: value,
		revocation_id: "revoked",
		evidence_group_id: "group-a",
		evidence_device_id: f.signer.deviceId,
		evidence_public_key: f.signer.publicKey,
		evidence_fingerprint: f.signer.fingerprint,
		created_at: "created",
	});
/** Copies the own review under a new ID, with the given column overrides as SQL text. */
const copyReview = (f: Fixture, overrides: Record<string, string>) => {
	const columns =
		"attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at".split(
			",",
		);
	const copied = { attestation_id: "'second'", review_receipt_id: "'second-review'", ...overrides };
	sql(
		f,
		`INSERT INTO coordinator_auth_controller_attestations (${columns.join(",")})
 SELECT ${columns.map((column) => copied[column as keyof typeof copied] ?? column).join(",")}
 FROM coordinator_auth_controller_attestations WHERE ${OWN}`,
	);
};
const invite = (f: Fixture, row: Record<string, unknown>) =>
	insert(f, "coordinator_invites", {
		invite_id: "invite",
		group_id: "group-a",
		token: "fixture-token",
		policy: "open",
		expires_at: "2027-01-01",
		created_at: "2026-01-01",
		consumed_at: "2026-01-02",
		bound_device_id: f.signer.deviceId,
		assigned_identity_id: "other-identity",
		...row,
	});
const foreignLink = (f: Fixture) =>
	sql(
		f,
		`INSERT INTO coordinator_auth_account_links(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
 SELECT coordinator_id,'foreign-link',issuer,'foreign-subject','foreign-identity','foreign-attempt',auth_config_revision,1,'device_claim','foreign-claim' FROM coordinator_auth_account_links`,
	);
const ownerAttempt = (
	f: Fixture,
	keyId: string,
	createdAtMs: number,
	row: Record<string, unknown> = {},
) =>
	insert(f, "coordinator_owner_enrollment_attempts", {
		coordinator_id: f.config.coordinatorId,
		attempt_id: "owner-attempt",
		purpose: "owner_enroll",
		origin: "https://app.example.test",
		device_id: "another-device",
		public_key: f.signer.publicKey,
		key_id: keyId,
		fingerprint: f.signer.fingerprint,
		issuer: f.config.issuer,
		auth_config_revision: f.config.revision,
		loopback_redirect: "http://127.0.0.1:1/x",
		browser_start_hash: "c".repeat(64),
		state: "pending",
		created_at_ms: createdAtMs,
		expires_at_ms: createdAtMs + 600_000,
		...row,
	});
const linkAttempt = (f: Fixture, identityId: string, row: Record<string, unknown> = {}) =>
	insert(f, "coordinator_auth_link_attempts", {
		coordinator_id: f.config.coordinatorId,
		attempt_id: "live-link",
		identity_id: identityId,
		group_id: "group-a",
		device_id: f.signer.deviceId,
		public_key: f.signer.publicKey,
		fingerprint: f.signer.fingerprint,
		issuer: f.config.issuer,
		auth_config_revision: f.config.revision,
		runtime_verifier_hash: "d".repeat(64),
		loopback_redirect: "http://127.0.0.1:1/x",
		state: "pending",
		created_at_ms: SELF_BIND_NOW - 1000,
		expires_at_ms: SELF_BIND_NOW + 599_000,
		browser_start_hash: "e".repeat(64),
		authority_kind: "device_claim",
		...row,
	});
/** A finished link attempt, as the one that created another Identity's link. */
const finalizedLinkAttempt = (f: Fixture, row: Record<string, unknown>) =>
	linkAttempt(f, "foreign-identity", {
		attempt_id: "foreign-attempt",
		state: "finalized",
		link_id: "foreign-link",
		account_subject: "foreign-subject",
		browser_transaction_hash: "1".repeat(64),
		completion_secret_hash: "2".repeat(64),
		finalized_at_ms: SELF_BIND_NOW - 500,
		...row,
	});
/** A raw legacy completion whose single decision is about this device. */
const legacyDecision = (f: Fixture, decision: Record<string, unknown>, coordinatorId?: string) =>
	insert(f, "coordinator_legacy_team_completions", {
		group_id: "group-a",
		candidate_ref: "raw-candidate",
		manifest_version: 1,
		manifest_json: JSON.stringify({
			coordinator_id: coordinatorId ?? f.config.coordinatorId,
			device_decisions: [
				{
					device_id: f.signer.deviceId,
					key_fingerprint: f.signer.fingerprint,
					identity_id: f.identityId,
					decision: "included",
					enabled: true,
					...decision,
				},
			],
		}),
		completed_at: "2026-01-01",
		created_at: "2026-01-01",
	});

// The schema forbids NULL in the enrollment and review columns the checks compare, and
// allows one link per Identity, so those NULLs and a second link cannot be stored.
const CASES: Case[] = [
	{ name: "the unchanged fixture", fails: [], change: () => {} },
	{
		name: "enrollments that all name no Identity (NULL)",
		fails: [],
		change: (f) => sql(f, `UPDATE enrolled_devices SET identity_id=NULL WHERE ${OWN}`),
	},
	{
		name: "a disabled signed enrollment",
		fails: [0],
		change: (f) => sql(f, `UPDATE enrolled_devices SET enabled=0 WHERE ${SIGNED}`),
	},
	{
		name: "an archived group",
		fails: [0],
		change: (f) => sql(f, "UPDATE groups SET archived_at='archived' WHERE group_id='group-a'"),
	},
	{
		name: "a missing group",
		fails: [0],
		change: (f) => sql(f, "DELETE FROM groups WHERE group_id='group-a'"),
	},
	{
		name: "the signed enrollment under another Identity",
		fails: [0, 1, 5],
		change: (f) =>
			sql(f, `UPDATE enrolled_devices SET identity_id='other-identity' WHERE ${SIGNED}`),
	},
	{
		name: "another enrollment under another Identity",
		fails: [1, 5],
		change: (f) =>
			sql(f, `UPDATE enrolled_devices SET identity_id='other-identity' WHERE ${OTHER}`),
	},
	{
		name: "another enrollment with another fingerprint",
		fails: [1],
		change: (f) =>
			sql(f, `UPDATE enrolled_devices SET fingerprint=? WHERE ${OTHER}`, "f".repeat(64)),
	},
	{
		name: "another enrollment with another text form of the key",
		fails: [1],
		change: (f) =>
			sql(f, `UPDATE enrolled_devices SET public_key=? WHERE ${OTHER}`, `${f.signer.publicKey} c`),
	},
	{
		name: "51 enrollments",
		fails: [1],
		change: (f) => {
			for (let i = 0; i < 49; i++) {
				insert(f, "groups", { group_id: `g${i}`, created_at: "created" });
				enroll(f, {
					group_id: `g${i}`,
					device_id: f.signer.deviceId,
					public_key: f.signer.publicKey,
					fingerprint: f.signer.fingerprint,
				});
			}
		},
	},
	{ name: "a text form of the key on another device", fails: [9], change: (f) => enroll(f, {}) },
	{
		name: "the exact key on another device",
		fails: [9],
		change: (f) => enroll(f, { public_key: f.signer.publicKey }),
	},
	{
		name: "a text form of the key on another device under another Identity",
		fails: [5, 9],
		change: (f) => enroll(f, { identity_id: "other-identity" }),
	},
	{
		name: "an ownership binding of the device",
		fails: [2],
		change: (f) => bind(f, { device_id: f.signer.deviceId }),
	},
	{
		name: "an ownership binding of the key under another Identity",
		fails: [2, 5],
		change: (f, keyId) => bind(f, { key_id: keyId, identity_id: "other-identity" }),
	},
	{
		name: "a device claim of the device",
		fails: [3],
		change: (f) =>
			insertOwnDeviceClaim(f.db, {
				...f.config,
				identityId: "claim-identity",
				deviceId: "device-a",
			}),
	},
	{ name: "a revoked device", fails: [4], change: (f) => revoke(f, "device_id", "device-a") },
	{ name: "a revoked key", fails: [4], change: (f, keyId) => revoke(f, "ed25519_key", keyId) },
	{
		name: "a second, revoked review",
		fails: [6],
		change: (f) => copyReview(f, { group_id: "'group-b'", revoked_at: "'revoked'" }),
	},
	{
		name: "a revoked own review",
		fails: [6, 14, 15],
		change: (f) =>
			sql(
				f,
				`UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked' WHERE ${OWN}`,
			),
	},
	{
		name: "the own review under another Identity",
		fails: [6, 14],
		change: (f) =>
			sql(
				f,
				`UPDATE coordinator_auth_controller_attestations SET identity_id='other' WHERE ${OWN}`,
			),
	},
	{
		name: "the own review in another group",
		fails: [14],
		change: (f) =>
			sql(f, `UPDATE coordinator_auth_controller_attestations SET group_id='group-b' WHERE ${OWN}`),
	},
	{
		name: "no own review",
		fails: [14, 15],
		change: (f) => sql(f, `DELETE FROM coordinator_auth_controller_attestations WHERE ${OWN}`),
	},
	{
		name: "a second active review",
		fails: [15],
		change: (f) => copyReview(f, { group_id: "'group-b'" }),
	},
	{
		name: "a review of a text form of the key on another device",
		fails: [15],
		change: (f) => copyReview(f, { device_id: "'other-device'", public_key: "public_key || ' c'" }),
	},
	{
		name: "a review that records another enrollment Identity, which no check reads",
		fails: [],
		change: (f) =>
			sql(
				f,
				`UPDATE coordinator_auth_controller_attestations SET enrollment_identity_id='x' WHERE ${OWN}`,
			),
	},
	{
		name: "a link without its audit record",
		fails: [14],
		change: (f) => sql(f, "DELETE FROM coordinator_auth_link_audit_log"),
	},
	{
		name: "a link audit record from another device",
		fails: [14],
		change: (f) => sql(f, "UPDATE coordinator_auth_link_audit_log SET device_id='elsewhere'"),
	},
	{
		name: "a link attempt without its start hash (NULL)",
		fails: [14],
		change: (f) => sql(f, "UPDATE coordinator_auth_link_attempts SET browser_start_hash=NULL"),
	},
	{
		name: "a link created at another time than its attempt",
		fails: [14],
		change: (f) =>
			sql(f, "UPDATE coordinator_auth_account_links SET created_at_ms=created_at_ms+1"),
	},
	{
		name: "a headless link",
		fails: [14],
		change: (f) =>
			sql(
				f,
				"INSERT INTO coordinator_headless_link_provenance(coordinator_id,link_id,identity_id,issuer,subject,attempt_id,created_at_ms) SELECT coordinator_id,link_id,identity_id,issuer,subject,attempt_id,created_at_ms FROM coordinator_auth_account_links",
			),
	},
	{
		name: "a revoked link",
		fails: [14],
		change: (f) =>
			sql(f, "UPDATE coordinator_auth_account_links SET revoked_at_ms=?", SELF_BIND_NOW),
	},
	{
		name: "a configured issuer other than the proven link's",
		fails: [],
		eligible: false,
		issuer: "https://issuer.example.test",
		change: () => {},
	},
	{
		name: "a consumed invite assigned to another Identity",
		fails: [7],
		change: (f) => invite(f, {}),
	},
	{
		name: "a consumed invite bound by fingerprint that targets another Identity",
		fails: [7],
		change: (f) =>
			invite(f, {
				bound_device_id: null,
				bound_fingerprint: f.signer.fingerprint,
				assigned_identity_id: null,
				target_identity_id: "other-identity",
			}),
	},
	{
		name: "a consumed invite bound to a text form of the key on another device",
		fails: [7],
		change: (f) => invite(f, { bound_device_id: "other-device", bound_public_key: aliasKey(f) }),
	},
	{
		name: "an invite revoked after it was consumed",
		fails: [7],
		change: (f) => invite(f, { revoked_at: "2026-01-03" }),
	},
	{
		name: "an invite revoked before it was consumed",
		fails: [],
		change: (f) => invite(f, { consumed_at: "2026-01-03", revoked_at: "2026-01-02" }),
	},
	{
		name: "an unconsumed invite (NULL consumed_at)",
		fails: [],
		change: (f) => invite(f, { consumed_at: null }),
	},
	{
		name: "an invite with an empty consumed_at",
		fails: [],
		change: (f) => invite(f, { consumed_at: "" }),
	},
	{
		name: "a consumed invite that names no Identity (NULL)",
		fails: [],
		change: (f) => invite(f, { assigned_identity_id: null }),
	},
	{
		name: "another Identity's link that this device's attempt created",
		fails: [8, 14],
		change: (f) => {
			foreignLink(f);
			sql(
				f,
				"UPDATE coordinator_auth_link_attempts SET link_id='foreign-link', device_id='device-a'",
			);
		},
	},
	{
		name: "another Identity's link created with a text form of the key on another device",
		fails: [8],
		change: (f) => {
			foreignLink(f);
			finalizedLinkAttempt(f, { device_id: "other-device", public_key: aliasKey(f) });
		},
	},
	{
		name: "another Identity's link with an audit record of this device",
		fails: [8],
		change: (f) => {
			foreignLink(f);
			sql(
				f,
				"INSERT INTO coordinator_auth_link_audit_log(coordinator_id,link_id,action,attempt_id,identity_id,group_id,device_id,fingerprint,auth_config_revision,created_at_ms,authority_kind,device_claim_id) SELECT coordinator_id,'foreign-link','link_created','foreign-attempt','foreign-identity','group-a','device-a',fingerprint,auth_config_revision,1,'device_claim','foreign-claim' FROM coordinator_auth_link_audit_log LIMIT 1",
			);
		},
	},
	{
		name: "a live owner-enrollment attempt for the key",
		fails: [10],
		change: (f, keyId) => ownerAttempt(f, keyId, SELF_BIND_NOW - 1000),
	},
	{
		name: "a live owner-enrollment attempt for the device with another key",
		fails: [10],
		change: (f) =>
			ownerAttempt(f, "9".repeat(64), SELF_BIND_NOW - 1000, {
				device_id: f.signer.deviceId,
				public_key: "another-key",
				fingerprint: "9".repeat(64),
			}),
	},
	{
		name: "an expired owner-enrollment attempt for the key",
		fails: [],
		change: (f, keyId) => ownerAttempt(f, keyId, SELF_BIND_NOW - 600_000),
	},
	{
		name: "a live link attempt for another Identity",
		fails: [11],
		change: (f) => linkAttempt(f, "other-identity"),
	},
	{
		name: "a live link attempt for another Identity with a text form of the key on another device",
		fails: [11],
		change: (f) =>
			linkAttempt(f, "other-identity", { device_id: "other-device", public_key: aliasKey(f) }),
	},
	{
		name: "a live link attempt for the same Identity",
		fails: [],
		change: (f) => linkAttempt(f, f.identityId),
	},
	{ name: "another live rebind attempt", fails: [12], change: (f) => f.steps().start() },
	{
		name: "the attempt's own live row",
		fails: [],
		attemptId: "self-bind",
		change: (f) => f.steps().start(),
	},
	{
		name: "a legacy exclusion of the device",
		fails: [13],
		change: (f) => legacyDecision(f, { decision: "excluded", enabled: false }),
	},
	{
		name: "a legacy decision that names no Identity (NULL)",
		fails: [13],
		change: (f) => legacyDecision(f, { identity_id: null }),
	},
	{
		name: "a legacy label that another device guessed",
		fails: [],
		change: (f) => legacyDecision(f, { identity_id: "other", identity_evidence: "label" }),
	},
	{
		name: "a legacy exclusion recorded for another coordinator",
		fails: [],
		change: (f) => legacyDecision(f, { decision: "excluded" }, "elsewhere"),
	},
	{
		name: "an unreadable legacy manifest",
		fails: [],
		change: (f) =>
			sql(
				f,
				"INSERT INTO coordinator_legacy_team_completions VALUES('group-a','x',1,'not json','c','c')",
			),
	},
	{ name: "a legacy assignment of this device", fails: [], change: assignLegacyCompletion },
	{
		name: "retained legacy ownership whose source is the own review",
		fails: [],
		readsEvidence: true,
		change: retainOwnReviewOwnership,
	},
	{
		name: "no start_authority_json column",
		fails: "unbuilt",
		change: (f) =>
			f.db.exec(
				"DROP TRIGGER coordinator_device_rebind_attempt_pins; ALTER TABLE coordinator_device_rebind_attempts DROP COLUMN start_authority_json",
			),
	},
];

const VARIANTS = (["SQLite", "D1"] as const).flatMap((kind) =>
	(["own", "peer", "peer_controller"] as const).flatMap((origin) =>
		[false, true].map((connections) => ({ kind, origin, connections })),
	),
);

describe.each(VARIANTS)("$kind $origin-origin link, connection schema $connections", (variant) => {
	it.each(CASES)("answers like the original SQL for $name", async (c) => {
		// Arrange
		const f = await selfBindFixture(variant.kind, variant.origin, undefined, {
			accountSchema: "v2",
		});
		close.push(f.close);
		if (variant.connections) await applyAccountConnectionSchema(f.backend);
		await c.change(f, (await ed25519KeyId(f.signer.publicKey)) as string);
		const input = {
			signer: f.signer,
			currentIdentityId: f.identityId,
			...(c.attemptId ? { attemptId: c.attemptId } : {}),
		};
		const config = { ...f.config, ...(c.issuer ? { issuer: c.issuer } : {}) };
		const args = [f.backend, input, config, SELF_BIND_NOW] as const;
		// Act
		const failed = await originalFailedChecks(...args);
		const original = await originalSelfBindSnapshot(...args);
		const ported = (await prepareDeviceSelfBindAuthority(...args))?.snapshot ?? null;
		// Assert
		const fails = c.readsEvidence && variant.kind === "SQLite" ? "unbuilt" : c.fails;
		expect(failed).toEqual(fails === "unbuilt" ? null : fails);
		expect(original !== null).toBe(c.eligible ?? fails.length === 0);
		expect(ported).toBe(original);
	});
});

it("reaches every check of the original statement", () => {
	// Arrange
	const every = Array.from({ length: ORIGINAL_CHECK_COUNT }, (_, index) => index);
	// Act
	const reached = new Set(CASES.flatMap((c) => (c.fails === "unbuilt" ? [] : c.fails)));
	// Assert
	expect(every.filter((index) => !reached.has(index))).toEqual([]);
});
