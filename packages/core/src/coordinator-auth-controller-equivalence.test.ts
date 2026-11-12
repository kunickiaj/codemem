// Runs each controller review twice on identical fixtures: once through the ported store,
// which checks the reviewed snapshot with read-set reads and guards, and once through the
// store methods as they were at 9a9bf301f, with every check inside the WITH-stage SQL. A
// check flipped just before a stage's statement must give the same answer and the same
// rows, in both backends and both resolution schema variants. Each case records that the
// change reached its stage in both runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	seedClaimSql,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { applyAccountConnectionSchema } from "./coordinator-account-connection-schema.js";
import { setupV2Store } from "./coordinator-account-schema-sqlite-test-fixtures.js";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import {
	OriginalD1ControllerReview,
	OriginalSqliteControllerReview,
} from "./coordinator-auth-controller-original-sql-test-fixtures.js";
import { beforeStatements } from "./coordinator-auth-controller-race-test-fixtures.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	type Backend,
	enroll,
	type Fixture,
	review,
	setupStore,
	sqliteD1,
} from "./coordinator-auth-store-test-fixtures.js";
import {
	binding,
	claim,
	controller,
	databaseSnapshot,
	history,
	insert,
	invitation,
	otherKey,
	signer,
	sourceRef,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { EXPECTED_KEY_ID } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Variant = "ready" | "missing";
type Op = "create" | "retry" | "snapshot";
type Stage = "create" | "eligible" | "final";

// The statement each stage's checks ran in. Both implementations share these texts: the
// insert, the eligibility read, and the read of the current attestation.
const STAGES: [Stage, RegExp][] = [
	["create", /INSERT INTO coordinator_auth_controller_attestations\s*\(/u],
	["eligible", /SELECT 1 AS eligible FROM (?:enrolled_devices|controller_review_subject) e\b/u],
	["final", /SELECT a\.\* FROM coordinator_auth_controller_attestations a\b/u],
];
const stagePattern = (stage: Stage) => STAGES.find(([name]) => name === stage)?.[1] ?? /$^/u;

const resolutionTable = "coordinator_legacy_owner_resolutions";
const REVOKED = "2026-10-09T00:00:00.000Z";
const set = (f: Fixture, sql: string, ...values: (string | number | null)[]) =>
	f.db.prepare(sql).run(...values);

// ---- Ordinary reviews: one consumed invite and one history record for A. ----

const INVITE = {
	inviteId: "invite-a",
	kind: "team_member" as const,
	actorId: "A",
	assignedIdentityId: "A",
	targetIdentityId: null,
	digest: "c".repeat(64),
};

async function ordinarySeed(f: Fixture): Promise<CoordinatorAuthControllerReviewInput> {
	await enroll(f.store, review({ ...signer, identityId: "A" }));
	history(f, { label: "A" });
	invitation(f, {
		invite_id: INVITE.inviteId,
		revoked_at: null,
		assigned_identity_id: "A",
		recipient_actor_id: "A",
	});
	const input = review({
		...signer,
		identityId: "A",
		attestationId: "ordinary-controller",
		reviewReceiptId: "ordinary-receipt",
	});
	input.verifiedSnapshot = {
		enrollmentIdentityId: null,
		invites: [INVITE],
		legacyHistory: await f.store.captureAuthControllerLegacyHistory(input),
	};
	return input;
}

const inviteSet = (column: string, value: string | null) => (f: Fixture) =>
	set(f, `UPDATE coordinator_invites SET ${column} = ? WHERE invite_id = ?`, value, "invite-a");

/** The ready table is dropped, or the missing one appears. */
function resolutionSchema(f: Fixture, variant: Variant) {
	if (variant === "ready") f.db.exec(`DROP TABLE ${resolutionTable}`);
	else f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
}

/** Every check the old ordinary statements made, flipped once each. */
const ORDINARY_CHANGES: Record<string, (f: Fixture, variant: Variant) => void> = {
	"invite revoked": inviteSet("revoked_at", REVOKED),
	"invite digest": inviteSet("reviewed_preview_digest", "d".repeat(64)),
	"invite actor": inviteSet("recipient_actor_id", "B"),
	"invite assigned identity": inviteSet("assigned_identity_id", "B"),
	"invite target identity": inviteSet("target_identity_id", "A"),
	"invite kind": inviteSet("invite_kind", "add_device"),
	"invite bound key": inviteSet("bound_public_key", otherKey),
	"invite consumption": inviteSet("consumed_at", ""),
	"invite deleted": (f) => set(f, "DELETE FROM coordinator_invites WHERE invite_id='invite-a'"),
	"invite added": (f) =>
		invitation(f, {
			invite_id: "invite-new",
			token: "synthetic-token-new",
			revoked_at: null,
			assigned_identity_id: "A",
			recipient_actor_id: "A",
		}),
	"unrelated invite": (f) =>
		invitation(f, {
			invite_id: "invite-other",
			token: "synthetic-token-other",
			revoked_at: null,
			group_id: "other-group",
		}),
	"history added": (f) =>
		set(
			f,
			`INSERT INTO coordinator_legacy_team_completions
			(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
			SELECT 'second-group',candidate_ref || '-2',manifest_version,manifest_json,completed_at,created_at
			FROM coordinator_legacy_team_completions`,
		),
	"history metadata": (f) =>
		set(f, "UPDATE coordinator_legacy_team_completions SET created_at = ?", REVOKED),
	"history deleted": (f) => set(f, "DELETE FROM coordinator_legacy_team_completions"),
	"history key alias": (f) => {
		set(f, "INSERT OR IGNORE INTO groups(group_id,created_at) VALUES ('alias-group','x')");
		set(
			f,
			`INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,enabled,created_at)
			VALUES ('alias-group','alias-device',?,?,1,'x')`,
			`${signer.publicKey} alias`,
			signer.fingerprint,
		);
	},
	"enrollment label": (f) =>
		set(f, "UPDATE enrolled_devices SET identity_id='A' WHERE device_id=?", signer.deviceId),
	"enrollment disabled": (f) =>
		set(f, "UPDATE enrolled_devices SET enabled=0 WHERE device_id=?", signer.deviceId),
	"enrollment key": (f) =>
		set(f, "UPDATE enrolled_devices SET public_key=? WHERE device_id=?", otherKey, signer.deviceId),
	"group archived": (f) =>
		set(f, "UPDATE groups SET archived_at=? WHERE group_id=?", REVOKED, signer.groupId),
	"device revoked": (f) => revocation(f, "device_id", signer.deviceId),
	"key revoked": (f) => revocation(f, "ed25519_key", EXPECTED_KEY_ID),
	"retained binding": (f) => binding(f),
	"retained claim": (f) => claim(f),
	"resolution schema": resolutionSchema,
	"retained resolution": (f, variant) => {
		if (variant === "missing") return f.db.exec(`CREATE TABLE ${resolutionTable} (device_id TEXT)`);
		insert(f, resolutionTable, sourceRef(controller(f, { identity_id: "B" })));
	},
};

/** Changes only a retry can see: its own attestation's state. */
const RETRY_CHANGES: Record<string, (f: Fixture) => void> = {
	"attestation revoked": (f) =>
		set(
			f,
			"UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE attestation_id='ordinary-controller'",
			REVOKED,
		),
	"attestation receipt": (f) =>
		set(
			f,
			"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed' WHERE attestation_id='ordinary-controller'",
		),
};

function revocation(f: Fixture, kind: string, value: string) {
	set(
		f,
		`INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,
		evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
		VALUES (?,?,'synthetic-revocation',?,?,?,?,?)`,
		kind,
		value,
		signer.groupId,
		signer.deviceId,
		signer.publicKey,
		signer.fingerprint,
		REVOKED,
	);
}

// ---- Owner reviews: recover current-laptop for the identity of an existing link. ----

const ownerSigner = {
	groupId: "group-a",
	deviceId: "current-laptop",
	publicKey: otherKey,
	fingerprint: "c".repeat(64),
};

async function ownerSeed(f: Fixture): Promise<CoordinatorAuthControllerReviewInput> {
	// Persisted DEVICE_CLAIM genesis is trusted fixture proof, as in the owner review suite.
	f.db.exec(seedEnrollmentSql);
	f.db.exec("DELETE FROM enrolled_devices WHERE device_id='unrelated-device'");
	f.db.exec(seedClaimSql);
	f.db.exec(`INSERT INTO coordinator_auth_account_links
		(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,
		created_at_ms,authority_kind,device_claim_id)
		SELECT coordinator_id,claim_id,issuer,'private-claim-subject',identity_id,attempt_id,
		auth_config_revision,created_at_ms,'device_claim',claim_id FROM coordinator_auth_device_claims;
		INSERT INTO coordinator_auth_link_audit_log
		(coordinator_id,link_id,attempt_id,identity_id,group_id,device_id,fingerprint,
		auth_config_revision,created_at_ms,action,authority_kind,device_claim_id)
		SELECT coordinator_id,link_id,attempt_id,identity_id,group_id,device_id,fingerprint,
		auth_config_revision,finalized_at_ms,'link_created','device_claim',link_id
		FROM coordinator_auth_link_attempts;`);
	const d1 = sqliteD1(f.db);
	await applyAccountConnectionSchema({
		first: ({ sql, values }) =>
			d1
				.prepare(sql)
				.bind(...values)
				.first(),
		run: async ({ sql, values }) => f.db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			f.db.transaction(() =>
				statements.map(({ sql, values }) => f.db.prepare(sql).run(...values).changes),
			)(),
	});
	await f.store.enrollDevice(ownerSigner.groupId, ownerSigner);
	set(
		f,
		`INSERT INTO coordinator_invites
		(invite_id,group_id,token,policy,expires_at,created_at,consumed_at,
		bound_device_id,bound_public_key,bound_fingerprint,invite_kind,
		recipient_actor_id,target_identity_id,reviewed_preview_digest)
		VALUES ('owner-invite',?,'synthetic-token','auto','2030','created','consumed',?,?,?,
		'add_device','identity-a','identity-a',?)`,
		ownerSigner.groupId,
		ownerSigner.deviceId,
		ownerSigner.publicKey,
		ownerSigner.fingerprint,
		"d".repeat(64),
	);
	const link = f.db.prepare("SELECT * FROM coordinator_auth_account_links").get() as Record<
		string,
		string | number
	>;
	const input = review({
		...ownerSigner,
		coordinatorId: String(link.coordinator_id),
		identityId: String(link.identity_id),
		attestationId: "owner-controller",
		reviewReceiptId: "owner-receipt",
	});
	input.verifiedSnapshot = {
		enrollmentIdentityId: null,
		invites: [
			{
				inviteId: "owner-invite",
				kind: "add_device",
				actorId: "identity-a",
				assignedIdentityId: null,
				targetIdentityId: "identity-a",
				digest: "d".repeat(64),
			},
		],
		legacyHistory: await f.store.captureAuthControllerLegacyHistory(input),
		accountOwnerTarget: {
			purpose: "existing_account_owner",
			coordinatorId: String(link.coordinator_id),
			targetIdentityId: String(link.identity_id),
			issuer: String(link.issuer),
			linkId: String(link.link_id),
			authConfigRevision: String(link.auth_config_revision),
			createdAtMs: Number(link.created_at_ms),
		},
	};
	return input;
}

const linkSet = (assignment: string) => (f: Fixture) =>
	set(f, `UPDATE coordinator_auth_account_links SET ${assignment}`);
const otherController = (patch: Record<string, string | null>) => (f: Fixture) =>
	controller(f, {
		attestation_id: "other-controller",
		coordinator_id: "coordinator-a",
		review_receipt_id: "other-receipt",
		group_id: "group-b",
		device_id: ownerSigner.deviceId,
		public_key: ownerSigner.publicKey,
		fingerprint: ownerSigner.fingerprint,
		identity_id: "identity-b",
		enrollment_identity_id: null,
		...patch,
	});

/** Every owner target check the old owner stage made, flipped once each. */
const OWNER_CHANGES: Record<string, (f: Fixture) => void> = {
	"link revoked": linkSet(`revoked_at_ms=${NOW + 1}`),
	"link issuer": linkSet("issuer='https://changed.example.test'"),
	"link id": linkSet("link_id='reconnected-link'"),
	"link revision": linkSet(`auth_config_revision='${"f".repeat(64)}'`),
	"link created at": linkSet("created_at_ms=created_at_ms+1"),
	"link deleted": (f) => set(f, "DELETE FROM coordinator_auth_account_links"),
	"link provenance": (f) => set(f, "DELETE FROM coordinator_auth_link_audit_log"),
	"owner claim conflict": (f) =>
		claim(f, {
			claim_id: "owner-conflict",
			coordinator_id: "coordinator-a",
			key_id: "f".repeat(64),
			attempt_id: "conflict-attempt",
			identity_id: "identity-b",
			group_id: ownerSigner.groupId,
			device_id: ownerSigner.deviceId,
			public_key: ownerSigner.publicKey,
			fingerprint: ownerSigner.fingerprint,
		}),
	"same enrollment, other identity": otherController({ group_id: ownerSigner.groupId }),
	"same enrollment, revoked": otherController({
		group_id: ownerSigner.groupId,
		identity_id: "identity-a",
		revoked_at: REVOKED,
	}),
	"other group, same device": otherController({ public_key: "unrelated-key" }),
	"other group, same key": otherController({ device_id: "elsewhere" }),
	"other group, same identity": otherController({ identity_id: "identity-a" }),
	"owner invite revoked": (f) =>
		set(f, "UPDATE coordinator_invites SET revoked_at=? WHERE invite_id='owner-invite'", REVOKED),
};

// ---- Runner ----

interface Case {
	op: Op;
	stage: Stage;
	seed(f: Fixture): Promise<CoordinatorAuthControllerReviewInput>;
	change(f: Fixture, variant: Variant): void;
}

async function run(
	backend: Backend,
	variant: Variant,
	kase: Case,
	implementation: "ported" | "original",
) {
	const f =
		backend === "SQLite"
			? setupV2Store({ authClock: () => NOW })
			: setupStore(backend, { authClock: () => NOW });
	try {
		// The D1 fixture schema ships the resolution table; the SQLite one does not.
		if (variant === "ready") f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
		else f.db.exec(`DROP TABLE IF EXISTS ${resolutionTable}`);
		const input = await kase.seed(f);
		// Retries and snapshot reads start from the attestation an earlier review created.
		if (kase.op !== "create")
			expect(await f.store.createAuthControllerAttestation(input)).toMatchObject({
				kind: "created",
			});
		const original =
			backend === "D1"
				? new OriginalD1ControllerReview(sqliteD1(f.db))
				: new OriginalSqliteControllerReview(f.db);
		const review = implementation === "ported" ? f.store : original;
		const hook = beforeStatements(f.db, [
			{ pattern: stagePattern(kase.stage), mutate: () => kase.change(f, variant) },
		]);
		// A thrown error is an answer too: the request fails instead of being refused.
		const result = await (kase.op === "snapshot"
			? review.readAuthControllerAttestationForSnapshot(input)
			: review.createAuthControllerAttestation(input)
		).catch((error: unknown) => ({ thrown: String(error) }));
		hook.restore();
		// The stage the change landed before: 1 when that statement ran, else 0.
		return { result, reached: hook.reached(), rows: databaseSnapshot(f) };
	} finally {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
}

function cases(): [string, Case][] {
	const ordinary = { ...ORDINARY_CHANGES, none: () => {} };
	const all: [string, Case][] = [];
	for (const [name, change] of Object.entries(ordinary)) {
		all.push([`create: ${name}`, { op: "create", stage: "create", seed: ordinarySeed, change }]);
		for (const stage of ["eligible", "final"] as const)
			all.push([`retry ${stage}: ${name}`, { op: "retry", stage, seed: ordinarySeed, change }]);
	}
	for (const [name, change] of Object.entries(RETRY_CHANGES))
		for (const stage of ["eligible", "final"] as const)
			all.push([`retry ${stage}: ${name}`, { op: "retry", stage, seed: ordinarySeed, change }]);
	for (const [name, change] of Object.entries({ ...OWNER_CHANGES, none: () => {} })) {
		all.push([`owner create: ${name}`, { op: "create", stage: "create", seed: ownerSeed, change }]);
		// The review's own attestation holds its enrollment's one row; revoke that instead.
		if (name.startsWith("same enrollment")) continue;
		all.push([
			`owner snapshot read: ${name}`,
			{ op: "snapshot", stage: "final", seed: ownerSeed, change },
		]);
	}
	all.push([
		"owner snapshot read: own attestation revoked",
		{
			op: "snapshot",
			stage: "final",
			seed: ownerSeed,
			change: (f) =>
				set(f, "UPDATE coordinator_auth_controller_attestations SET revoked_at=?", REVOKED),
		},
	]);
	return all;
}

for (const backend of ["SQLite", "D1"] as const)
	for (const variant of ["ready", "missing"] as const)
		describe(`${backend}, ${variant} resolution schema: controller review equivalence`, () => {
			it.each(cases())("%s", async (_name, kase) => {
				// Arrange, Act: the same review and change on two identical fixtures.
				const ported = await run(backend, variant, kase, "ported");
				const original = await run(backend, variant, kase, "original");
				// Assert: the change landed before that stage's statement in both, and both gave
				// the same answer and left the same rows.
				expect([ported.reached, original.reached]).toEqual([1, 1]);
				if (variant === "ready" && kase.op === "create" && kase.change === resolutionSchema) {
					// The one known difference: the old insert named the dropped table and failed
					// with an error. The read set's catalog guard sees the drop and writes nothing;
					// the retry then recaptures the now-missing schema and finds no attestation.
					expect(original.result).toEqual({
						thrown: expect.stringContaining("no such table: coordinator_legacy_owner_resolutions"),
					});
					expect(ported.result).toEqual({ kind: "rejected", error: "attestation_conflict" });
					expect(ported.rows).toEqual(original.rows);
					return;
				}
				expect(ported).toEqual(original);
			});
		});
