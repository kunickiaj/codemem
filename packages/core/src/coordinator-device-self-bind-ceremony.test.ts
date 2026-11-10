import { afterEach, describe, expect, it } from "vitest";
import type { DeviceRebindAttempt } from "./coordinator-device-rebind-proof.js";
import { insertOwnDeviceClaim } from "./coordinator-device-rebind-test-fixtures.js";
import { readDeviceSelfBindEligibility } from "./coordinator-device-self-bind-authority.js";
import {
	SELF_BIND_NOW,
	type SelfBindLinkOrigin,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});
type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
async function fixture(kind: "SQLite" | "D1", origin: SelfBindLinkOrigin = "own") {
	const f = await selfBindFixture(kind, origin);
	close.push(f.close);
	return f;
}
function unchanged(f: Fixture) {
	expect(
		f.db
			.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id=?")
			.all(f.signer.deviceId),
	).toEqual([]);
	expect(f.db.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all()).toEqual([]);
	expect(
		f.db
			.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id=? ORDER BY group_id")
			.all(f.signer.deviceId),
	).toEqual([{ identity_id: null }, { identity_id: f.identityId }]);
}
async function confirmed(f: Fixture) {
	const s = f.steps();
	expect(await s.start()).toMatchObject({ kind: "started" });
	expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
	expect(await s.verify()).toMatchObject({ kind: "verified" });
	const result = await s.confirm();
	if (result?.kind !== "confirmed") throw new Error(JSON.stringify(result));
	const row = f.db
		.prepare("SELECT * FROM coordinator_device_rebind_attempts")
		.get() as DeviceRebindAttempt;
	return f.finalizedInput(row, result.completionSecret);
}

async function beforePhase(f: Fixture, phase: "claim" | "callback" | "confirm" | "commit") {
	const s = f.steps();
	expect(await s.start()).toMatchObject({ kind: "started" });
	if (phase === "claim") return s.claim;
	expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
	if (phase === "callback") return s.verify;
	expect(await s.verify()).toMatchObject({ kind: "verified" });
	if (phase === "confirm") return s.confirm;
	const result = await s.confirm();
	if (result?.kind !== "confirmed") throw new Error(JSON.stringify(result));
	const input = f.finalizedInput(
		f.db.prepare("SELECT * FROM coordinator_device_rebind_attempts").get() as DeviceRebindAttempt,
		result.completionSecret,
	);
	return () => f.makeCeremony(f.backend).finalize(input);
}

function authorityEffects(f: Fixture) {
	return [
		"coordinator_device_rebind_attempts",
		"coordinator_auth_browser_transactions",
		"coordinator_device_ownership_bindings",
		"enrolled_devices",
		"coordinator_device_rebind_audit_log",
		"coordinator_auth_account_links",
		"coordinator_auth_controller_attestations",
		"coordinator_identity_group_grants",
	].map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

describe.each(["SQLite", "D1"] as const)("%s controller-only same-Identity ceremony", (kind) => {
	it.each(["own", "peer", "peer_controller"] as const)(
		"connects with %s-origin valid link only after fresh OIDC, browser consent and final key signature",
		async (origin) => {
			// Arrange
			const f = await fixture(kind, origin);
			f.db
				.prepare(
					"INSERT INTO coordinator_identity_group_grants(coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at) VALUES(?,?,'group-a','active',1,'controller_attestation','existing-receipt','created')",
				)
				.run(f.config.coordinatorId, f.identityId);
			const grantsBefore = f.db.prepare("SELECT * FROM coordinator_identity_group_grants").all();
			const before = f.db
				.prepare(
					"SELECT * FROM enrolled_devices WHERE identity_id IS NOT NULL ORDER BY device_id,group_id",
				)
				.all();
			f.db.exec(
				"CREATE TRIGGER preserve_nonnull_enrollment BEFORE UPDATE ON enrolled_devices WHEN OLD.identity_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'nonnull enrollment touched'); END",
			);
			const input = await confirmed(f);
			// Act
			const c = f.makeCeremony(f.backend);
			const result = await c.finalize(input);
			const replay = await c.finalize(input);
			// Assert
			expect(result).toMatchObject({
				kind: "finalized",
				receipt: {
					previousIdentityId: f.identityId,
					targetIdentityId: f.identityId,
					enrollmentCount: 2,
				},
			});
			expect(replay).toMatchObject({
				kind: "prior_commit",
				receipt: result && "receipt" in result ? result.receipt : null,
			});
			const after = f.db
				.prepare(
					"SELECT * FROM enrolled_devices WHERE identity_id IS NOT NULL ORDER BY device_id,group_id",
				)
				.all() as unknown[];
			for (const row of before) expect(after).toContainEqual(row);
			expect(
				f.db
					.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id=?")
					.all(f.signer.deviceId),
			).toEqual([{ identity_id: f.identityId }, { identity_id: f.identityId }]);
			expect(
				f.db.prepare("SELECT count(*) n FROM coordinator_device_rebind_audit_log").get(),
			).toEqual({ n: 1 });
			expect(f.db.prepare("SELECT * FROM coordinator_identity_group_grants").all()).toEqual(
				grantsBefore,
			);
		},
	);
});

const changes: [string, (f: Fixture) => void][] = [
	[
		"replaced account link",
		(f) => {
			f.db.exec("UPDATE coordinator_auth_account_links SET link_id='replacement-link'");
		},
	],
	[
		"changed account subject",
		(f) => {
			f.db.exec("UPDATE coordinator_auth_account_links SET subject='replacement-subject'");
		},
	],
	[
		"revoked own proof",
		(f) => {
			f.db.exec("UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked'");
		},
	],
	[
		"disappearing own proof",
		(f) => {
			f.db.exec("DELETE FROM coordinator_auth_controller_attestations WHERE device_id='device-a'");
		},
	],
	[
		"replaced own proof",
		(f) => {
			f.db.exec(
				"UPDATE coordinator_auth_controller_attestations SET attestation_id='replacement',review_receipt_id='replacement-review' WHERE device_id='device-a'",
			);
		},
	],
	[
		"changed review receipt",
		(f) => {
			f.db.exec("UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed'");
		},
	],
	[
		"changed evidence digest",
		(f) => {
			f.db
				.prepare("UPDATE coordinator_auth_controller_attestations SET evidence_digest=?")
				.run("f".repeat(64));
		},
	],
	[
		"revoked account link",
		(f) => {
			f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=?").run(SELF_BIND_NOW);
		},
	],
	[
		"disabled signer",
		(f) => {
			f.db.exec(
				"UPDATE enrolled_devices SET enabled=0 WHERE group_id='group-a' AND device_id='device-a'",
			);
		},
	],
	[
		"enrollment set grew",
		(f) => {
			f.db.exec(
				"INSERT INTO groups(group_id,created_at) VALUES('group-c','created'); INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) SELECT 'group-c',device_id,public_key,fingerprint,identity_id,enabled,created_at FROM enrolled_devices WHERE group_id='group-b' AND device_id='device-a'",
			);
		},
	],
];
describe.each(["SQLite", "D1"] as const)("%s start authority remains current", (kind) => {
	for (const [name, mutate] of changes) {
		it.each(["claim", "callback", "confirm", "commit"] as const)(
			`refuses ${name} before %s`,
			async (phase) => {
				// Arrange: mutate only after the server pins the birth facts.
				const f = await fixture(kind, "peer");
				const act = await beforePhase(f, phase);
				mutate(f);
				const before = authorityEffects(f);
				// Act
				const result = await act();
				// Assert
				expect(result?.kind).not.toMatch(
					/^(browser_claimed|verified|confirmed|finalized|prior_commit)$/,
				);
				expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toEqual(
					[],
				);
				expect(f.db.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all()).toEqual([]);
				// Callback consumption intentionally retires its one-use OIDC transaction.
				// Claim, confirmation and commit must leave every persisted fact unchanged.
				if (phase !== "callback") expect(authorityEffects(f)).toEqual(before);
			},
		);
	}
});

const refusals: [string, (f: Fixture) => void | Promise<void>][] = [
	[
		"headless account link",
		(f) => {
			f.db.exec(
				"INSERT INTO coordinator_headless_link_provenance(coordinator_id,link_id,identity_id,issuer,subject,attempt_id,created_at_ms) SELECT coordinator_id,link_id,identity_id,issuer,subject,attempt_id,created_at_ms FROM coordinator_auth_account_links",
			);
		},
	],
	[
		"no own attestation",
		(f) => {
			f.db.exec("DELETE FROM coordinator_auth_controller_attestations");
		},
	],
	[
		"duplicate own attestation",
		(f) => {
			f.db.exec(
				"INSERT INTO coordinator_auth_controller_attestations SELECT 'duplicate',coordinator_id,identity_id,'group-b',device_id,public_key,fingerprint,'duplicate-review',evidence_digest,enrollment_identity_id,revision,created_at,revoked_at FROM coordinator_auth_controller_attestations WHERE device_id='device-a'",
			);
		},
	],
	[
		"own device claim",
		(f) =>
			insertOwnDeviceClaim(f.db, {
				coordinatorId: f.config.coordinatorId,
				issuer: f.config.issuer,
				revision: f.config.revision,
				identityId: f.identityId,
				deviceId: f.signer.deviceId,
			}),
	],
	[
		"existing ownership binding",
		(f) => {
			f.db
				.prepare(
					"INSERT INTO coordinator_device_ownership_bindings(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) VALUES(?,?,?,?, 'existing','owner_enrollment','existing','created')",
				)
				.run(
					f.signer.deviceId,
					f.db.prepare("SELECT key_id FROM coordinator_auth_device_claims LIMIT 1").pluck().get(),
					f.identityId,
					f.config.coordinatorId,
				);
		},
	],
	[
		"key alias on another device",
		(f) => {
			f.db
				.prepare(
					"INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES('group-a','alias-device',?,?,NULL,1,'created')",
				)
				.run(`${f.signer.publicKey} alias-comment`, "f".repeat(64));
		},
	],
	[
		"foreign enrollment owner",
		(f) => {
			f.db.exec(
				"UPDATE enrolled_devices SET identity_id='other-identity' WHERE group_id='group-b' AND device_id='device-a'",
			);
		},
	],
	[
		"mismatched fingerprint",
		(f) => {
			f.db
				.prepare(
					"UPDATE enrolled_devices SET fingerprint=? WHERE group_id='group-b' AND device_id='device-a'",
				)
				.run("f".repeat(64));
		},
	],
	[
		"revoked device",
		(f) => {
			f.db
				.prepare(
					"INSERT INTO coordinator_device_revocations(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES('device_id',?,'revoked','group-a',?,?,?,'created')",
				)
				.run(f.signer.deviceId, f.signer.deviceId, f.signer.publicKey, f.signer.fingerprint);
		},
	],
	[
		"consumed conflicting invitation",
		(f) => {
			f.db.exec(
				"INSERT INTO coordinator_invites(invite_id,group_id,token,policy,expires_at,created_at,consumed_at,bound_device_id,bound_public_key,bound_fingerprint,assigned_identity_id) SELECT 'conflict-invite',group_id,'fixture-token','open','2027-01-01','2026-01-01','2026-01-02',device_id,public_key,fingerprint,'other-identity' FROM coordinator_auth_controller_attestations WHERE device_id='device-a'",
			);
		},
	],
	[
		"deliberate legacy exclusion",
		(f) => {
			f.db.exec(
				"INSERT INTO coordinator_legacy_team_completions(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) SELECT group_id,'excluded-candidate',1,json_object('coordinator_id',coordinator_id,'device_decisions',json_array(json_object('device_id',device_id,'key_fingerprint',fingerprint,'identity_id',identity_id,'decision','excluded','enabled',0))),'2026-01-01','2026-01-01' FROM coordinator_auth_controller_attestations WHERE device_id='device-a'",
			);
		},
	],
	[
		"unproven account link",
		(f) => {
			f.db.exec("DELETE FROM coordinator_auth_link_audit_log");
		},
	],
];
describe.each(["SQLite", "D1"] as const)("%s exceptional readiness denials", (kind) => {
	for (const [name, mutate] of refusals)
		it(`does not offer exceptional readiness for ${name}`, async () => {
			// Arrange
			const f = await fixture(kind, name === "own device claim" ? "own" : "peer");
			await mutate(f);
			// Act
			const result = await readDeviceSelfBindEligibility(
				f.backend,
				{ signer: f.signer, currentIdentityId: f.identityId },
				f.config,
				SELF_BIND_NOW,
			);
			const start = await f.steps().start();
			// Assert
			expect(result).toEqual({ kind: "unavailable" });
			// A device with no own proof retains the existing ordinary self-bind path.
			if (name !== "no own attestation") expect(start?.kind).toBe("refused");
		});
});

describe.each(["SQLite", "D1"] as const)("%s self-bind confirmation and rollback", (kind) => {
	it.each(["provider refusal", "wrong Google account", "no browser consent", "wrong final key"])(
		"requires %s to be resolved before ownership can commit",
		async (scenario) => {
			// Arrange
			const f = await fixture(kind);
			const s = f.steps();
			expect(await s.start()).toMatchObject({ kind: "started" });
			expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
			if (scenario === "provider refusal") f.account.ok = false;
			if (scenario === "wrong Google account") f.account.subject = "someone-else";
			const verified = await s.verify();
			// Act
			let result = verified;
			if (scenario === "no browser consent")
				result = await f.makeCeremony(f.backend).finalize({
					attemptId: f.input.attemptId,
					signer: f.signer,
					completionSecret: "c".repeat(43),
					signature: "invalid",
				});
			if (scenario === "wrong final key") {
				const r = await s.confirm();
				if (r?.kind !== "confirmed") throw new Error(JSON.stringify(r));
				result = await f.makeCeremony(f.backend).finalize({
					...f.finalizedInput(
						f.db
							.prepare("SELECT * FROM coordinator_device_rebind_attempts")
							.get() as DeviceRebindAttempt,
						r.completionSecret,
					),
					signature: "invalid",
				});
			}
			// Assert
			expect(result?.kind).toBe("refused");
			unchanged(f);
		},
	);

	it("rolls back the winning binding, NULL enrollment fill and receipt on audit failure", async () => {
		// Arrange
		const f = await fixture(kind);
		const input = await confirmed(f);
		f.db.exec(
			"CREATE TRIGGER audit_failure BEFORE INSERT ON coordinator_device_rebind_audit_log BEGIN SELECT RAISE(ABORT,'audit failed'); END",
		);
		// Act
		const result = await f.makeCeremony(f.backend).finalize(input);
		// Assert
		expect(result).toEqual({ kind: "unknown" });
		unchanged(f);
		expect(f.db.prepare("SELECT state FROM coordinator_device_rebind_attempts").get()).toEqual({
			state: "confirmed",
		});
	});

	it("keeps the start authority immutable, including a NULL ordinary snapshot", async () => {
		// Arrange
		const f = await fixture(kind);
		expect(await f.steps().start()).toMatchObject({ kind: "started" });
		// Act / Assert
		expect(() =>
			f.db.exec("UPDATE coordinator_device_rebind_attempts SET start_authority_json=NULL"),
		).toThrow(/immutable/);
		expect(() =>
			f.db.exec("UPDATE coordinator_device_rebind_attempts SET start_authority_json='{}'"),
		).toThrow(/immutable/);
	});

	it("fails readiness closed when the additive column is absent", async () => {
		// Arrange
		const f = await fixture(kind);
		f.db.exec(
			"DROP TRIGGER coordinator_device_rebind_attempt_pins; ALTER TABLE coordinator_device_rebind_attempts DROP COLUMN start_authority_json",
		);
		// Act
		const result = await readDeviceSelfBindEligibility(
			f.backend,
			{ signer: f.signer, currentIdentityId: f.identityId },
			f.config,
			SELF_BIND_NOW,
		);
		// Assert
		expect(result).toEqual({ kind: "unavailable" });
		unchanged(f);
	});
});
