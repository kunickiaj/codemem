// Each test changes a fact after the self-bind authority reads ran and before the batch
// that writes, the moment a pre-read alone would miss. The guards in that batch decide.
import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import type { DeviceRebindAttempt } from "./coordinator-device-rebind-proof.js";
import {
	assignLegacyCompletion,
	retainOwnReviewOwnership,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
const PHASES = ["start", "claim", "callback", "confirm", "commit"] as const;
type Phase = (typeof PHASES)[number];
const ADVANCED = /^(started|browser_claimed|verified|confirmed|finalized|prior_commit)$/;
const STATE_BEFORE = {
	start: undefined,
	claim: "pending",
	callback: "browser_claimed",
	confirm: "oidc_verified",
	commit: "confirmed",
} as const;
const COMPLETIONS = "coordinator_legacy_team_completions";
const attemptState = (f: Fixture) =>
	(
		f.db.prepare("SELECT state FROM coordinator_device_rebind_attempts").get() as
			| { state: string }
			| undefined
	)?.state;

interface Race {
	phase: Phase;
	/** Runs once, just before the first batch of the phase under test. */
	change(f: Fixture): void;
	arrange?(f: Fixture): void;
}

/** Runs the ceremony up to the phase, then applies the change just before that phase writes. */
async function race(kind: "SQLite" | "D1", { phase, change, arrange }: Race) {
	const f = await selfBindFixture(kind, "peer");
	close.push(f.close);
	arrange?.(f);
	let armed = false;
	const racing: AuthLinkBackend = {
		...f.backend,
		batch: async (statements) => {
			if (armed) change(f);
			armed = false;
			return f.backend.batch(statements);
		},
	};
	const ceremony = f.makeCeremony(racing);
	const s = f.steps(ceremony);
	const steps = [s.start, s.claim, s.verify, s.confirm];
	let last: Awaited<ReturnType<typeof s.confirm>> = null;
	for (const step of steps.slice(0, PHASES.indexOf(phase))) {
		last = await step();
		expect(last?.kind).toMatch(ADVANCED);
	}
	const finalize = () => {
		if (last?.kind !== "confirmed") throw new Error(JSON.stringify(last));
		const row = f.db
			.prepare("SELECT * FROM coordinator_device_rebind_attempts")
			.get() as DeviceRebindAttempt;
		return ceremony.finalize(f.finalizedInput(row, last.completionSecret));
	};
	armed = true;
	const result = await (steps[PHASES.indexOf(phase)] ?? finalize)();
	return { f, result, changeApplied: !armed };
}

const enrollUnrelatedDevice = (f: Fixture) =>
	f.db.exec(
		"INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,enabled,created_at) VALUES('group-b','unrelated-device','unrelated-key','unrelated-fingerprint',1,'created')",
	);
const insertInvite = (f: Fixture, consumedAt: string | null) =>
	f.db
		.prepare(
			"INSERT INTO coordinator_invites(invite_id,group_id,token,policy,expires_at,created_at,consumed_at,bound_device_id,assigned_identity_id) VALUES('raced-invite','group-a','fixture-token','open','2027-01-01','2026-01-01',?,?,'other-identity')",
		)
		.run(consumedAt, f.signer.deviceId);
const insertCompletion = (f: Fixture, candidate: string, decision: object) =>
	f.db
		.prepare(`INSERT INTO ${COMPLETIONS} VALUES('group-a',?,1,?,'2026-01-01','2026-01-01')`)
		.run(
			candidate,
			JSON.stringify({ coordinator_id: f.config.coordinatorId, device_decisions: [decision] }),
		);

describe.each(["SQLite", "D1"] as const)("%s self-bind read set", (kind) => {
	it.each(PHASES)(
		"writes nothing when a read fact changes just before the %s write",
		async (phase) => {
			// Arrange / Act
			const { f, result, changeApplied } = await race(kind, {
				phase,
				change: (f) =>
					f.db.exec(
						"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed' WHERE device_id='device-a'",
					),
			});
			// Assert
			expect(changeApplied).toBe(true);
			expect(result?.kind).not.toMatch(ADVANCED);
			expect(attemptState(f)).toBe(STATE_BEFORE[phase]);
			expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toEqual([]);
			expect(f.db.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all()).toEqual([]);
		},
	);

	const refused: [string, Omit<Race, "phase">][] = [
		["a key is stored that the decision never classified", { change: enrollUnrelatedDevice }],
		[
			"the legacy assignment the device relies on is edited",
			{
				arrange: assignLegacyCompletion,
				change: (f) =>
					f.db.exec(`UPDATE ${COMPLETIONS} SET completed_at='2027-01-01T00:00:00.000Z'`),
			},
		],
		[
			"the legacy assignment the device relies on is deleted",
			{ arrange: assignLegacyCompletion, change: (f) => f.db.exec(`DELETE FROM ${COMPLETIONS}`) },
		],
		[
			"a legacy completion that excludes the device is stored",
			{
				change: (f) =>
					insertCompletion(f, "excluding", {
						device_id: f.signer.deviceId,
						key_fingerprint: f.signer.fingerprint,
						identity_id: f.identityId,
						decision: "excluded",
					}),
			},
		],
		[
			"a consumed invite assigns the device to another Identity",
			{ change: (f) => insertInvite(f, "2026-01-02") },
		],
	];
	it.each(refused)("refuses the start when %s just before the write", async (_name, raced) => {
		// Arrange / Act
		const { f, result, changeApplied } = await race(kind, { phase: "start", ...raced });
		// Assert
		expect(changeApplied).toBe(true);
		expect(result).toEqual({ kind: "refused", reason: "unavailable" });
		expect(attemptState(f)).toBeUndefined();
	});

	const unaffected: [string, Omit<Race, "phase">][] = [
		["an unconsumed invite for the device is stored", { change: (f) => insertInvite(f, null) }],
		[
			"another group the device is enrolled in is archived",
			{
				change: (f) =>
					f.db.exec("UPDATE groups SET archived_at='archived' WHERE group_id='group-b'"),
			},
		],
		[
			"an unrelated stored key is removed",
			{
				arrange: enrollUnrelatedDevice,
				change: (f) => f.db.exec("DELETE FROM enrolled_devices WHERE device_id='unrelated-device'"),
			},
		],
		[
			"a legacy completion about another device is stored",
			{
				change: (f) =>
					insertCompletion(f, "unrelated", {
						device_id: "unrelated-device",
						key_fingerprint: "b".repeat(64),
						identity_id: "unrelated-identity",
						decision: "included",
					}),
			},
		],
	];
	it.each(unaffected)("still starts when %s just before the write", async (_name, raced) => {
		// Arrange / Act
		const { f, result, changeApplied } = await race(kind, { phase: "start", ...raced });
		// Assert
		expect(changeApplied).toBe(true);
		expect(result).toMatchObject({ kind: "started" });
		expect(attemptState(f)).toBe("pending");
	});
});

// Reading ownership evidence needs a backend that returns rows, as both stores do. The
// SQLite fixture's minimal backend cannot, so only the D1 fixture reaches this path.
// These tests run on SQLite. Production D1 refuses the evidence pin they read, which
// the D1 statement check counts for this read and its guard.
describe("self-bind read set with retained legacy ownership", () => {
	it("starts when the retained owner's source is the device's own review", async () => {
		// Arrange
		const f = await selfBindFixture("D1", "peer");
		close.push(f.close);
		await retainOwnReviewOwnership(f);
		// Act
		const result = await f.steps().start();
		// Assert
		expect(result).toMatchObject({ kind: "started" });
	});

	it("refuses the start when the retained ownership changes just before the write", async () => {
		// Arrange
		const f = await selfBindFixture("D1", "peer");
		close.push(f.close);
		await retainOwnReviewOwnership(f);
		let changed = false;
		const racing: AuthLinkBackend = {
			...f.backend,
			batch: async (statements) => {
				// Retained resolutions are append-only; a second one for the device is new evidence.
				if (!changed)
					f.db.exec(
						"INSERT INTO coordinator_legacy_owner_resolutions SELECT coordinator_id,'second-resolution',resolution_version,device_id,key_id,owner_identity_id,purpose,scope,source_attestation_id,source_group_id,source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at FROM coordinator_legacy_owner_resolutions",
					);
				changed = true;
				return f.backend.batch(statements);
			},
		};
		// Act
		const result = await f.steps(f.makeCeremony(racing)).start();
		// Assert
		expect(changed).toBe(true);
		expect(result).toEqual({ kind: "refused", reason: "unavailable" });
		expect(attemptState(f)).toBeUndefined();
	});
});
