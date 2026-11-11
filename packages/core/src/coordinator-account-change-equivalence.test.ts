// Runs the pre-port account-change authority statement beside the ported reads and
// decision on the same database. Each case changes one fact and names the original
// checks it must fail, so the matrix proves which checks it reaches.
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountChangeFixture,
	accountChangeFixture,
	assignLegacyTeam,
	type ChangeAuthority,
	config,
	input,
	insertForeignLink,
	insertRevokedHistory,
	insertRow,
} from "../../cloudflare-coordinator-worker/test/account-change-read-set-fixture.js";
import {
	prepareAccountChangeAuthority,
	readAccountChangeBase,
} from "./coordinator-account-change-authority.js";
import {
	ORIGINAL_CHECK_NAMES,
	type OriginalCheck,
	originalAccountChangeRows,
	originalDeriveTarget,
	originalFailedChecks,
} from "./coordinator-account-change-original-sql-test-fixtures.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

type Fails = readonly OriginalCheck[] | "unbuilt";
interface Case {
	name: string;
	/** Original checks that must fail, per link authority when they differ. */
	fails: Fails | Record<ChangeAuthority, Fails>;
	/** Replaces `fails` when the connection-session schema is installed. */
	failsWithConnections?: Fails;
	/** The case applies only to this link authority's fixture. */
	only?: ChangeAuthority;
	/** Replaces the configured issuer. */
	issuer?: string;
	/** Replaces the derived target. */
	target?: (f: AccountChangeFixture) => { identity_id: string; target_link_id: string };
	change(f: AccountChangeFixture): void;
}

const OWN = `device_id='${input.signer.deviceId}'`;
const aliasKey = `${input.signer.publicKey} alias-comment`;
/** Drops a table's triggers so a test can store a row the application never would. */
const unlock = (f: AccountChangeFixture, table: string) => {
	for (const { name } of f.rows(
		`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='${table}'`,
	))
		f.exec(`DROP TRIGGER "${String(name)}"`);
};
const enroll = (f: AccountChangeFixture, row: Record<string, unknown>) =>
	insertRow(f, "enrolled_devices", {
		group_id: input.signer.groupId,
		device_id: "alias-device",
		public_key: aliasKey,
		fingerprint: "f".repeat(64),
		identity_id: null,
		enabled: 1,
		created_at: "created",
		...row,
	});
const bind = (f: AccountChangeFixture, row: Record<string, unknown>) =>
	insertRow(f, "coordinator_device_ownership_bindings", {
		device_id: "other-device",
		key_id: "e".repeat(64),
		identity_id: input.identityId,
		coordinator_id: config.coordinatorId,
		binding_id: "added-binding",
		provenance: "owner_enrollment",
		source_ref: "added",
		bound_at: "bound",
		...row,
	});
const review = (f: AccountChangeFixture, row: Record<string, unknown>) =>
	insertRow(f, "coordinator_auth_controller_attestations", {
		attestation_id: "added-review",
		coordinator_id: config.coordinatorId,
		identity_id: input.identityId,
		group_id: "group-b",
		device_id: input.signer.deviceId,
		public_key: input.signer.publicKey,
		fingerprint: input.signer.fingerprint,
		review_receipt_id: "added-receipt",
		evidence_digest: "d".repeat(64),
		created_at: "created",
		...row,
	});
const claim = (f: AccountChangeFixture, row: Record<string, unknown>) =>
	insertRow(f, "coordinator_auth_device_claims", {
		claim_id: "added-claim",
		coordinator_id: config.coordinatorId,
		identity_id: "foreign-identity",
		group_id: input.signer.groupId,
		device_id: input.signer.deviceId,
		public_key: input.signer.publicKey,
		fingerprint: input.signer.fingerprint,
		key_id: f.keyId,
		attempt_id: "added-attempt",
		issuer: config.issuer,
		auth_config_revision: config.revision,
		created_at_ms: 1,
		...row,
	});
const invite = (f: AccountChangeFixture, row: Record<string, unknown>) =>
	insertRow(f, "coordinator_invites", {
		invite_id: "invite",
		group_id: input.signer.groupId,
		token: "fixture-token",
		policy: "open",
		expires_at: "2027-01-01",
		created_at: "2026-01-01",
		consumed_at: "2026-01-02",
		bound_device_id: input.signer.deviceId,
		assigned_identity_id: "other-identity",
		...row,
	});
const legacyDecision = (f: AccountChangeFixture, decision: Record<string, unknown>) =>
	insertRow(f, "coordinator_legacy_team_completions", {
		group_id: input.signer.groupId,
		candidate_ref: "raw-candidate",
		manifest_version: 1,
		manifest_json: JSON.stringify({
			coordinator_id: config.coordinatorId,
			device_decisions: [
				{
					device_id: input.signer.deviceId,
					key_fingerprint: input.signer.fingerprint,
					identity_id: input.identityId,
					decision: "included",
					enabled: true,
					...decision,
				},
			],
		}),
		completed_at: "2026-01-01",
		created_at: "2026-01-01",
	});
const revoke = (f: AccountChangeFixture, kind: string, value: string) =>
	insertRow(f, "coordinator_device_revocations", {
		subject_kind: kind,
		subject_value: value,
		revocation_id: "revoked",
		evidence_group_id: input.signer.groupId,
		evidence_device_id: input.signer.deviceId,
		evidence_public_key: input.signer.publicKey,
		evidence_fingerprint: input.signer.fingerprint,
		created_at: "created",
	});
const foreignAttempt = (f: AccountChangeFixture, row: Record<string, unknown>) =>
	insertRow(f, "coordinator_auth_link_attempts", {
		coordinator_id: config.coordinatorId,
		attempt_id: "foreign-attempt",
		identity_id: "foreign-identity",
		group_id: input.signer.groupId,
		device_id: input.signer.deviceId,
		public_key: input.signer.publicKey,
		fingerprint: input.signer.fingerprint,
		issuer: config.issuer,
		auth_config_revision: config.revision,
		runtime_verifier_hash: "1".repeat(64),
		loopback_redirect: "http://127.0.0.1:1/x",
		state: "finalized",
		created_at_ms: 1,
		expires_at_ms: 600001,
		browser_start_hash: "2".repeat(64),
		authority_kind: "device_claim",
		link_id: "foreign-link",
		account_subject: "foreign-subject",
		browser_transaction_hash: "3".repeat(64),
		completion_secret_hash: "4".repeat(64),
		finalized_at_ms: 2,
		...row,
	});
const editLinkAttempt = (f: AccountChangeFixture, assignment: string) => {
	unlock(f, "coordinator_auth_link_attempts");
	f.exec(
		`UPDATE coordinator_auth_link_attempts SET ${assignment} WHERE link_id = (SELECT link_id FROM coordinator_auth_account_links)`,
	);
};

/** A link of another Identity with the given ID, without creation records. */
const extraLink = (f: AccountChangeFixture, linkId: string, identityId: string) =>
	f.exec(
		`INSERT INTO coordinator_auth_account_links(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
 SELECT coordinator_id,?,issuer,?,?,?,auth_config_revision,1,'device_claim',? FROM coordinator_auth_account_links LIMIT 1`,
		linkId,
		`${linkId}-subject`,
		identityId,
		`${linkId}-attempt`,
		`${linkId}-claim`,
	);
// Link IDs that sort above and below the fixture link's random UUID in SQL text order.
const HIGH_LINK = "zz-bound-link";
const LOW_LINK = "0-claimed-link";
/** Makes the device's own claim no longer match its key, keeping its creation records. */
const unmatchClaimKey = (f: AccountChangeFixture) => {
	unlock(f, "coordinator_auth_device_claims");
	f.exec(`UPDATE coordinator_auth_device_claims SET key_id=? WHERE ${OWN}`, "f".repeat(64));
};
const dropBinding = (f: AccountChangeFixture) => {
	unlock(f, "coordinator_device_ownership_bindings");
	f.exec("DELETE FROM coordinator_device_ownership_bindings");
};

// The fixture's own review, claim and binding differ by link authority: a device-claim
// link comes with this device's claim and binding, a controller-reviewed link with this
// device's current review. Columns the schema declares NOT NULL get no NULL case.
const CASES: Case[] = [
	{ name: "the unchanged fixture", fails: [], change: () => {} },
	{
		name: "an enrollment that names no Identity (NULL)",
		fails: [],
		change: (f) => f.exec(`UPDATE enrolled_devices SET identity_id=NULL WHERE ${OWN}`),
	},
	{
		name: "an enrollment that names the link's Identity",
		fails: [],
		change: (f) =>
			f.exec(`UPDATE enrolled_devices SET identity_id=? WHERE ${OWN}`, input.identityId),
	},
	{
		name: "a disabled signed enrollment",
		fails: {
			device_claim: ["enrollmentLive"],
			controller_attestation: ["enrollmentLive", "proof"],
		},
		change: (f) => f.exec(`UPDATE enrolled_devices SET enabled=0 WHERE ${OWN}`),
	},
	{
		name: "an archived group",
		fails: {
			device_claim: ["enrollmentLive"],
			controller_attestation: ["enrollmentLive", "proof"],
		},
		change: (f) =>
			f.exec("UPDATE groups SET archived_at='archived' WHERE group_id=?", input.signer.groupId),
	},
	{
		name: "a missing group",
		fails: { device_claim: ["groupRow"], controller_attestation: ["groupRow", "proof"] },
		change: (f) => {
			f.exec("PRAGMA foreign_keys=OFF");
			f.exec("DELETE FROM groups WHERE group_id=?", input.signer.groupId);
		},
	},
	{
		name: "a missing signed enrollment",
		fails: {
			device_claim: ["enrollment", "groupRow", "enrollmentLive"],
			controller_attestation: ["enrollment", "groupRow", "enrollmentLive", "proof"],
		},
		change: (f) => f.exec(`UPDATE enrolled_devices SET fingerprint=? WHERE ${OWN}`, "9".repeat(64)),
	},
	{
		name: "the signed enrollment under another Identity",
		fails: {
			device_claim: ["requesterSubject", "enrollmentLive"],
			controller_attestation: ["requesterSubject", "enrollmentLive", "proof"],
		},
		change: (f) => f.exec(`UPDATE enrolled_devices SET identity_id='other-identity' WHERE ${OWN}`),
	},
	{
		name: "a text form of the key on another device under another Identity",
		fails: ["requesterSubject"],
		change: (f) => enroll(f, { identity_id: "other-identity" }),
	},
	{
		name: "a text form of the key on another device under no Identity (NULL)",
		fails: [],
		change: (f) => enroll(f, {}),
	},
	{
		name: "a binding of the key under another Identity",
		only: "controller_attestation",
		fails: ["requesterSubject"],
		change: (f) => bind(f, { key_id: f.keyId, identity_id: "other-identity" }),
	},
	{
		name: "a binding of the device under another Identity",
		only: "controller_attestation",
		fails: ["requesterSubject"],
		change: (f) => bind(f, { device_id: input.signer.deviceId, identity_id: "other-identity" }),
	},
	{
		name: "a review of the device for another Identity",
		fails: {
			// This key's own binding keeps the claim check satisfied.
			device_claim: ["requesterAttestationIdentity", "requesterAttestation"],
			controller_attestation: ["requesterAttestationIdentity", "requesterClaimIdentity"],
		},
		change: (f) => review(f, { identity_id: "other-identity" }),
	},
	{
		name: "a review of a text form of the key on another device for another Identity",
		fails: {
			// This key's own binding keeps the claim check satisfied.
			device_claim: ["requesterAttestationIdentity", "requesterAttestation"],
			controller_attestation: ["requesterAttestationIdentity", "requesterClaimIdentity"],
		},
		change: (f) =>
			review(f, { identity_id: "other-identity", device_id: "other-device", public_key: aliasKey }),
	},
	{
		name: "a revoked review of the device in another group",
		fails: { device_claim: ["requesterAttestation"], controller_attestation: [] },
		change: (f) => review(f, { revoked_at: "revoked" }),
	},
	{
		name: "a review of the device in another group",
		fails: [],
		change: (f) => review(f, {}),
	},
	{
		name: "the own review revoked",
		only: "controller_attestation",
		fails: ["requesterAttestation", "proof"],
		target: (f) => ({ identity_id: input.identityId, target_link_id: f.linkId() }),
		change: (f) => {
			unlock(f, "coordinator_auth_controller_attestations");
			f.exec("UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked'");
		},
	},
	{
		name: "another Identity's claim of the device",
		only: "controller_attestation",
		fails: ["requesterClaimIdentity"],
		change: (f) => claim(f, {}),
	},
	{
		name: "another Identity's dormant claim beside this key's binding",
		only: "controller_attestation",
		fails: [],
		change: (f) => {
			claim(f, { device_id: "other-device" });
			bind(f, { device_id: input.signer.deviceId, key_id: f.keyId });
		},
	},
	{
		name: "another Identity's claim with an active link beside this key's binding",
		only: "controller_attestation",
		fails: ["requesterClaimIdentity"],
		change: (f) => {
			claim(f, { device_id: "other-device" });
			bind(f, { device_id: input.signer.deviceId, key_id: f.keyId });
			insertForeignLink(f);
		},
	},
	// Several candidate links. Each other Identity's link reaches the derivation through a
	// different proof, because the schema allows one claim, review and binding per device.
	{
		name: "two candidate links where the higher link ID carries this device's binding",
		only: "controller_attestation",
		fails: [
			"requesterAttestationIdentity",
			"requesterAttestation",
			"requesterLink",
			"attempt",
			"attemptMatch",
			"birth",
		],
		change: (f) => {
			extraLink(f, HIGH_LINK, "bound-identity");
			bind(f, { device_id: input.signer.deviceId, key_id: f.keyId, identity_id: "bound-identity" });
		},
	},
	{
		name: "two candidate links that both have no binding (NULL bound)",
		only: "controller_attestation",
		fails: [
			"requesterAttestationIdentity",
			"requesterClaimIdentity",
			"requesterAttestation",
			"requesterLink",
			"attempt",
			"attemptMatch",
			"birth",
			"proof",
		],
		change: (f) => {
			extraLink(f, LOW_LINK, "claimed-identity");
			claim(f, { identity_id: "claimed-identity" });
		},
	},
	{
		name: "a candidate link joined to this device's binding and another device's binding",
		fails: [],
		change: (f) => {
			if (f.rows(`SELECT 1 FROM coordinator_device_ownership_bindings WHERE ${OWN}`).length === 0)
				bind(f, { device_id: input.signer.deviceId, key_id: f.keyId, binding_id: "own-binding" });
			bind(f, {});
		},
	},
	{
		name: "three candidate links where the middle one carries this device's binding",
		only: "controller_attestation",
		fails: [
			"requesterAttestationIdentity",
			"requesterClaimIdentity",
			"requesterAttestation",
			"requesterLink",
			"attempt",
			"attemptMatch",
			"birth",
		],
		change: (f) => {
			extraLink(f, LOW_LINK, "claimed-identity");
			claim(f, { identity_id: "claimed-identity" });
			extraLink(f, HIGH_LINK, "bound-identity");
			bind(f, { device_id: input.signer.deviceId, key_id: f.keyId, identity_id: "bound-identity" });
		},
	},
	// Isolated proof branches.
	{
		name: "this key's binding as the only proof (the claim no longer matches the key)",
		only: "device_claim",
		fails: [],
		change: unmatchClaimKey,
	},
	{
		name: "no proof at all (the claim no longer matches the key and no binding)",
		only: "device_claim",
		fails: ["proof"],
		// Nothing names this device any more, so no target is derived; pin the link.
		target: (f) => ({ identity_id: input.identityId, target_link_id: f.linkId() }),
		change: (f) => {
			unmatchClaimKey(f);
			dropBinding(f);
		},
	},
	{
		name: "a claim whose genesis fails, with no binding",
		only: "device_claim",
		// The link's own birth record fails either way. Only the connection schema also
		// requires the claim's genesis before the claim counts as this device's proof.
		fails: ["birth"],
		failsWithConnections: ["birth", "proof"],
		change: (f) => {
			unlock(f, "coordinator_auth_device_claims");
			f.exec(
				`UPDATE coordinator_auth_device_claims SET created_at_ms=created_at_ms+1 WHERE ${OWN}`,
			);
			dropBinding(f);
		},
	},
	{
		name: "a claim of the link's Identity that is not the link's claim",
		only: "controller_attestation",
		fails: [],
		change: (f) => claim(f, { identity_id: input.identityId }),
	},
	{
		name: "a consumed invite that assigns the device to another Identity",
		fails: ["requesterInvite"],
		change: (f) => invite(f, {}),
	},
	{
		name: "a consumed invite bound by fingerprint that targets another Identity",
		fails: ["requesterInvite"],
		change: (f) =>
			invite(f, {
				bound_device_id: null,
				bound_fingerprint: input.signer.fingerprint,
				assigned_identity_id: null,
				target_identity_id: "other-identity",
			}),
	},
	{
		name: "a consumed invite that names no Identity (NULL)",
		fails: [],
		change: (f) => invite(f, { assigned_identity_id: null }),
	},
	{
		name: "an unconsumed invite (NULL consumed_at)",
		fails: [],
		change: (f) => invite(f, { consumed_at: null }),
	},
	{
		name: "another Identity's link that this device's attempt created",
		fails: ["requesterLink"],
		change: (f) => {
			insertForeignLink(f);
			foreignAttempt(f, {});
		},
	},
	{
		name: "another Identity's link with an audit record of this device",
		fails: ["requesterLink"],
		change: (f) => {
			insertForeignLink(f);
			f.exec(`INSERT INTO coordinator_auth_link_audit_log(coordinator_id,link_id,action,attempt_id,identity_id,group_id,device_id,fingerprint,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
 SELECT coordinator_id,'foreign-link','link_created','foreign-attempt','foreign-identity',group_id,device_id,fingerprint,auth_config_revision,1,'device_claim','foreign-claim' FROM coordinator_auth_link_audit_log LIMIT 1`);
		},
	},
	{
		name: "a legacy exclusion of the device",
		fails: {
			device_claim: ["requesterLegacyUnwaivable"],
			controller_attestation: ["requesterLegacyUnwaivable", "requesterLegacy"],
		},
		change: (f) => legacyDecision(f, { decision: "excluded", enabled: false }),
	},
	{
		name: "a legacy decision about the device under another Identity",
		fails: { device_claim: [], controller_attestation: ["requesterLegacy"] },
		change: (f) => legacyDecision(f, { identity_id: "other-identity" }),
	},
	{
		name: "a legacy decision that names no Identity (NULL)",
		fails: { device_claim: [], controller_attestation: ["requesterLegacy"] },
		change: (f) => legacyDecision(f, { identity_id: null }),
	},
	{
		name: "a current legacy assignment of the device",
		fails: [],
		change: assignLegacyTeam,
	},
	{
		name: "a legacy assignment whose enrollment is disabled",
		fails: {
			device_claim: ["requesterSubject", "enrollmentLive"],
			controller_attestation: ["requesterSubject", "enrollmentLive", "proof"],
		},
		change: (f) => {
			assignLegacyTeam(f);
			f.exec(`UPDATE enrolled_devices SET enabled=0 WHERE ${OWN}`);
		},
	},
	{
		name: "a configured issuer other than the link's",
		fails: ["link"],
		issuer: "https://issuer.example.test",
		change: () => {},
	},
	{
		name: "a target link that does not exist",
		// Only the device-claim fixture's enrollment names the link's Identity.
		fails: {
			device_claim: ["link", "attempt", "enrollmentLive", "attemptMatch", "birth", "proof"],
			controller_attestation: ["link", "attempt", "attemptMatch", "birth", "proof"],
		},
		target: () => ({ identity_id: input.identityId, target_link_id: "missing-link" }),
		change: () => {},
	},
	{
		name: "a target Identity that is not an Identity identifier",
		fails: "unbuilt",
		target: (f) => ({ identity_id: " padded-identity", target_link_id: f.linkId() }),
		change: () => {},
	},
	{
		name: "a revoked link",
		fails: ["notRevoked"],
		change: (f) => f.exec("UPDATE coordinator_auth_account_links SET revoked_at_ms=5"),
	},
	{
		name: "a revocation in the Identity's history",
		fails: ["notRevoked"],
		change: insertRevokedHistory,
	},
	{
		name: "a revoked device",
		fails: ["deviceNotRevoked"],
		change: (f) => revoke(f, "device_id", input.signer.deviceId),
	},
	{
		name: "a revoked key",
		fails: ["deviceNotRevoked"],
		change: (f) => revoke(f, "ed25519_key", f.keyId),
	},
	{
		name: "a creation attempt under another configuration revision",
		fails: { device_claim: ["attemptMatch", "birth"], controller_attestation: ["attemptMatch"] },
		change: (f) => editLinkAttempt(f, `auth_config_revision='${"b".repeat(64)}'`),
	},
	{
		name: "a creation attempt for another subject",
		fails: { device_claim: ["attemptMatch", "birth"], controller_attestation: ["attemptMatch"] },
		change: (f) => editLinkAttempt(f, "account_subject='another-subject'"),
	},
	{
		name: "a link without its creation attempt",
		fails: ["attempt", "attemptMatch", "birth"],
		change: (f) => editLinkAttempt(f, "attempt_id='moved-attempt'"),
	},
	{
		name: "a link without its audit record",
		fails: ["birth"],
		change: (f) => {
			unlock(f, "coordinator_auth_link_audit_log");
			f.exec("DELETE FROM coordinator_auth_link_audit_log");
		},
	},
];

const VARIANTS = (["device_claim", "controller_attestation"] as const).flatMap((authority) =>
	[true, false].map((connections) => ({ authority, connections })),
);

function expected(c: Case, variant: Variant): Fails {
	if (variant.connections && c.failsWithConnections) return c.failsWithConnections;
	const { fails } = c;
	if (Array.isArray(fails) || fails === "unbuilt") return fails as Fails;
	return (fails as Record<ChangeAuthority, Fails>)[variant.authority];
}

type Variant = (typeof VARIANTS)[number];
type OriginalRow = NonNullable<Awaited<ReturnType<typeof originalAccountChangeRows>>>[number];

/** The fixture for one variant with one case's change applied. */
async function arrangeCase(variant: Variant, c: Case) {
	const f = await accountChangeFixture(variant.authority);
	close.push(f.close);
	// The account schema without the connection-session extension, as the original
	// builder detects it: no start_order column on browser transactions.
	if (!variant.connections)
		f.exec(
			"ALTER TABLE coordinator_auth_browser_transactions RENAME COLUMN start_order TO start_order_hidden",
		);
	c.change(f);
	return { f, cfg: { ...config, ...(c.issuer ? { issuer: c.issuer } : {}) } };
}

/** What the original statement and the port each answer on the same database. */
async function answers(f: AccountChangeFixture, c: Case, cfg: typeof config) {
	const now = f.clock.now;
	const originalTarget = await originalDeriveTarget(
		f.backend,
		cfg,
		{ signer: input.signer },
		f.keyId,
	);
	const base = await readAccountChangeBase(f.backend, cfg, input.signer, {
		deriveTarget: { keyId: f.keyId },
	});
	const target = c.target?.(f) ?? originalTarget;
	if (!target) throw new Error("no target");
	return {
		originalTarget,
		portedTarget: base.target,
		failed: await originalFailedChecks(f.backend, cfg, input.signer, target, now),
		rows: await originalAccountChangeRows(f.backend, cfg, input.signer, target, now),
		ported: await prepareAccountChangeAuthority(f.backend, base, cfg, input.signer, target, now),
	};
}

const grantOf = (row: OriginalRow | undefined) =>
	row
		? {
				coordinatorId: row.coordinator_id,
				linkId: row.link_id,
				identityId: row.identity_id,
				issuer: row.issuer,
				subject: row.subject,
				enrollmentIdentityId: row.enrollment_identity_id,
			}
		: null;

describe.each(VARIANTS)("$authority link, connection schema $connections", (variant) => {
	const cases = CASES.filter((c) => !c.only || c.only === variant.authority);
	it.each(cases)("answers like the original SQL for $name", async (c) => {
		// Arrange
		const { f, cfg } = await arrangeCase(variant, c);
		const fails = expected(c, variant);
		const allowed = fails !== "unbuilt" && fails.length === 0;
		// Act
		const a = await answers(f, c, cfg);
		// Assert
		expect(a.portedTarget).toEqual(a.originalTarget);
		expect(a.failed, JSON.stringify(a.failed)).toEqual(fails === "unbuilt" ? null : fails);
		expect(a.ported === null).toBe(a.rows === null);
		expect(a.rows?.length ?? 0).toBe(allowed ? 1 : 0);
		expect(a.ported?.grant ?? null).toEqual(grantOf(a.rows?.[0]));
	});
});

it("reaches every check of the original statement", () => {
	// Arrange
	const reached = new Set(
		CASES.flatMap((c) =>
			VARIANTS.filter((v) => !c.only || c.only === v.authority).flatMap((v) => {
				const fails = expected(c, v);
				return fails === "unbuilt" ? [] : fails;
			}),
		),
	);
	// Act / Assert
	expect(ORIGINAL_CHECK_NAMES.filter((name) => !reached.has(name))).toEqual([]);
});
