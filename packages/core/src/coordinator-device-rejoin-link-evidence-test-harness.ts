import { expect, it } from "vitest";
import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	type DeviceRejoinLinkEvidence,
	REJOIN_LINK_PIN_MATCH_SQL,
	readDeviceRejoinLinkEvidence,
	readDeviceRejoinLinkStorage,
	rejoinLinkEvidenceCtes,
} from "./coordinator-device-rejoin-link-evidence.js";
import { COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS } from "./coordinator-owner-enrollment-qualification-schema.js";

export type RejoinEvidenceFixture = Pick<AuthLinkBackend, "first"> & {
	run(sql: string, ...values: (string | number | null)[]): Promise<unknown>;
	proof: {
		controllerLinkEvidenceSql(pins: { publicKey: string; attemptId?: string }): string;
		seedAttestationSql: string;
		seedClaimSql: string;
	};
};
type Fixture = RejoinEvidenceFixture;

const NOW = 1_791_028_800_000;
const scope = {
	coordinatorId: "coordinator-a",
	identityId: "identity-a",
	issuer: "https://accounts.example.test",
	subject: "private-subject",
	now: NOW + 100,
};
const genesis = {
	link_id: "link-a",
	link_authority_kind: "controller_attestation",
	link_generation: 1,
} as const;

async function seedOrder(db: Fixture) {
	await db.run(
		"INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) VALUES (?,0)",
		scope.coordinatorId,
	);
	await db.run(
		"UPDATE coordinator_auth_account_connection_orders SET last_order=last_order+1 WHERE coordinator_id=?",
		scope.coordinatorId,
	);
}

export async function seedGenesis(db: Fixture) {
	await seedOrder(db);
	await db.run(
		`INSERT INTO coordinator_auth_controller_attestations
	(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,created_at)
	VALUES ('historical-controller','coordinator-a','identity-a','group-a','device-a',?,?, 'historical-receipt',?, 'created')`,
		"fixture-public-key",
		"a".repeat(64),
		"b".repeat(64),
	);
	for (const sql of db.proof
		.controllerLinkEvidenceSql({ publicKey: "fixture-public-key" })
		.split(";")) {
		if (sql.trim()) await db.run(sql);
	}
}

async function seedClaim(db: Fixture) {
	await seedOrder(db);
	for (const sql of `${db.proof.seedClaimSql};${db.proof.seedAttestationSql}`.split(";")) {
		if (sql.trim()) await db.run(sql);
	}
	await db.run(`INSERT INTO coordinator_auth_account_links
	(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
	SELECT coordinator_id,claim_id,issuer,'private-claim-subject',identity_id,attempt_id,
	auth_config_revision,created_at_ms,'device_claim',claim_id FROM coordinator_auth_device_claims`);
	await db.run(`INSERT INTO coordinator_auth_link_audit_log
	(coordinator_id,link_id,attempt_id,action,identity_id,group_id,device_id,fingerprint,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
	SELECT coordinator_id,claim_id,attempt_id,'link_created',identity_id,group_id,device_id,
	fingerprint,auth_config_revision,created_at_ms,'device_claim',claim_id FROM coordinator_auth_device_claims`);
}

async function qualifyClaim(db: Fixture) {
	if ((await readDeviceRejoinLinkStorage(db)) === "unqualified") {
		for (const sql of COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS)
			await db.run(sql);
	}
	await db.run(
		`INSERT INTO coordinator_owner_enrollment_qualifications
	(qualification_id,coordinator_id,link_id,device_claim_id,identity_id,source_group_id,device_id,
	public_key,fingerprint,key_id,controller_attestation_id,controller_attestation_revision,
	controller_attestation_created_at,review_receipt_id,evidence_digest,enrollment_identity_id,
	link_attempt_id,link_auth_config_revision,link_created_at_ms,created_at_ms)
	SELECT 'qualification-a', d.coordinator_id,d.claim_id,d.claim_id,d.identity_id,d.group_id,d.device_id,
	d.public_key,d.fingerprint,d.key_id,t.attestation_id,t.revision,t.created_at,t.review_receipt_id,
	t.evidence_digest,t.enrollment_identity_id,d.attempt_id,d.auth_config_revision,d.created_at_ms,?
	FROM coordinator_auth_device_claims d JOIN coordinator_auth_controller_attestations t
	ON t.coordinator_id=d.coordinator_id AND t.identity_id=d.identity_id`,
		NOW + 1,
	);
}

async function unlink(db: Fixture, end: string, at: number, options: { incomplete?: true } = {}) {
	const columns = CONNECTION_BIRTH_COLUMNS.join(",");
	await db.run(
		`INSERT INTO coordinator_auth_account_connection_unlinks
	(coordinator_id,attempt_id,target_link_id,identity_id,issuer,target_subject,group_id,
	device_id,public_key,fingerprint,enrollment_identity_id,auth_config_revision,request_hash,state,created_at_ms)
	SELECT coordinator_id,?,link_id,identity_id,issuer,subject,'group-a','device-a','fixture-public-key',
	?,NULL,auth_config_revision,?,'committing',? FROM coordinator_auth_account_links`,
		end,
		"a".repeat(64),
		"b".repeat(64),
		at,
	);
	await db.run(
		`INSERT INTO coordinator_auth_account_connection_history
	(${columns},original_rowid,ended_at_ms,end_attempt_id,signin_floor)
	SELECT ${columns},rowid,?,?,signin_floor FROM coordinator_auth_account_links`,
		at,
		end,
	);
	await db.run("DELETE FROM coordinator_auth_account_links");
	if (options.incomplete) return;
	await db.run(
		`UPDATE coordinator_auth_account_connection_unlinks
	SET state='completed',completed_at_ms=? WHERE attempt_id=?`,
		at,
		end,
	);
}

async function relink(
	db: Fixture,
	index: number,
	prior: string | null,
	options: { attach: boolean },
) {
	const at = NOW + index;
	const attempt = `attempt-${index}`;
	const link = `link-${index}`;
	for (const sql of db.proof
		.controllerLinkEvidenceSql({
			publicKey: "fixture-public-key",
			attemptId: attempt,
		})
		.split(";")) {
		if (!sql.trim()) continue;
		// Give the new birth its own link ID, end-to-start ordering and retained prior pin.
		let next = sql.replaceAll("'link-a'", `'${link}'`).replaceAll(String(NOW), String(at));
		if (next.includes("INSERT INTO coordinator_auth_link_attempts") && prior !== null)
			next = next
				.replace("(coordinator_id", "(prior_link_id,coordinator_id")
				.replace("VALUES (", `VALUES ('${prior}',`);
		await db.run(next);
	}
	if (options.attach)
		await db.run(
			"UPDATE coordinator_auth_account_connection_history SET successor_link_id=? WHERE link_id=?",
			link,
			prior,
		);
}

async function matchesOnWrite(db: Fixture, pin: DeviceRejoinLinkEvidence, input = scope) {
	const storage = await readDeviceRejoinLinkStorage(db);
	if (!storage) throw new Error("Missing rejoin link schema in fixture");
	return db.run(
		`WITH RECURSIVE rejoin_link_scope(coordinator_id,identity_id,issuer,subject) AS (VALUES (?,?,?,?)),
	rejoin_link_clock(now_ms) AS (VALUES (?)), ${rejoinLinkEvidenceCtes(storage)},
	a(coordinator_id,identity_id,link_id,link_authority_kind,link_generation) AS (VALUES (?,?,?,?,?))
	INSERT INTO groups (group_id,created_at) SELECT 'marker','then' FROM a
	JOIN rejoin_link_evidence l ON ${REJOIN_LINK_PIN_MATCH_SQL}`,
		input.coordinatorId,
		input.identityId,
		input.issuer,
		input.subject,
		input.now,
		input.coordinatorId,
		input.identityId,
		pin.link_id,
		pin.link_authority_kind,
		pin.link_generation,
	);
}

function marker(db: Fixture) {
	return db.first({ sql: "SELECT group_id FROM groups WHERE group_id='marker'", values: [] });
}

export function registerRejoinLinkEvidenceTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("accepts only the exact coordinator, Identity, issuer and Google subject", () =>
		withFixture(async (db) => {
			await seedGenesis(db);
			expect(await readDeviceRejoinLinkEvidence(db, scope)).toEqual(genesis);
			for (const key of ["coordinatorId", "identityId", "issuer", "subject"] as const) {
				expect(await readDeviceRejoinLinkEvidence(db, { ...scope, [key]: "other" })).toBeNull();
			}
		}));

	it("derives the ordinal across multiple reconnects instead of using a rowid or browser order", () =>
		withFixture(async (db) => {
			await seedGenesis(db);
			await unlink(db, "end-a", NOW + 1);
			await relink(db, 2, "link-a", { attach: true });
			await unlink(db, "end-b", NOW + 3);
			await relink(db, 4, "link-2", { attach: true });
			const pin = { ...genesis, link_id: "link-4", link_generation: 3 };
			expect(await readDeviceRejoinLinkEvidence(db, scope)).toEqual(pin);
			for (const wrong of [
				{ ...pin, link_id: "link-2" },
				{ ...pin, link_generation: 2 },
				{ ...pin, link_authority_kind: "device_claim" as const },
			])
				await matchesOnWrite(db, wrong);
			expect(await marker(db)).toBeNull();
			await matchesOnWrite(db, pin);
			expect(await marker(db)).toEqual({ group_id: "marker" });
		}));

	registerInvalidLineageTests(withFixture);
	registerIncompleteProofTests(withFixture);

	it("compares the current claim kind again when qualification changes", () =>
		withFixture(async (db) => {
			await seedClaim(db);
			const claimScope = { ...scope, subject: "private-claim-subject" };
			const bare = {
				link_id: "claim-a",
				link_authority_kind: "device_claim",
				link_generation: 1,
			} as const;
			const qualified = { ...bare, link_authority_kind: "qualified_device_claim" } as const;
			expect(await readDeviceRejoinLinkEvidence(db, claimScope)).toEqual(bare);
			await qualifyClaim(db);
			expect(await readDeviceRejoinLinkEvidence(db, claimScope)).toEqual(qualified);
			await matchesOnWrite(db, bare, claimScope);
			expect(await marker(db)).toBeNull();
			await db.run(
				"UPDATE coordinator_owner_enrollment_qualifications SET revoked_at_ms=?",
				NOW + 2,
			);
			await matchesOnWrite(db, qualified, claimScope);
			expect(await marker(db)).toBeNull();
			expect(await readDeviceRejoinLinkEvidence(db, claimScope)).toEqual(bare);
			await matchesOnWrite(db, bare, claimScope);
			expect(await marker(db)).toEqual({ group_id: "marker" });
		}));
}

function registerIncompleteProofTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("refuses a connected predecessor without a completed disconnect receipt", () =>
		withFixture(async (db) => {
			await seedGenesis(db);
			await unlink(db, "end-a", NOW + 1, { incomplete: true });
			await relink(db, 2, "link-a", { attach: true });

			expect(await readDeviceRejoinLinkEvidence(db, scope)).toBeNull();
			await matchesOnWrite(db, { ...genesis, link_id: "link-2", link_generation: 2 });
			expect(await marker(db)).toBeNull();
		}));

	it("refuses an extra finalized birth that has no current or retained link", () =>
		withFixture(async (db) => {
			await seedGenesis(db);
			const orphan = db.proof
				.controllerLinkEvidenceSql({ publicKey: "fixture-public-key", attemptId: "orphan" })
				.split(";")
				.find((sql) => sql.includes("INSERT INTO coordinator_auth_link_attempts"))
				?.replaceAll("'link-a'", "'orphan-link'");
			if (!orphan) throw new Error("Missing synthetic link attempt");
			await db.run(orphan);

			expect(await readDeviceRejoinLinkEvidence(db, scope)).toBeNull();
			await matchesOnWrite(db, genesis);
			expect(await marker(db)).toBeNull();
		}));
}

function registerInvalidLineageTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it.each(["disconnected", "missing successor", "missing prior", "revoked predecessor"] as const)(
		"refuses %s history at the winning write",
		(mode) =>
			withFixture(async (db) => {
				await seedGenesis(db);
				const before = await readDeviceRejoinLinkEvidence(db, scope);
				expect(before).toEqual(genesis);
				await unlink(db, "end-a", NOW + 1);
				if (mode !== "disconnected") {
					await relink(db, 2, mode === "missing prior" ? null : "link-a", {
						attach: mode === "revoked predecessor",
					});
				}
				if (mode === "missing prior")
					await db.run(
						"UPDATE coordinator_auth_account_connection_history SET successor_link_id='link-2' WHERE link_id='link-a'",
					);
				if (mode === "revoked predecessor")
					await db.run(
						"UPDATE coordinator_auth_account_connection_history SET revoked_at_ms=? WHERE link_id='link-a'",
						NOW + 3,
					);
				expect(await readDeviceRejoinLinkEvidence(db, scope)).toBeNull();
				await matchesOnWrite(db, { ...genesis, link_id: "link-2", link_generation: 2 });
				expect(await marker(db)).toBeNull();
			}),
	);
}
