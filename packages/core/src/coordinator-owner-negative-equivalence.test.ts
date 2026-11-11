// Runs the pre-port negative owner statement beside the read set on the same database.
// Each case changes one fact before the reads, which both must answer alike, or after
// them, where the old pin and the new guards must hold or fail alike.
import { afterEach, describe, expect, it } from "vitest";
import { applyAccountConnectionSchema } from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { writeGuarded } from "./coordinator-auth-read-set.js";
import {
	assignLegacyCompletion,
	retainOwnReviewOwnership,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";
import { prepareOriginalNegativeOwnerConsistency } from "./coordinator-owner-negative-original-sql-test-fixtures.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";
import { readNegativeOwnerConsistency } from "./coordinator-owner-negative-read-set.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
type Change = (f: Fixture, s: RaceSubject) => unknown;
interface Case {
	name: string;
	/** Stores a retained resolution whose source is the device's own review first. */
	retained?: true;
	/** Before the reads. */
	arrange?: Change;
	/** After the reads, before the pinned write. */
	change?: Change;
	/** The owner the producer asks for; the device's Identity by default. */
	owner?: string;
	/** Stores retained ownership without the `retained` default, so the evidence is read. */
	evidence?: true;
	/** The producer names no enrollment. */
	noEnrollment?: true;
	/** The expected answer on a backend that can read rows. */
	allowed: boolean;
	/** Whether the old pin still matches after `change`; true by default. */
	holds?: boolean;
}

const AT = "2026-10-20T00:00:00.000Z";
const run = (f: Fixture, text: string, ...values: unknown[]) => f.db.prepare(text).run(...values);
function insert(f: Fixture, table: string, row: Record<string, unknown>) {
	const keys = Object.keys(row);
	run(
		f,
		`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
		...Object.values(row),
	);
}
const keyIdOf = async (s: RaceSubject) => (await ed25519KeyIdForRevocation(s.publicKey)) as string;
const updateReview = (column: string, value: unknown) => (f: Fixture) =>
	run(
		f,
		`UPDATE coordinator_auth_controller_attestations SET ${column}=? WHERE device_id='device-a'`,
		value,
	);
const updateEnrollment = (column: string, value: unknown) => (f: Fixture) =>
	run(
		f,
		`UPDATE enrolled_devices SET ${column}=? WHERE group_id='group-a' AND device_id='device-a'`,
		value,
	);
const binding = (identityId: string) => async (f: Fixture, s: RaceSubject) =>
	insert(f, "coordinator_device_ownership_bindings", {
		device_id: s.deviceId,
		key_id: await keyIdOf(s),
		identity_id: identityId,
		coordinator_id: s.coordinatorId,
		binding_id: "binding",
		provenance: "owner_enrollment",
		source_ref: "source",
		bound_at: AT,
	});
const claim = (identityId: string) => async (f: Fixture, s: RaceSubject) =>
	insert(f, "coordinator_auth_device_claims", {
		claim_id: "claim",
		coordinator_id: s.coordinatorId,
		identity_id: identityId,
		group_id: s.groupId,
		device_id: s.deviceId,
		public_key: s.publicKey,
		fingerprint: s.fingerprint,
		key_id: await keyIdOf(s),
		attempt_id: "attempt",
		issuer: "https://issuer.example.test",
		auth_config_revision: "d".repeat(64),
		created_at_ms: 1,
	});
const revocation = (kind: "device_id" | "ed25519_key") => async (f: Fixture, s: RaceSubject) =>
	insert(f, "coordinator_device_revocations", {
		subject_kind: kind,
		subject_value: kind === "device_id" ? s.deviceId : await keyIdOf(s),
		revocation_id: "revocation",
		evidence_group_id: s.groupId,
		evidence_device_id: s.deviceId,
		evidence_public_key: s.publicKey,
		evidence_fingerprint: s.fingerprint,
		created_at: AT,
	});
const invite = (row: Record<string, unknown>) => (f: Fixture, s: RaceSubject) =>
	insert(f, "coordinator_invites", {
		invite_id: "invite",
		group_id: s.groupId,
		token: "invite-token",
		policy: "auto_admit",
		created_at: "2026-10-01T00:00:00.000Z",
		expires_at: "2026-12-01T00:00:00.000Z",
		consumed_at: "2026-10-02T00:00:00.000Z",
		bound_device_id: s.deviceId,
		bound_public_key: s.publicKey,
		bound_fingerprint: s.fingerprint,
		invite_kind: "team_member",
		assigned_identity_id: s.ownerIdentityId,
		recipient_actor_id: s.ownerIdentityId,
		reviewed_preview_digest: "a".repeat(64),
		...row,
	});
const resolution = (row: Record<string, unknown>) => async (f: Fixture, s: RaceSubject) => {
	f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	run(
		f,
		`INSERT INTO coordinator_legacy_owner_resolutions SELECT ?,?,1,?,?,identity_id,'existing_account_owner','historical_included_owner_labels_only',
 attestation_id,group_id,revision,public_key,fingerprint,enrollment_identity_id,created_at,review_receipt_id,evidence_digest,?,'[]',?
 FROM coordinator_auth_controller_attestations WHERE device_id='device-a'`,
		row.coordinator_id ?? s.coordinatorId,
		row.resolution_id ?? "resolution",
		row.device_id ?? s.deviceId,
		row.key_id ?? (await keyIdOf(s)),
		"d".repeat(64),
		AT,
	);
};
/** A canonical legacy completion that includes the device under `identityId`. */
const legacyInclusion = (identityId: string) => (f: Fixture, s: RaceSubject) => {
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
		version: 1,
		coordinator_id: s.coordinatorId,
		candidate_ref: legacyTeamCandidateId(s.coordinatorId, "group-c"),
		candidate_digest: "a".repeat(64),
		team_id: "team-c",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: identityId, role: "member" }],
		device_decisions: [
			{
				device_id: s.deviceId,
				key_fingerprint: s.fingerprint,
				enabled: true,
				identity_id: identityId,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	insert(f, "coordinator_legacy_team_completions", {
		group_id: "group-c",
		candidate_ref: manifest.candidate_ref,
		manifest_version: 1,
		manifest_json: canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
		completed_at: manifest.completed_at,
		created_at: manifest.completed_at,
	});
};
const enrollOther = (publicKey: string) => (f: Fixture) =>
	insert(f, "enrolled_devices", {
		group_id: "group-c",
		device_id: "other-device",
		public_key: publicKey,
		fingerprint: "9".repeat(64),
		enabled: 1,
		created_at: "created",
	});
const PARSEABLE_OTHER_KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM";

const DECISION_CASES: Case[] = [
	{
		name: "no resolution table",
		arrange: (f) => f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions"),
		allowed: true,
	},
	{
		name: "an empty resolution table",
		arrange: (f) => f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
		allowed: true,
	},
	{
		name: "an unrecognized resolution table",
		arrange: (f) =>
			f.db.exec(
				"DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions; CREATE TABLE coordinator_legacy_owner_resolutions (device_id TEXT)",
			),
		allowed: false,
	},
	{
		name: "a resolution for another coordinator",
		arrange: resolution({ coordinator_id: "elsewhere" }),
		allowed: true,
	},
	{ name: "retained ownership by the device's own review", retained: true, allowed: true },
	{
		name: "retained ownership asked for by another owner",
		retained: true,
		owner: "another-identity",
		allowed: false,
	},
	{
		name: "retained ownership of the key under an old device ID",
		arrange: resolution({ device_id: "old-device" }),
		evidence: true,
		allowed: false,
	},
	{
		name: "a producer that names no enrollment",
		retained: true,
		noEnrollment: true,
		allowed: true,
	},
	{
		name: "the original source revoked (NULL to a time)",
		retained: true,
		arrange: updateReview("revoked_at", AT),
		allowed: false,
	},
	{
		name: "the original source naming an enrollment Identity (NULL to a value)",
		retained: true,
		arrange: updateReview("enrollment_identity_id", "enrollment-identity"),
		allowed: false,
	},
	{
		name: "the original source with another review receipt",
		retained: true,
		arrange: updateReview("review_receipt_id", "another-review"),
		allowed: false,
	},
	{
		name: "a revocation of the device",
		retained: true,
		arrange: revocation("device_id"),
		allowed: false,
	},
	{
		name: "a revocation of the key",
		retained: true,
		arrange: revocation("ed25519_key"),
		allowed: false,
	},
	{
		name: "a binding to another Identity",
		retained: true,
		arrange: binding("another-identity"),
		allowed: false,
	},
	{
		name: "a binding to the owner",
		retained: true,
		arrange: (f, s) => binding(s.ownerIdentityId)(f, s),
		allowed: true,
	},
	{
		name: "a claim by another Identity",
		retained: true,
		arrange: claim("another-identity"),
		allowed: false,
	},
	{
		name: "another review of the device for another Identity",
		retained: true,
		arrange: (f) =>
			run(
				f,
				`INSERT INTO coordinator_auth_controller_attestations (attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at)
 SELECT 'second',coordinator_id,'another-identity','group-b',device_id,public_key,fingerprint,'second-review',evidence_digest,enrollment_identity_id,revision,created_at,revoked_at
 FROM coordinator_auth_controller_attestations WHERE device_id='device-a'`,
			),
		allowed: false,
	},
	{
		name: "a consumed Team invite assigning another Identity",
		retained: true,
		arrange: invite({
			assigned_identity_id: "another-identity",
			recipient_actor_id: "another-identity",
		}),
		allowed: false,
	},
	{
		name: "a consumed Team invite assigning the owner",
		retained: true,
		arrange: invite({}),
		allowed: true,
	},
	{
		name: "a consumed add-device invite with no assigned Identity (NULL)",
		retained: true,
		arrange: invite({
			invite_kind: "add_device",
			assigned_identity_id: null,
			target_identity_id: "another-identity",
			recipient_actor_id: "another-identity",
		}),
		allowed: false,
	},
	{
		name: "a consumed project share naming another actor",
		retained: true,
		arrange: invite({
			invite_kind: "project_share",
			assigned_identity_id: null,
			recipient_actor_id: "another-actor",
		}),
		allowed: true,
	},
	{
		name: "an unconsumed invite assigning another Identity (NULL consumed_at)",
		retained: true,
		arrange: invite({ consumed_at: null, assigned_identity_id: "another-identity" }),
		allowed: true,
	},
	{
		name: "a consumed invite whose key cannot be parsed",
		retained: true,
		arrange: invite({ bound_device_id: "other-device", bound_public_key: "unparsed key" }),
		allowed: false,
	},
	{
		name: "the signed group archived (NULL to a time)",
		retained: true,
		arrange: (f) => run(f, "UPDATE groups SET archived_at=? WHERE group_id='group-a'", AT),
		allowed: false,
	},
	{
		name: "the signed enrollment disabled",
		retained: true,
		arrange: updateEnrollment("enabled", 0),
		allowed: false,
	},
	{
		name: "the signed enrollment labeled with another Identity (NULL to a value)",
		retained: true,
		arrange: updateEnrollment("identity_id", "another-identity"),
		allowed: false,
	},
	{
		name: "the signed enrollment labeled with the owner",
		retained: true,
		arrange: (f, s) => updateEnrollment("identity_id", s.ownerIdentityId)(f),
		allowed: true,
	},
	{
		name: "an unparseable legacy completion naming the device",
		retained: true,
		arrange: (f, s) =>
			insert(f, "coordinator_legacy_team_completions", {
				group_id: "group-c",
				candidate_ref: "unparseable",
				manifest_version: 1,
				manifest_json: `not json ${JSON.stringify(s.deviceId)}`,
				completed_at: AT,
				created_at: AT,
			}),
		allowed: false,
	},
	{
		name: "a legacy assignment of the device to the owner",
		retained: true,
		arrange: (f) => assignLegacyCompletion(f),
		allowed: true,
	},
	{
		name: "a legacy inclusion under another Identity",
		retained: true,
		arrange: legacyInclusion("another-identity"),
		allowed: true,
	},
	{
		name: "another device with a parseable key",
		retained: true,
		arrange: enrollOther(PARSEABLE_OTHER_KEY),
		allowed: true,
	},
	{
		name: "another device with an unparseable key",
		retained: true,
		arrange: enrollOther("unparsed key"),
		allowed: true,
	},
];

const GUARD_CASES: Case[] = [
	...NEGATIVE_OWNER_CHANGES.map(
		(race): Case => ({
			name: `${race.fact} after the reads`,
			retained: true,
			...(race.arrange ? { arrange: (f: Fixture, s: RaceSubject) => race.arrange?.(f.db, s) } : {}),
			change: (f, s) => race.change(f.db, s),
			allowed: true,
			holds: false,
		}),
	),
	{
		name: "nothing changing after the reads",
		retained: true,
		change: () => undefined,
		allowed: true,
	},
	{
		name: "another device with a parseable key after the reads",
		retained: true,
		change: enrollOther(PARSEABLE_OTHER_KEY),
		allowed: true,
	},
	{
		name: "the resolution table created after the reads",
		arrange: (f) => f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions"),
		change: (f) => f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
		allowed: true,
		holds: false,
	},
	{
		name: "a resolution stored after the reads",
		arrange: (f) => f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
		change: resolution({}),
		allowed: true,
		holds: false,
	},
	{
		name: "a resolution for another coordinator stored after the reads",
		arrange: (f) => f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
		change: resolution({ coordinator_id: "elsewhere" }),
		allowed: true,
	},
];

async function pinHolds(backend: AuthLinkBackend, pin: AuthLinkStatement): Promise<boolean> {
	return (await backend.first<{ matches: number }>(pin))?.matches === 1;
}
async function guardsHold(backend: AuthLinkBackend, guards: AuthLinkStatement[]) {
	return (await writeGuarded(backend, guards, [])) === "committed";
}

const VARIANTS = (["SQLite", "D1"] as const).flatMap((kind) =>
	[false, true].map((connections) => ({ kind, connections })),
);

describe.each(VARIANTS)("$kind backend, connection schema $connections", (variant) => {
	it.each([...DECISION_CASES, ...GUARD_CASES])("answers like the original for $name", async (c) => {
		// Arrange
		const f = await selfBindFixture(variant.kind, "peer");
		close.push(f.close);
		if (variant.connections) await applyAccountConnectionSchema(f.backend);
		const s: RaceSubject = {
			coordinatorId: f.config.coordinatorId,
			...f.signer,
			ownerIdentityId: c.owner ?? f.identityId,
		};
		if (c.retained) await retainOwnReviewOwnership(f);
		await c.arrange?.(f, s);
		const subject = {
			coordinatorId: s.coordinatorId,
			deviceId: s.deviceId,
			publicKey: s.publicKey,
			fingerprint: s.fingerprint,
			ownerIdentityId: s.ownerIdentityId,
			...(c.noEnrollment ? {} : { enrollment: { groupId: s.groupId } }),
		};
		// Act
		const original = await prepareOriginalNegativeOwnerConsistency(f.backend, subject);
		const ported = await readNegativeOwnerConsistency(f.backend, subject);
		await c.change?.(f, s);
		const pins = original && {
			full: await pinHolds(f.backend, original),
			retained: await pinHolds(f.backend, original.retainedRecheck),
		};
		const guards = ported && {
			full: await guardsHold(f.backend, ported.guards),
			retained: await guardsHold(f.backend, ported.retainedGuards),
		};
		// Assert: the SQLite fixture's backend cannot read rows, so evidence always refuses.
		const readsEvidence = c.retained || c.evidence;
		const allowed = c.allowed && !(readsEvidence && variant.kind === "SQLite");
		expect(original !== null).toBe(allowed);
		expect(ported !== null).toBe(allowed);
		expect(guards).toEqual(pins);
		if (pins) expect(pins.full).toBe(c.holds ?? true);
	});
});
