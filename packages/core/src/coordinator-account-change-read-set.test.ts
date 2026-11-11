// Each test changes one guarded fact after an account-change step read and decided, just
// before the batch that writes, the moment a pre-read alone would miss. The guards at the
// start of that batch must abort the write.
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountChangeFixture,
	accountChangeFixture,
	assignLegacyTeam,
	type ChangeAuthority,
	config,
	hash,
	input,
	insertForeignLink,
	insertRevokedHistory,
	insertRow,
} from "../../cloudflare-coordinator-worker/test/account-change-read-set-fixture.js";
import {
	prepareAccountChangeAuthority,
	readAccountChangeBase,
} from "./coordinator-account-change-authority.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

const CHANGES = "coordinator_account_change_attempts";
const UNLINKS = "coordinator_auth_account_connection_unlinks";

interface Part {
	/** The read whose guard must detect the change. */
	part: string;
	authority?: ChangeAuthority;
	arrange?(f: AccountChangeFixture): void;
	change(f: AccountChangeFixture): void;
}

const PARTS: Part[] = [
	// The device-claim fixture already binds this key, so the binding cases start from a
	// controller-reviewed link without one.
	{
		part: "target",
		authority: "controller_attestation",
		change: (f) =>
			insertRow(f, "coordinator_device_ownership_bindings", {
				device_id: input.signer.deviceId,
				key_id: f.keyId,
				identity_id: input.identityId,
				coordinator_id: config.coordinatorId,
				binding_id: "raced-binding",
				provenance: "owner_enrollment",
				source_ref: "raced",
				bound_at: "bound",
			}),
	},
	{
		part: "keys",
		change: (f) =>
			insertRow(f, "enrolled_devices", {
				group_id: input.signer.groupId,
				device_id: "raced-device",
				public_key: "raced-key",
				fingerprint: "c".repeat(64),
				created_at: "created",
			}),
	},
	{
		part: "assignment",
		arrange: assignLegacyTeam,
		change: (f) =>
			f.exec("UPDATE coordinator_legacy_team_completions SET completed_at='2027-01-01T00:00:00Z'"),
	},
	{
		part: "enrollments",
		change: (f) =>
			f.exec(
				"UPDATE enrolled_devices SET identity_id = CASE WHEN identity_id IS NULL THEN ? ELSE NULL END WHERE device_id = ?",
				input.identityId,
				input.signer.deviceId,
			),
	},
	{
		part: "bindings",
		authority: "controller_attestation",
		change: (f) =>
			insertRow(f, "coordinator_device_ownership_bindings", {
				device_id: input.signer.deviceId,
				key_id: "e".repeat(64),
				identity_id: input.identityId,
				coordinator_id: "another-coordinator",
				binding_id: "raced-binding",
				provenance: "owner_enrollment",
				source_ref: "raced",
				bound_at: "bound",
			}),
	},
	{
		part: "attestations",
		change: (f) =>
			insertRow(f, "coordinator_auth_controller_attestations", {
				attestation_id: "raced-review",
				coordinator_id: config.coordinatorId,
				identity_id: input.identityId,
				group_id: "group-b",
				device_id: input.signer.deviceId,
				public_key: input.signer.publicKey,
				fingerprint: input.signer.fingerprint,
				review_receipt_id: "raced-receipt",
				evidence_digest: "d".repeat(64),
				created_at: "created",
			}),
	},
	{
		part: "claims",
		authority: "controller_attestation",
		change: (f) =>
			insertRow(f, "coordinator_auth_device_claims", {
				claim_id: "raced-claim",
				coordinator_id: config.coordinatorId,
				identity_id: "raced-identity",
				group_id: input.signer.groupId,
				device_id: "raced-device",
				public_key: input.signer.publicKey,
				fingerprint: input.signer.fingerprint,
				key_id: f.keyId,
				attempt_id: "raced-attempt",
				issuer: config.issuer,
				auth_config_revision: config.revision,
				created_at_ms: 1,
			}),
	},
	{
		part: "link",
		authority: "controller_attestation",
		change: (f) => f.exec("UPDATE coordinator_auth_account_links SET revoked_at_ms = 5"),
	},
	{ part: "revokedHistory", change: insertRevokedHistory },
	{
		part: "legacy",
		change: (f) =>
			insertRow(f, "coordinator_legacy_team_completions", {
				group_id: input.signer.groupId,
				candidate_ref: "raced-candidate",
				manifest_version: 1,
				manifest_json: JSON.stringify({
					coordinator_id: config.coordinatorId,
					device_decisions: [
						{
							device_id: input.signer.deviceId,
							key_fingerprint: input.signer.fingerprint,
							identity_id: input.identityId,
							decision: "excluded",
						},
					],
				}),
				completed_at: "2026-01-01",
				created_at: "2026-01-01",
			}),
	},
	{
		part: "revocationConflicts",
		change: (f) =>
			insertRow(f, "coordinator_device_revocations", {
				subject_kind: "device_id",
				subject_value: input.signer.deviceId,
				revocation_id: "raced-revocation",
				evidence_group_id: input.signer.groupId,
				evidence_device_id: input.signer.deviceId,
				evidence_public_key: input.signer.publicKey,
				evidence_fingerprint: input.signer.fingerprint,
				created_at: "created",
			}),
	},
	{
		part: "inviteConflicts",
		change: (f) =>
			insertRow(f, "coordinator_invites", {
				invite_id: "raced-invite",
				group_id: input.signer.groupId,
				token: "raced-token",
				policy: "open",
				expires_at: "2027-01-01",
				created_at: "2026-01-01",
				consumed_at: "2026-01-02",
				bound_device_id: input.signer.deviceId,
				assigned_identity_id: "other-identity",
			}),
	},
	{
		part: "otherIdentityLinkAttemptConflicts",
		arrange: insertForeignLink,
		change: (f) =>
			f.exec(
				`INSERT INTO coordinator_auth_link_attempts (coordinator_id,attempt_id,identity_id,group_id,device_id,public_key,fingerprint,issuer,auth_config_revision,runtime_verifier_hash,loopback_redirect,state,created_at_ms,expires_at_ms,browser_start_hash,authority_kind,link_id,account_subject,browser_transaction_hash,completion_secret_hash,finalized_at_ms)
 VALUES (?,'foreign-attempt','foreign-identity',?,?,?,?,?,?,?,'http://127.0.0.1:1/x','finalized',1,600001,?,'device_claim','foreign-link','foreign-subject',?,?,2)`,
				config.coordinatorId,
				input.signer.groupId,
				input.signer.deviceId,
				input.signer.publicKey,
				input.signer.fingerprint,
				config.issuer,
				config.revision,
				hash(801),
				hash(802),
				hash(803),
				hash(804),
			),
	},
	{
		part: "otherIdentityLinkAuditConflicts",
		arrange: insertForeignLink,
		change: (f) =>
			f.exec(`INSERT INTO coordinator_auth_link_audit_log(coordinator_id,link_id,action,attempt_id,identity_id,group_id,device_id,fingerprint,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
 SELECT coordinator_id,'foreign-link','link_created','foreign-attempt','foreign-identity',group_id,device_id,fingerprint,auth_config_revision,1,'device_claim','foreign-claim' FROM coordinator_auth_link_audit_log LIMIT 1`),
	},
];

/** The authority a device request would derive right now, with its guard parts. */
async function deriveAuthority(f: AccountChangeFixture) {
	const base = await readAccountChangeBase(f.backend, config, input.signer, {
		deriveTarget: { keyId: f.keyId },
	});
	if (!base.target) throw new Error("fixture target missing");
	const authority = await prepareAccountChangeAuthority(
		f.backend,
		base,
		config,
		input.signer,
		base.target,
		f.clock.now,
	);
	if (!authority) throw new Error("fixture authority missing");
	return authority;
}

const holds = async (f: AccountChangeFixture, guard: { sql: string; values: unknown[] }) => {
	try {
		await f.backend.first({ sql: guard.sql, values: guard.values as never });
		return true;
	} catch {
		return false;
	}
};

async function arranged(part: Part) {
	const f = await accountChangeFixture(part.authority);
	close.push(f.close);
	part.arrange?.(f);
	return f;
}

describe("account change guards", () => {
	it("guards every read the decision depends on, in batch order", async () => {
		// Arrange
		const f = await arranged({ part: "assignment", arrange: assignLegacyTeam, change: () => {} });
		// Act
		const authority = await deriveAuthority(f);
		// Assert
		expect(authority.grant).not.toBeNull();
		expect(Object.keys(authority.parts).sort()).toEqual(PARTS.map((p) => p.part).sort());
		expect(authority.guards).toEqual(Object.values(authority.parts));
	});

	it.each(PARTS)("the $part guard detects its change", async (part) => {
		// Arrange
		const f = await arranged(part);
		const authority = await deriveAuthority(f);
		const guard = authority.parts[part.part];
		if (!guard) throw new Error(`no ${part.part} part`);
		expect(await holds(f, guard)).toBe(true);
		// Act
		part.change(f);
		// Assert
		expect(await holds(f, guard)).toBe(false);
	});
});

interface Site {
	name: string;
	/** Steps that run before the write under test, unraced. */
	before(f: AccountChangeFixture): Promise<void>;
	/** The step under test; returns whether it reported success. */
	write(f: AccountChangeFixture): Promise<boolean>;
	/** Whether the step's write is visible. */
	wrote(f: AccountChangeFixture): boolean;
	/** Whether the site derives its target from the signer. */
	derives: boolean;
}

const stateOf = (f: AccountChangeFixture) =>
	f.rows(`SELECT state FROM ${CHANGES} WHERE attempt_id='change-1'`)[0]?.state;
const unlinkInput = (f: AccountChangeFixture) => ({
	attemptId: "unlink-1",
	signer: input.signer,
	expectedIdentityId: input.identityId,
	expectedLinkId: f.linkId(),
	requestHash: hash(77),
});

const SITES: Site[] = [
	{
		name: "create",
		derives: true,
		before: async () => {},
		write: async (f) => f.operations.create(f.request(1, "refresh"), config),
		wrote: (f) => stateOf(f) !== undefined,
	},
	{
		name: "unlink",
		derives: true,
		before: async () => {},
		write: async (f) => (await f.operations.unlink(unlinkInput(f), config)) !== null,
		wrote: (f) => f.rows(`SELECT 1 FROM ${UNLINKS}`).length > 0,
	},
	{
		name: "callback",
		derives: false,
		before: async (f) => {
			expect(await f.operations.create(f.request(1, "refresh"), config)).toBe(true);
			expect(await f.operations.claimBrowser(f.materials(1), config)).toBe(true);
			expect(await f.operations.consumeCallback(f.materials(1), config)).not.toBeNull();
		},
		write: async (f) => f.operations.recordVerifiedCallback(f.verified(1), config),
		wrote: (f) => stateOf(f) !== "consumed",
	},
	{
		name: "refresh finalize",
		derives: false,
		before: (f) => f.prepare(1, "refresh"),
		write: async (f) => (await f.operations.finalize(f.proof(1), config)) !== null,
		wrote: (f) => stateOf(f) !== "confirmed",
	},
	{
		name: "disconnect finalize",
		derives: false,
		before: (f) => f.prepare(1, "disconnect"),
		write: async (f) => (await f.operations.finalize(f.proof(1), config)) !== null,
		// The disconnect effects archive the link, so a write leaves no current link.
		wrote: (f) =>
			stateOf(f) !== "confirmed" ||
			f.rows("SELECT 1 FROM coordinator_auth_account_links").length === 0,
	},
];

describe.each(SITES)("$name", (site) => {
	it.each([{ authority: "device_claim" }, { authority: "controller_attestation" }] as const)(
		"writes when nothing changed ($authority link)",
		async ({ authority }) => {
			// Arrange
			const f = await arranged({ part: "none", authority, arrange: assignLegacyTeam, change() {} });
			await site.before(f);
			// Act
			const ok = await site.write(f);
			// Assert
			expect(ok).toBe(true);
			expect(site.wrote(f)).toBe(true);
		},
	);

	const parts = PARTS.filter((p) => site.derives || p.part !== "target");
	it.each(parts)("writes nothing when the $part read changes before the write", async (part) => {
		// Arrange
		const f = await arranged(part);
		await site.before(f);
		let applied = false;
		f.hooks.beforeNextBatch = () => {
			part.change(f);
			applied = true;
		};
		// Act
		const ok = await site.write(f);
		// Assert
		expect(applied).toBe(true);
		expect(ok).toBe(false);
		expect(site.wrote(f)).toBe(false);
	});
});
