import { parseSshEd25519PublicKeyForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { coordinatorEnrollmentBindingSource } from "./coordinator-enrollment-reconciler.js";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import type { Database } from "./db.js";
import type { LegacyTeamRosterDeviceSnapshot } from "./legacy-team-candidate.js";
import { derivePolicyTeamDeviceEligibility } from "./policy-team-device-eligibility.js";
import { compareCodepoints } from "./recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	type TeamRecoveryExclusion,
	teamRecoveryExcludedDeviceIds,
	withTeamRecoveryExclusionsFor,
} from "./team-recovery-exclusions.js";

/*
 * The device half of the Team recovery preview: which devices would receive
 * the Team's Projects again, which stay out, and which make recovery stop.
 *
 * Every device the completed setup included, and every other device this
 * machine holds an `included` decision for (one added through an invitation),
 * is checked against the setup group's roster as the coordinator reports it now.
 * The check needs a key this machine already trusted for the device: the key
 * the setup reviewed, or for a device added later, the key this machine pinned,
 * or failing a pin, the key its coordinator enrollment binding was recorded
 * for. Without one, recovery stops, because nothing ties the roster's key to
 * the device.
 * - enrolled, enabled, holding that key, and reported not blocked and with no
 *   removal by a block check made for that device and key: it keeps its decision;
 * - not enrolled, with a removal record for that device and key in this group:
 *   recovery leaves it out;
 * - anything else stops recovery. A changed key is not a removal.
 *
 * The roster and the removal records cannot show every block: the coordinator
 * can block a device that stays enrolled, which writes no removal record. So an
 * enrolled device needs its own block check, and a missing answer stops recovery.
 * The coordinator blocks by device ID and by key, and it checks the key only
 * when it can derive a key ID from the key it was sent. An unblocked answer
 * therefore counts only when it carries the exact key that was sent, that key
 * hashes to the trusted fingerprint, and a key ID can be derived from it. A
 * blocked answer always counts, for the device or for its key under any device,
 * because a block applies across the whole coordinator.
 *
 * Recovery leaves a device out by recording a recovery exclusion for it, apart
 * from its device decision. Every reader of device decisions applies the
 * exclusion on top, so nothing that later rewrites or deletes the decision
 * brings the device back. A device with an exclusion stays out for good,
 * whatever the roster says later.
 */

/** A coordinator device removal record. `revoked` marks a device blocked everywhere. */
export interface TeamRecoveryDeviceRemoval {
	group_id: string;
	device_id: string;
	fingerprint: string;
	revoked?: true;
}

/**
 * The coordinator's answer to whether it blocks one device under one key. The
 * reader fills `deviceId` and `publicKey` from the request it sent, never from
 * the reply: `publicKey` is the exact key string the question was asked with.
 * An answer without it says nothing about the key.
 *
 * `removal` is what the same answer says about a removal. The check is asked
 * after the roster is read, so a device removed in between is listed as
 * enrolled by the roster and as removed here.
 * - `of_this_key`: the coordinator reports the exact key sent removed under
 *   this device. With the device on the roster, the two reads contradict.
 * - `unattributed`: it reports a removal by device ID or by key and does not
 *   say that the key sent was removed or is still enrolled. That clears
 *   nothing and refuses nothing for good: the check can be asked again.
 * - `none`: it reports no removal, or reports the key sent still enrolled. A
 *   device removed long ago under another key and enrolled again reads so.
 * Only `none` clears the device.
 */
export interface TeamRecoveryDeviceBlockCheck {
	deviceId: string;
	publicKey: string;
	blocked: boolean;
	removal: "none" | "of_this_key" | "unattributed";
}

export type TeamRecoveryDeviceRefusal =
	| "device_blocked"
	| "device_evidence_contradictory"
	| "device_key_unverified"
	| "device_key_changed"
	| "device_disabled"
	| "device_block_unchecked"
	| "device_missing_without_removal"
	| "device_decision_changed";

// The order refusals are reported in when several apply.
const REFUSAL_ORDER: readonly TeamRecoveryDeviceRefusal[] = [
	"device_blocked",
	"device_evidence_contradictory",
	"device_key_unverified",
	"device_key_changed",
	"device_disabled",
	"device_block_unchecked",
	"device_missing_without_removal",
	"device_decision_changed",
];

export type TeamRecoveryDeviceReason =
	| "removed_from_group"
	| "blocked_by_coordinator"
	| "left_out_by_recovery"
	| "excluded_in_review"
	| "not_included"
	| "person_left_out"
	| "not_eligible";

export interface TeamRecoveryDevice {
	deviceId: string;
	displayName: string | null;
	identityId: string | null;
	/** `regains_access`: receives the Team's Projects once the Team is recovered. */
	outcome: "regains_access" | "stays_out";
	reason?: TeamRecoveryDeviceReason;
}

export interface TeamRecoveryDevicesInput {
	teamId: string;
	groupId: string;
	manifest: CoordinatorLegacyTeamCompletionManifestV1;
	roster: ReadonlyMap<string, LegacyTeamRosterDeviceSnapshot>;
	deviceRemovals: readonly TeamRecoveryDeviceRemoval[];
	/** Block checks made for enrolled devices, each for one device and key. */
	deviceBlocks: readonly TeamRecoveryDeviceBlockCheck[];
	/** The Team's memberships as recovery would leave them. */
	memberships: ReadonlyArray<{ identityId: string; status: string }>;
}

export type TeamRecoveryDevicesResult =
	| {
			state: "planned";
			devices: TeamRecoveryDevice[];
			/** Devices this recovery leaves out, each with the key it was removed or blocked under. */
			exclusions: TeamRecoveryExclusion[];
			/** Devices that keep their decision, each with the enrolled key the checks were made for. */
			survivingKeys: Array<{ deviceId: string; fingerprint: string }>;
	  }
	| { state: "refused"; reason: TeamRecoveryDeviceRefusal; deviceIds: string[] }
	/** The Team's policy rows would block the whole Team once it is active. */
	| { state: "blocked" };

type ManifestDecision = CoordinatorLegacyTeamCompletionManifestV1["device_decisions"][number];

interface LocalDecision {
	device_id: string;
	decision: string;
	assignment_version: number;
}

interface DeviceFact {
	deviceId: string;
	manifest?: ManifestDecision;
	/** The device's decision as policy reads it, with recovery exclusions applied. */
	local?: LocalDecision;
	leftOutEarlier: boolean;
}

type Verdict =
	| { refusal: TeamRecoveryDeviceRefusal }
	| { leftOut: "removed_from_group" | "blocked_by_coordinator"; fingerprint: string }
	| { standing: "enrolled" | "left_out_earlier" | "excluded_in_review" | "not_included" };

/** A key this machine trusted for a device before it read the roster. */
interface PriorKey {
	/** Whether this machine holds any key evidence for the device. */
	known: boolean;
	/** Whether that evidence vouches for the key. */
	matches(fingerprint: string): boolean;
	/** Whether this machine knows the device under another key. */
	contradicts(fingerprint: string): boolean;
}

// Every coordinator group this machine has a scope, a setup or a Team link for.
const KNOWN_GROUPS_SQL = `SELECT group_id FROM replication_scopes WHERE group_id IS NOT NULL
	UNION SELECT group_id FROM legacy_team_setup_drafts
	UNION SELECT group_id FROM policy_team_coordinator_links WHERE group_id <> ''`;

/**
 * Whether the device's coordinator enrollment binding was recorded for the
 * key. A device has one binding however many groups enroll it, and the binding
 * keeps the digest of the group that created it, so every group this machine
 * knows is tried. A binding from a group it does not know vouches for no key.
 */
function bindingVouchesFor(
	db: Database,
	input: TeamRecoveryDevicesInput,
	deviceId: string,
): (fingerprint: string) => boolean {
	const binding = db
		.prepare(
			`SELECT identity_id, source_fingerprint FROM identity_devices
			 WHERE device_id = ? AND provenance = 'coordinator_enrollment'`,
		)
		.get(deviceId) as { identity_id: string; source_fingerprint: string | null } | undefined;
	if (!binding?.source_fingerprint) return () => false;
	const groupIds = new Set([
		input.groupId,
		...(db.prepare(KNOWN_GROUPS_SQL).pluck().all() as string[]),
	]);
	const identityId = binding.identity_id;
	return (fingerprint) =>
		[...groupIds].some(
			(groupId) =>
				binding.source_fingerprint ===
				coordinatorEnrollmentBindingSource({ groupId, identityId, deviceId, fingerprint }),
		);
}

/**
 * The key evidence this machine holds for a device added after the setup: the
 * key it pinned when it paired with the device, and the key its coordinator
 * enrollment binding was recorded for. Either one vouches for a key. A pin for
 * another key rules a key out, because this machine saw the device use it.
 */
function localPriorKey(db: Database, input: TeamRecoveryDevicesInput, deviceId: string): PriorKey {
	const pin = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(deviceId) as { public_key: string | null; pinned_fingerprint: string | null } | undefined;
	// A pin counts only while it still matches the key stored beside it.
	const pinned =
		pin?.public_key && fingerprintPublicKey(pin.public_key) === pin.pinned_fingerprint
			? pin.pinned_fingerprint
			: null;
	const bound = bindingVouchesFor(db, input, deviceId);
	const hasBinding =
		db
			.prepare(
				`SELECT 1 FROM identity_devices WHERE device_id = ?
				 AND provenance = 'coordinator_enrollment' AND source_fingerprint IS NOT NULL`,
			)
			.get(deviceId) !== undefined;
	return {
		known: pinned !== null || hasBinding,
		matches: (fingerprint) => (pinned === null ? bound(fingerprint) : pinned === fingerprint),
		contradicts: (fingerprint) => pinned !== null && pinned !== fingerprint,
	};
}

/** The fingerprint of the key a block check was asked with, or null when it carries no key. */
function checkedKeyFingerprint(check: TeamRecoveryDeviceBlockCheck): string | null {
	return typeof check.publicKey === "string" && check.publicKey.length > 0
		? fingerprintPublicKey(check.publicKey)
		: null;
}

/**
 * Whether an unblocked answer covers the key: it was asked with a key that
 * hashes to this fingerprint, and the coordinator can derive a key ID from that
 * key. Otherwise the coordinator looked at the device ID alone.
 */
function provesKeyChecked(check: TeamRecoveryDeviceBlockCheck, fingerprint: string): boolean {
	return (
		checkedKeyFingerprint(check) === fingerprint &&
		parseSshEd25519PublicKeyForRevocation(check.publicKey).kind === "ed25519"
	);
}

/**
 * Whether anything read from the coordinator says it blocks the device or its
 * key: a block check, or a removal record marked blocked. A block applies across
 * the coordinator, so the group it was recorded in and the device ID the key
 * was blocked under do not matter.
 */
function isReportedBlocked(
	input: TeamRecoveryDevicesInput,
	deviceId: string,
	fingerprint: string,
): boolean {
	const byRecord = input.deviceRemovals.some(
		(removal) =>
			removal.revoked === true &&
			(removal.device_id === deviceId || removal.fingerprint === fingerprint),
	);
	const byCheck = input.deviceBlocks.some(
		(check) =>
			check.blocked !== false &&
			(check.deviceId === deviceId || checkedKeyFingerprint(check) === fingerprint),
	);
	return byRecord || byCheck;
}

/** An enrolled device keeps its decision only with the trusted key, enabled and checked for a block. */
function enrolledVerdict(
	input: TeamRecoveryDevicesInput,
	enrolled: LegacyTeamRosterDeviceSnapshot,
	prior: PriorKey,
): Verdict {
	const { deviceId, fingerprint } = enrolled;
	if (isReportedBlocked(input, deviceId, fingerprint)) return { refusal: "device_blocked" };
	// Enrolled in the group and removed from it under the same key: one of the two reads is wrong.
	const removedHere = input.deviceRemovals.some(
		(record) =>
			record.group_id === input.groupId &&
			record.device_id === deviceId &&
			record.fingerprint === fingerprint,
	);
	// The block check is asked after the roster, and reports a removal made in between.
	const removedSince = input.deviceBlocks.some(
		(check) => check.deviceId === deviceId && check.removal === "of_this_key",
	);
	if (removedHere || removedSince) return { refusal: "device_evidence_contradictory" };
	if (prior.contradicts(fingerprint)) return { refusal: "device_key_changed" };
	if (!prior.matches(fingerprint)) return { refusal: "device_key_unverified" };
	if (!enrolled.enabled) return { refusal: "device_disabled" };
	// Blocking an enrolled device leaves its enrollment and writes no removal record.
	const cleared = input.deviceBlocks.some(
		(check) =>
			check.deviceId === deviceId &&
			check.blocked === false &&
			check.removal === "none" &&
			provesKeyChecked(check, fingerprint),
	);
	return cleared ? { standing: "enrolled" } : { refusal: "device_block_unchecked" };
}

/** The roster rule for a device with an `included` decision. */
function rosterVerdict(
	input: TeamRecoveryDevicesInput,
	deviceId: string,
	prior: PriorKey,
): Verdict {
	const enrolled = input.roster.get(deviceId);
	if (enrolled) return enrolledVerdict(input, enrolled, prior);
	if (!prior.known) return { refusal: "device_key_unverified" };
	const removal = input.deviceRemovals.find(
		(record) =>
			record.group_id === input.groupId &&
			record.device_id === deviceId &&
			prior.matches(record.fingerprint),
	);
	if (!removal) return { refusal: "device_missing_without_removal" };
	return {
		leftOut: removal.revoked === true ? "blocked_by_coordinator" : "removed_from_group",
		fingerprint: removal.fingerprint,
	};
}

function deviceVerdict(db: Database, input: TeamRecoveryDevicesInput, fact: DeviceFact): Verdict {
	const { manifest, local } = fact;
	// An earlier recovery left it out, and that holds whatever the roster says now.
	if (fact.leftOutEarlier) return { standing: "left_out_earlier" };
	if (manifest?.decision === "included") {
		if (!manifest.enabled) return { refusal: "device_disabled" };
		const reviewed = manifest.key_fingerprint;
		return rosterVerdict(input, fact.deviceId, {
			known: true,
			matches: (fingerprint) => fingerprint === reviewed,
			contradicts: (fingerprint) => fingerprint !== reviewed,
		});
	}
	if (manifest) {
		// The review excluded it. An `included` decision now is not that review's.
		return local?.decision === "included"
			? { refusal: "device_decision_changed" }
			: { standing: "excluded_in_review" };
	}
	if (local?.decision !== "included") return { standing: "not_included" };
	// Added after the setup, so no review names its key.
	return rosterVerdict(input, fact.deviceId, localPriorKey(db, input, fact.deviceId));
}

/** Every device the setup reviewed and every device with a decision for the Team. */
function deviceFacts(db: Database, input: TeamRecoveryDevicesInput): DeviceFact[] {
	const local = withTeamRecoveryExclusionsFor(
		db,
		input.teamId,
		db
			.prepare(
				`SELECT device_id, decision, assignment_version
				 FROM policy_team_device_decisions WHERE team_id = ?`,
			)
			.all(input.teamId) as LocalDecision[],
	);
	const localById = new Map(local.map((row) => [row.device_id, row]));
	const leftOut = teamRecoveryExcludedDeviceIds(db, input.teamId);
	const manifestById = new Map(
		input.manifest.device_decisions.map((decision) => [decision.device_id, decision]),
	);
	return [...new Set([...manifestById.keys(), ...localById.keys(), ...leftOut])]
		.toSorted(compareCodepoints)
		.map((deviceId) => ({
			deviceId,
			manifest: manifestById.get(deviceId),
			local: localById.get(deviceId),
			leftOutEarlier: leftOut.has(deviceId),
		}));
}

/** The devices the Team's policy rows would make eligible once recovery has run. */
function eligibleAfterRecovery(
	db: Database,
	input: TeamRecoveryDevicesInput,
	facts: readonly DeviceFact[],
	leftOut: ReadonlySet<string>,
): Set<string> | null {
	const members = "SELECT identity_id FROM policy_team_memberships WHERE team_id = ?";
	const identities = db
		.prepare(
			`SELECT actor_id AS identityId, status, merged_into_actor_id AS mergedIntoIdentityId
			 FROM actors WHERE actor_id IN (${members})`,
		)
		.all(input.teamId) as Array<{
		identityId: string;
		status: string;
		mergedIntoIdentityId: string | null;
	}>;
	const devices = db
		.prepare(
			`SELECT identity_id AS identityId, device_id AS deviceId, status,
			        assignment_version AS assignmentVersion
			 FROM identity_devices WHERE identity_id IN (${members})`,
		)
		.all(input.teamId) as Array<{
		identityId: string;
		deviceId: string;
		status: string;
		assignmentVersion: number;
	}>;
	const eligibility = derivePolicyTeamDeviceEligibility({
		teamId: input.teamId,
		mode: "reviewed_allowlist",
		memberships: [...input.memberships],
		identities,
		devices,
		decisions: facts.flatMap(({ deviceId, local }) =>
			local
				? [
						{
							deviceId,
							decision: leftOut.has(deviceId) ? "excluded" : local.decision,
							assignmentVersion: local.assignment_version,
						},
					]
				: [],
		),
	});
	return eligibility.status === "eligible" ? new Set(eligibility.eligibleDeviceIds) : null;
}

function stayOutReason(
	fact: DeviceFact,
	verdict: Verdict,
	identityId: string | null,
	activeMembers: ReadonlySet<string>,
): TeamRecoveryDeviceReason {
	if ("leftOut" in verdict) return verdict.leftOut;
	if ("standing" in verdict && verdict.standing === "left_out_earlier")
		return "left_out_by_recovery";
	if ("standing" in verdict && verdict.standing === "excluded_in_review")
		return "excluded_in_review";
	if (fact.local?.decision !== "included") return "not_included";
	if (identityId !== null && !activeMembers.has(identityId)) return "person_left_out";
	return "not_eligible";
}

function describeDevice(
	db: Database,
	input: TeamRecoveryDevicesInput,
	fact: DeviceFact,
): { displayName: string | null; identityId: string | null } {
	const binding = db
		.prepare("SELECT identity_id, display_name, status FROM identity_devices WHERE device_id = ?")
		.get(fact.deviceId) as
		| { identity_id: string; display_name: string; status: string }
		| undefined;
	return {
		displayName: binding?.display_name ?? input.roster.get(fact.deviceId)?.displayName ?? null,
		identityId:
			binding?.status === "active" ? binding.identity_id : (fact.manifest?.identity_id ?? null),
	};
}

function firstRefusal(
	verdicts: ReadonlyArray<{ fact: DeviceFact; verdict: Verdict }>,
): { reason: TeamRecoveryDeviceRefusal; deviceIds: string[] } | null {
	for (const reason of REFUSAL_ORDER) {
		const deviceIds = verdicts
			.filter(({ verdict }) => "refusal" in verdict && verdict.refusal === reason)
			.map(({ fact }) => fact.deviceId);
		if (deviceIds.length > 0) return { reason, deviceIds };
	}
	return null;
}

/** Plans every Team device's outcome. Reads only. */
export function planTeamRecoveryDevices(
	db: Database,
	input: TeamRecoveryDevicesInput,
): TeamRecoveryDevicesResult {
	const facts = deviceFacts(db, input);
	const verdicts = facts.map((fact) => ({ fact, verdict: deviceVerdict(db, input, fact) }));
	const refusal = firstRefusal(verdicts);
	if (refusal) return { state: "refused", ...refusal };
	const exclusions = verdicts.flatMap(({ fact, verdict }): TeamRecoveryExclusion[] =>
		"leftOut" in verdict
			? [{ deviceId: fact.deviceId, fingerprint: verdict.fingerprint, reason: verdict.leftOut }]
			: [],
	);
	const eligible = eligibleAfterRecovery(
		db,
		input,
		facts,
		new Set(exclusions.map((exclusion) => exclusion.deviceId)),
	);
	if (!eligible) return { state: "blocked" };
	const activeMembers = new Set(
		input.memberships
			.filter((membership) => membership.status === "reviewed_active")
			.map((membership) => membership.identityId),
	);
	const devices = verdicts.map(({ fact, verdict }): TeamRecoveryDevice => {
		const described = { deviceId: fact.deviceId, ...describeDevice(db, input, fact) };
		if (eligible.has(fact.deviceId)) return { ...described, outcome: "regains_access" };
		const reason = stayOutReason(fact, verdict, described.identityId, activeMembers);
		return { ...described, outcome: "stays_out", reason };
	});
	const survivingKeys = verdicts.flatMap(({ fact, verdict }) => {
		const enrolled = "standing" in verdict && verdict.standing === "enrolled";
		const fingerprint = input.roster.get(fact.deviceId)?.fingerprint;
		return enrolled && fingerprint ? [{ deviceId: fact.deviceId, fingerprint }] : [];
	});
	return { state: "planned", devices, exclusions, survivingKeys };
}
