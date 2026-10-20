import { expect, it } from "vitest";
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "../../core/src/coordinator-account-connection-schema.js";
import { CONNECTION_BIRTH_COLUMNS } from "../../core/src/coordinator-account-connection-storage.js";
import type { AuthLinkBackend, AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { authDeviceClaimProvenanceSql } from "../../core/src/coordinator-auth-link-provenance.js";
import { EXPECTED_KEY_ID } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import {
	OwnerEnrollmentQualificationOps,
	type OwnerQualificationPreview,
} from "../../core/src/coordinator-owner-enrollment-qualification.js";
import {
	config,
	input,
	NOW,
	seedAttestationSql,
	seedClaimSql,
	seedEnrollmentSql,
} from "./device-claim-eligibility-fixture.js";

export interface QualificationOpsDatabase {
	backend: AuthLinkBackend;
	query(sql: string): Promise<Record<string, unknown>[]>;
}
export const table = "coordinator_owner_enrollment_qualifications";
export const current = "coordinator_auth_account_links";
export const history = "coordinator_auth_account_connection_history";
export const attestation = { attestationId: "attestation-a" };
export const rejected = { kind: "rejected", error: "unavailable" };
const expectedPreview = {
	kind: "ready",
	digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
	attestationId: "attestation-a",
	reviewReceiptId: "receipt-a",
	linkId: "claim-a",
	claimId: "claim-a",
	identityId: "identity-a",
	groupId: "group-a",
	deviceId: "device-a",
	fingerprint: input.signer.fingerprint,
};
const protectedTables = [
	current,
	history,
	"coordinator_auth_device_claims",
	"coordinator_auth_link_attempts",
	"coordinator_auth_link_audit_log",
	"coordinator_identity_group_grants",
	"enrolled_devices",
	"coordinator_auth_controller_attestations",
];

async function seedQualificationSource(db: QualificationOpsDatabase) {
	const exec = async (sql: string) => {
		await db.backend.run({ sql, values: [] });
	};
	// Persisted historical proof, not fabricated authority or a full provider journey.
	for (const sql of `${seedEnrollmentSql};${seedClaimSql};${seedAttestationSql}`
		.split(";")
		.filter((s) => s.trim()))
		await exec(sql);
	await exec(`INSERT INTO ${current} (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,auth_config_revision,created_at_ms,revoked_at_ms,authority_kind,device_claim_id)
 VALUES ('${config.coordinatorId}','claim-a','${config.issuer}','private-claim-subject','identity-a','completed-attempt',NULL,'${config.revision}',${NOW},NULL,'device_claim','claim-a')`);
	await exec(`INSERT INTO coordinator_auth_link_audit_log (coordinator_id,link_id,attempt_id,action,identity_id,group_id,device_id,fingerprint,controller_attestation_id,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
 VALUES ('${config.coordinatorId}','claim-a','completed-attempt','link_created','identity-a','group-a','device-a','${input.signer.fingerprint}',NULL,'${config.revision}',${NOW},'device_claim','claim-a')`);
	await applyAccountConnectionSchema(db.backend);
	expect(await readConnectionSchemaState(db.backend)).toBe("ready");
	// Exercise the real proof validator so a false fixture cannot make denials pass.
	expect(
		await db.query(
			`SELECT ${authDeviceClaimProvenanceSql({ link: "l", connections: true })} AS valid FROM ${current} l`,
		),
	).toEqual([{ valid: 1 }]);
}
function tracedBackend(db: QualificationOpsDatabase) {
	const calls: AuthLinkStatement[] = [];
	const errors: string[] = [];
	let beforeInsert: (() => Promise<void>) | undefined;
	const backend: AuthLinkBackend = {
		first: async <T>(s: AuthLinkStatement) => {
			calls.push(s);
			try {
				return await db.backend.first<T>(s);
			} catch (error) {
				errors.push(String(error));
				throw error;
			}
		},
		run: async (s) => {
			calls.push(s);
			if (s.sql.startsWith(`INSERT INTO ${table}`)) {
				const hook = beforeInsert;
				beforeInsert = undefined;
				await hook?.();
			}
			return db.backend.run(s);
		},
		batch: (s) => db.backend.batch(s),
	};
	return {
		backend,
		calls,
		errors,
		onInsert: (hook: () => Promise<void>) => {
			beforeInsert = hook;
		},
	};
}
export async function qualificationOpsFixture(db: QualificationOpsDatabase) {
	await seedQualificationSource(db);
	const traced = tracedBackend(db);
	const { backend } = traced;
	let now = NOW + 100;
	const exec = async (sql: string) => {
		await db.backend.run({ sql, values: [] });
	};
	const ops = new OwnerEnrollmentQualificationOps(backend, config, () => now);
	const rows = (name = table) => db.query(`SELECT * FROM ${name}`);
	const snapshot = () => Promise.all(protectedTables.map((name) => rows(name)));
	async function ready(): Promise<OwnerQualificationPreview> {
		const result = await ops.preview(attestation);
		expect(result).toMatchObject({ kind: "ready" });
		if (result.kind !== "ready")
			throw new Error(`Qualification fixture unavailable: ${JSON.stringify(result)}`);
		return result;
	}
	async function issue() {
		const p = await ready();
		const result = await ops.issue({ ...attestation, expectedDigest: p.digest });
		expect(result).toMatchObject({ kind: "created" });
		if (result.kind !== "created") throw new Error("qualification fixture not created");
		return result;
	}
	return {
		...db,
		...traced,
		ops,
		exec,
		rows,
		snapshot,
		ready,
		issue,
		corrupt: (name: string, assignment: string) => corrupt(db, name, assignment),
		end: (options: { relink?: boolean } = {}) => endConnection(db, options),
		clock: (value: number) => {
			now = value;
		},
	};
}
// Historical corruption is fixture-only; restore definitions before operations.
async function corrupt(db: QualificationOpsDatabase, name: string, assignment: string) {
	const exec = async (sql: string) => {
		await db.backend.run({ sql, values: [] });
	};
	const triggers = await db.query(
		`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='${name}'`,
	);
	for (const t of triggers) await exec(`DROP TRIGGER ${t.name}`);
	try {
		await exec(`UPDATE ${name} SET ${assignment}`);
	} finally {
		for (const t of triggers) await exec(String(t.sql));
	}
}
async function endConnection(
	db: QualificationOpsDatabase,
	{ relink = false }: { relink?: boolean },
) {
	const exec = async (sql: string) => {
		await db.backend.run({ sql, values: [] });
	};
	const columns = [...CONNECTION_BIRTH_COLUMNS, "signin_floor"].join(",");
	// Seed a historical disconnect, not a management authorization journey.
	const guards = await db.query(
		`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='${history}' AND name LIKE 'account_change_%'`,
	);
	for (const t of guards) await exec(`DROP TRIGGER ${t.name}`);
	try {
		await exec(
			`INSERT INTO ${history} (${columns},original_rowid,ended_at_ms,end_attempt_id) SELECT ${columns},rowid,${NOW + 50},'end-a' FROM ${current}`,
		);
	} finally {
		for (const t of guards) await exec(String(t.sql));
	}
	await exec(`DELETE FROM ${current}`);
	if (!relink) return;
	await exec(
		`INSERT INTO ${current} (${columns}) SELECT ${[...CONNECTION_BIRTH_COLUMNS, "signin_floor"]
			.map((c) => {
				if (c === "link_id") return "'link-b'";
				if (c === "attempt_id") return "'attempt-b'";
				return c;
			})
			.join(",")} FROM ${history}`,
	);
	await exec(`UPDATE ${history} SET successor_link_id='link-b'`);
	for (const name of ["coordinator_auth_link_attempts", "coordinator_auth_link_audit_log"]) {
		const fields = (await db.query(`PRAGMA table_info(${name})`)).map((c) => String(c.name));
		await exec(
			`INSERT INTO ${name} (${fields.join(",")}) SELECT ${fields
				.map((c) => {
					if (c === "attempt_id") return "'attempt-b'";
					if (c === "link_id") return "'link-b'";
					if (c === "prior_link_id") return "'claim-a'";
					if (
						[
							"browser_start_hash",
							"runtime_verifier_hash",
							"browser_transaction_hash",
							"completion_secret_hash",
						].includes(c)
					)
						return `'${"d".repeat(64)}'`;
					return c;
				})
				.join(",")} FROM ${name}`,
		);
	}
	expect(
		await db.query(
			`SELECT ${authDeviceClaimProvenanceSql({ link: "l", connections: true })} AS valid FROM ${current} l`,
		),
	).toEqual([{ valid: 1 }]);
}
export type Fixture = Awaited<ReturnType<typeof qualificationOpsFixture>>;
export function qualificationOpsTest(
	fixture: (use: (f: Fixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: Fixture }>({ fixture: async ({ task: _task }, use) => fixture(use) });
}
export type Test = ReturnType<typeof qualificationOpsTest>;

export function registerQualificationOpsTests(test: Test) {
	registerIssuance(test);
	registerDigest(test);
	registerReviewSnapshots(test);
	registerRevocation(test);
	registerIssueFaults(test, ["after_commit"]);
	registerRaces(test, {
		stages: ["before INSERT"],
		mutations: [
			[
				"disabled enrollment",
				(f) => f.exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'"),
			],
		],
	});
}
function registerIssuance(test: Test) {
	test("previews read-only, issues complete birth facts and retries the identical ID without authority writes", async ({
		fixture: f,
	}) => {
		// Arrange
		const before = await f.snapshot();
		// Act
		const p = await f.ready();
		// Assert: private account subject is digest input, not preview output.
		expect(p).toEqual(await f.ready());
		expect(p).toEqual(expectedPreview);
		expect(await f.rows()).toEqual([]);
		const created = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
		expect(created).toMatchObject({ kind: "created", qualificationId: expect.any(String) });
		if (created.kind !== "created") throw new Error("issue failed");
		expect(await f.rows()).toEqual([
			{
				qualification_id: created.qualificationId,
				coordinator_id: config.coordinatorId,
				link_id: "claim-a",
				device_claim_id: "claim-a",
				identity_id: "identity-a",
				source_group_id: "group-a",
				device_id: "device-a",
				public_key: input.signer.publicKey,
				fingerprint: input.signer.fingerprint,
				key_id: EXPECTED_KEY_ID,
				controller_attestation_id: "attestation-a",
				controller_attestation_revision: 1,
				controller_attestation_created_at: "created",
				review_receipt_id: "receipt-a",
				evidence_digest: "a".repeat(64),
				enrollment_identity_id: null,
				link_attempt_id: "completed-attempt",
				link_auth_config_revision: config.revision,
				link_created_at_ms: NOW,
				created_at_ms: NOW + 100,
				revoked_at_ms: null,
			},
		]);
		f.clock(NOW + 200);
		const retried = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
		expect(f.calls.every((s) => s.values.length < 100)).toBe(true);
		expect(
			f.calls.filter((s) => s.sql.startsWith(`INSERT INTO ${table}`)).map((s) => s.values.length),
		).toEqual([22, 22]);
		expect(retried, f.errors.join("\n")).toEqual({
			kind: "existing",
			qualificationId: created.qualificationId,
		});
		expect(await f.rows()).toHaveLength(1);
		expect(await f.snapshot()).toEqual(before);
	});
}
function registerDigest(test: Test) {
	test("requires exact digest and pins changed enrollment and trusted configuration in distinct previews", async ({
		fixture: f,
	}) => {
		// Arrange
		const p = await f.ready();
		// Act
		await f.exec("UPDATE enrolled_devices SET display_name='Changed' WHERE device_id='device-a'");
		const changed = await f.ready();
		const rotated = await new OwnerEnrollmentQualificationOps(
			f.backend,
			{ ...config, revision: "b".repeat(64) },
			() => NOW + 100,
		).preview(attestation);
		// Assert
		expect(changed.digest).not.toBe(p.digest);
		expect(rotated).toMatchObject({
			kind: "ready",
			digest: expect.not.stringMatching(`^${changed.digest}$`),
		});
		expect(await f.ops.issue({ ...attestation, expectedDigest: p.digest })).toEqual({
			kind: "rejected",
			error: "preview_changed",
		});
		expect(await f.rows()).toEqual([]);
		expect(await f.ops.issue({ ...attestation, expectedDigest: changed.digest })).toMatchObject({
			kind: "created",
		});
	});
}
function registerReviewSnapshots(test: Test) {
	test.for(["current", "review"] as const)(
		"rejects a changed %s enrollment Identity without an exact review snapshot",
		async (changed, { fixture: f }) => {
			// Arrange: NULL is a reviewed value, not a wildcard for the same actor.
			const p = await f.ready();
			if (changed === "current")
				await f.exec(
					"UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='device-a'",
				);
			else
				await f.corrupt(
					"coordinator_auth_controller_attestations",
					"enrollment_identity_id='identity-a'",
				);
			f.calls.length = 0;
			// Act
			const preview = await f.ops.preview(attestation);
			const issued = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
			// Assert: this mismatch denies before attempting the INSERT as well.
			expect(preview).toEqual(rejected);
			expect(issued).toEqual(rejected);
			expect(f.calls.some((s) => s.sql.startsWith(`INSERT INTO ${table}`))).toBe(false);
			expect(await f.rows()).toEqual([]);
		},
	);
	test("issues only after current enrollment and the exact reviewed Identity snapshot both match", async ({
		fixture: f,
	}) => {
		// Arrange
		const original = await f.ready();
		await f.exec("UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='device-a'");
		await f.corrupt(
			"coordinator_auth_controller_attestations",
			"enrollment_identity_id='identity-a'",
		);
		// Act
		const fresh = await f.ready();
		const stale = await f.ops.issue({ ...attestation, expectedDigest: original.digest });
		const issued = await f.ops.issue({ ...attestation, expectedDigest: fresh.digest });
		// Assert
		expect(fresh.digest).not.toBe(original.digest);
		expect(stale).toEqual({ kind: "rejected", error: "preview_changed" });
		expect(issued).toMatchObject({ kind: "created" });
		expect(await f.rows()).toEqual([
			expect.objectContaining({ enrollment_identity_id: "identity-a", identity_id: "identity-a" }),
		]);
	});
}

type Fault = { write?: "before_commit" | "after_commit"; read?: "before_write" | "after_write" };
export function faultedOperations(f: Fixture, fault: Fault) {
	let wrote = false;
	return new OwnerEnrollmentQualificationOps(
		{
			...f.backend,
			first: async <T>(s: AuthLinkStatement) => {
				if (fault.read === "before_write" || (wrote && fault.read === "after_write"))
					throw new Error("injected read failure");
				return f.backend.first<T>(s);
			},
			run: async (s) => {
				if (fault.write === "before_commit") throw new Error("injected write failure");
				const changes = await f.backend.run(s);
				wrote = true;
				if (fault.write === "after_commit") throw new Error("injected lost write response");
				return changes;
			},
		},
		config,
		() => NOW + 100,
	);
}
export function registerIssueFaults(
	test: Test,
	writes: readonly ("before_commit" | "after_commit")[],
) {
	test.for(writes)(
		"issue write fault %s reports unknown and exact retry cannot duplicate or reactivate",
		async (write, { fixture: f }) => {
			// Arrange
			const p = await f.ready();
			const before = await f.snapshot();
			const ops = faultedOperations(f, { write });
			// Act
			const unknown = await ops.issue({ ...attestation, expectedDigest: p.digest });
			const committed = await f.rows();
			const retry = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
			// Assert
			expect(unknown).toEqual({ kind: "outcome_unknown" });
			expect(committed).toHaveLength(write === "after_commit" ? 1 : 0);
			if (write === "after_commit")
				expect(retry).toEqual({
					kind: "existing",
					qualificationId: committed[0]?.qualification_id,
				});
			else expect(retry).toMatchObject({ kind: "created" });
			expect(await f.rows()).toHaveLength(1);
			expect(await f.snapshot()).toEqual(before);
			if (retry.kind !== "created" && retry.kind !== "existing") throw new Error("recovery failed");
			await f.ops.revoke({ qualificationId: retry.qualificationId, linkId: p.linkId });
			const revoked = await f.rows();
			expect(await f.ops.issue({ ...attestation, expectedDigest: p.digest })).toEqual({
				kind: "rejected",
				error: "qualification_conflict",
			});
			expect(await f.rows()).toEqual(revoked);
		},
	);
}
function registerRevocation(test: Test) {
	test("revokes only its exact pair, remains idempotent without the device/review and prevents reissue", async ({
		fixture: f,
	}) => {
		// Arrange
		const p = await f.ready();
		const created = await f.issue();
		const pair = { qualificationId: created.qualificationId, linkId: p.linkId };
		const before = (await f.rows())[0];
		// Act / Assert
		expect(await f.ops.revoke({ ...pair, linkId: "wrong-link" })).toEqual(rejected);
		expect(await f.ops.revoke({ ...pair, qualificationId: "wrong-id" })).toEqual(rejected);
		expect(await f.ops.revoke(pair)).toEqual({
			kind: "revoked",
			qualificationId: pair.qualificationId,
		});
		f.clock(NOW + 300);
		expect(await f.ops.revoke(pair)).toEqual({
			kind: "revoked",
			qualificationId: pair.qualificationId,
		});
		expect(await f.ops.issue({ ...attestation, expectedDigest: p.digest })).toMatchObject({
			kind: "rejected",
		});
		expect(await f.ops.preview(attestation)).toEqual({
			kind: "rejected",
			error: "qualification_conflict",
		});
		await f.exec("DELETE FROM enrolled_devices WHERE device_id='device-a'");
		await f.exec("DELETE FROM coordinator_auth_controller_attestations");
		expect(await f.ops.revoke(pair)).toEqual({
			kind: "revoked",
			qualificationId: pair.qualificationId,
		});
		expect(await f.rows()).toEqual([{ ...before, revoked_at_ms: NOW + 100 }]);
	});
}

export type Mutation = [string, (f: Fixture) => Promise<void>];
export function registerRaces(
	test: Test,
	{
		stages,
		mutations,
	}: { stages: readonly ("before preview" | "before INSERT")[]; mutations: Mutation[] },
) {
	for (const stage of stages) {
		test.for(mutations)(
			`${stage} denies $0 and writes no qualification`,
			async ([, mutate], { fixture: f }) => {
				// Arrange
				const p = await f.ready();
				let raced = false;
				let expected: Awaited<ReturnType<Fixture["snapshot"]>> = [];
				if (stage === "before INSERT")
					f.onInsert(async () => {
						raced = true;
						await mutate(f);
						expected = await f.snapshot();
					});
				else {
					await mutate(f);
					expected = await f.snapshot();
				}
				// Act
				const result = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
				// Assert: a real database mutation wins immediately before native execution.
				expect(result.kind).toBe("rejected");
				expect(await f.rows()).toEqual([]);
				expect(await f.snapshot()).toEqual(expected);
				if (stage === "before INSERT") expect(raced).toBe(true);
			},
		);
	}
}
