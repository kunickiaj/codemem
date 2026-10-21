import { expect, vi } from "vitest";
import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";
import { authDeviceClaimProvenanceSql } from "./coordinator-auth-link-provenance.js";
import {
	type OwnerAuthorityAttempt,
	ownerEnrollmentConfirmationHash,
} from "./coordinator-owner-enrollment-proof.js";
import { readOwnerLinkAuthority } from "./owner-enrollment-link-authority.js";
import type { qualifiedFixture, qualifiedTest } from "./owner-qualified-consumer-test-harness.js";

type Test = ReturnType<typeof qualifiedTest>;
type Consumer = Awaited<ReturnType<typeof qualifiedFixture>>;
const qualification = "coordinator_owner_enrollment_qualifications";
const attempts = "coordinator_owner_enrollment_attempts";

// Fixture-only corruption; restore exact definitions before running consumers.
async function corrupt(f: Consumer, table: string, assignment: string) {
	const result = await f.backend.first<{ definitions: string }>({
		sql: "SELECT json_group_array(json_object('name',name,'sql',sql)) AS definitions FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
		values: [table],
	});
	const triggers = JSON.parse(result?.definitions ?? "[]") as { name: string; sql: string }[];
	for (const t of triggers) await f.exec(`DROP TRIGGER ${t.name}`);
	try {
		await f.exec(`UPDATE ${table} SET ${assignment}`);
	} finally {
		for (const t of triggers) await f.exec(t.sql);
	}
}
export function registerAdversarialQualifiedConsumerTests(test: Test) {
	registerProvenance(test);
	registerSchema(test);
	registerAttemptPin(test);
	registerHistoricalRevocation(test);
	registerWrongAccount(test);
	registerCryptoRaces(test);
	registerHash(test);
	registerHistory(test);
	registerWinningUpdates(test);
	registerFinalPins(test);
}
function registerFinalPins(test: Test) {
	test.for(["substituted-pin", "dropped-qualification"])(
		"winning final batch denies %s",
		async (fault, { fixture: f }) => {
			// Arrange
			await f.qualify();
			await f.grant();
			const final = await f.confirmed();
			const batch = f.backend.batch.bind(f.backend);
			let entered = false;
			vi.spyOn(f.backend, "batch").mockImplementationOnce(async (s) => {
				entered = true;
				if (fault === "substituted-pin")
					await corrupt(f, attempts, "owner_qualification_id='different'");
				else await f.exec(`DROP TABLE ${qualification}`);
				return batch(s);
			});
			// Act
			const result = await f.api.finalize(final);
			// Assert
			expect(entered).toBe(true);
			expect(result).toMatchObject({ kind: "rejected" });
			expect(await f.rows("coordinator_device_ownership_bindings")).toEqual([]);
			expect(await f.attempt()).toMatchObject({
				state: "confirmed",
				binding_id: null,
				final_outcome_json: null,
			});
		},
	);
}
function registerSchema(test: Test) {
	test("complete explicitly installed schema enables qualified claims", async ({ fixture: f }) => {
		// Arrange
		await f.qualify();
		// Act
		const result = await readOwnerLinkAuthority(f.backend, 1791028800000);
		// Assert: this also exercises the exact table left by official native migration 0036.
		expect(result.hasPin).toBe(true);
		expect(result.with, "canonical migrated 0036 and 0035 definitions must be accepted").not.toBe(
			"",
		);
	});
	test.for([
		"DROP TRIGGER owner_enrollment_qualification_immutable_update",
		"DROP TRIGGER owner_enrollment_authority_update",
		"DROP TABLE coordinator_owner_enrollment_qualifications",
		"DROP TABLE coordinator_auth_account_connection_history",
	])("partial storage denies without fallback or auto-install: %s", async (sql, { fixture: f }) => {
		// Arrange
		await f.qualify();
		await f.grant();
		await f.exec(sql);
		const before = await definitions(f);
		// Act
		const response = await f.admit();
		// Assert
		expect(response?.status).not.toBe(200);
		expect(await f.rows(attempts)).toEqual([]);
		expect(await definitions(f)).toEqual(before);
	});
	test.for([
		["owner_enrollment_qualification_immutable_update", qualification],
		["owner_enrollment_authority_update", attempts],
	])(
		"same-named future guard %j denies without repairing schema",
		async ([name, table], { fixture: f }) => {
			// Arrange
			await f.qualify();
			await f.grant();
			await f.exec(`DROP TRIGGER ${name}`);
			await f.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT 1; END`);
			const before = await definitions(f);
			// Act
			const response = await f.admit();
			// Assert
			expect(response?.status).not.toBe(200);
			expect(await definitions(f)).toEqual(before);
		},
	);
}
function registerWinningUpdates(test: Test) {
	for (const stage of ["callback", "confirm"] as const) {
		test.for(["qualification", "drop-qualification", "link", "grant"])(
			`${stage} winning UPDATE denies %s drift`,
			async (fault, { fixture: f }) => {
				// Arrange: hook only scheduling, then execute the original SQL.
				await f.qualify();
				await f.grant();
				const transition = await nextBrowserTransition(f, stage);
				const run = f.backend.run.bind(f.backend);
				let entered = false;
				vi.spyOn(f.backend, "run").mockImplementation(async (s) => {
					if (
						!entered &&
						s.sql.includes(`SET state = '${stage === "callback" ? "oidc_verified" : "confirmed"}'`)
					) {
						entered = true;
						await drift(f, fault);
					}
					return run(s);
				});
				// Act
				const result = await transition();
				// Assert
				expect(entered).toBe(true);
				expect(result).toMatchObject({ kind: "rejected" });
				expect(await f.rows("coordinator_device_ownership_bindings")).toEqual([]);
			},
		);
	}
}
async function nextBrowserTransition(f: Consumer, stage: "callback" | "confirm") {
	if (stage === "callback") {
		const c = await f.claim();
		return () => f.api.verifyCallback(c.request());
	}
	const v = await f.verified();
	return () => f.api.confirm(v.request(), "browser-b", v.result.confirmation.confirmationHash);
}
async function drift(f: Consumer, fault: string) {
	if (fault === "qualification")
		return f.exec(`UPDATE ${qualification} SET revoked_at_ms=?`, 1791028800000);
	if (fault === "drop-qualification") return f.exec(`DROP TABLE ${qualification}`);
	if (fault === "link")
		return f.exec("UPDATE coordinator_auth_account_links SET revoked_at_ms=?", 1791028800000);
	return f.exec("UPDATE coordinator_identity_group_grants SET revision=revision+1");
}
function registerWrongAccount(test: Test) {
	test("rejects another freshly verified account after qualified admission", async ({
		fixture: f,
	}) => {
		// Arrange
		await f.qualify();
		await f.grant();
		const claim = await f.claim();
		f.provider.claims.sub = "different-account";
		// Act
		const result = await f.api.verifyCallback(claim.request());
		// Assert
		expect(result).toMatchObject({ kind: "rejected" });
		expect(await f.attempt()).toMatchObject({
			account_subject: null,
			identity_id: null,
			link_id: null,
		});
		expect(await f.rows("coordinator_device_ownership_bindings")).toEqual([]);
	});
}
function registerHistoricalRevocation(test: Test) {
	test.for(["device_id", "ed25519_key"])(
		"old A global %s revocation retains qualified authority",
		async (kind, { fixture: f }) => {
			// Arrange: qualification and independent grant predate revocation.
			await f.qualify();
			await f.grant();
			const row = (await f.rows(qualification))[0];
			await f.exec(
				"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,'old-a-revocation','group-a','old-device-a',?,?,?)",
				kind,
				String(kind === "device_id" ? row?.device_id : row?.key_id),
				String(row?.public_key),
				String(row?.fingerprint),
				new Date(1791028800000).toISOString(),
			);
			// Act
			const result = await f.api.finalize(await f.confirmed());
			// Assert: retained owner authority is not fresh grant issuance from old A.
			expect(result).toMatchObject({ kind: "finalized", identityId: "identity-a" });
			expect(await f.authority()).toEqual(f.original);
		},
	);
}
function registerCryptoRaces(test: Test) {
	test.for(["qualification", "link", "grant"])(
		"revoking %s during real final signature verification wins",
		async (fault, { fixture: f }) => {
			// Arrange: interleave the real verifier; never replace verification success.
			await f.qualify();
			await f.grant();
			const final = await f.confirmed();
			const verify = crypto.subtle.verify.bind(crypto.subtle);
			let entered = false;
			vi.spyOn(crypto.subtle, "verify").mockImplementationOnce(async (...args) => {
				entered = true;
				if (fault === "qualification")
					await f.exec(`UPDATE ${qualification} SET revoked_at_ms=?`, 1791028800000);
				if (fault === "link")
					await f.exec("UPDATE coordinator_auth_account_links SET revoked_at_ms=?", 1791028800000);
				if (fault === "grant")
					await f.exec("UPDATE coordinator_identity_group_grants SET revision=revision+1");
				return verify(...args);
			});
			// Act
			const result = await f.api.finalize(final);
			// Assert
			expect(entered).toBe(true);
			expect(result).toMatchObject({ kind: "rejected" });
			expect(await f.rows("coordinator_device_ownership_bindings")).toEqual([]);
		},
	);
}
function registerHash(test: Test) {
	test("qualified hash adds the domain and ID without changing exact legacy bytes", async ({
		fixture: f,
	}) => {
		// Arrange: encode the frozen field order independently of production code.
		await f.qualify();
		await f.grant();
		await f.verified();
		const a = (await f.attempt()) as OwnerAuthorityAttempt;
		const fields = frozenConfirmationFields(a);
		const controllerFields = [...fields];
		controllerFields[12] = "original-controller";
		const old = JSON.stringify(["owner_enroll", ...controllerFields, a.admission_owner_hash]);
		const qualified = JSON.stringify([
			"owner_enroll",
			...fields,
			a.admission_owner_hash,
			"codemem.owner-enrollment.qualification.v1",
			a.owner_qualification_id,
		]);
		// Act
		const controller = {
			...a,
			link_controller_attestation_id: "original-controller",
			owner_qualification_id: null,
		};
		const oldResult = await ownerEnrollmentConfirmationHash(controller);
		const result = await ownerEnrollmentConfirmationHash(a);
		// Assert
		expect(oldResult).toBe(await hash(old));
		expect(
			await ownerEnrollmentConfirmationHash({ ...controller, admission_owner_hash: null }),
		).toBe(await hash(JSON.stringify(["owner_enroll", ...controllerFields])));
		expect(result).toBe(await hash(qualified));
		expect(result).not.toBe(oldResult);
		expect(
			await ownerEnrollmentConfirmationHash({ ...a, owner_qualification_id: "different" }),
		).not.toBe(result);
	});
}
function frozenConfirmationFields(a: OwnerAuthorityAttempt) {
	return [
		a.coordinator_id,
		a.attempt_id,
		a.origin,
		a.device_id,
		a.public_key,
		a.key_id,
		a.fingerprint,
		a.issuer,
		a.account_subject,
		a.identity_id,
		a.link_id,
		a.link_attempt_id,
		a.link_controller_attestation_id,
		a.link_auth_config_revision,
		a.auth_config_revision,
		a.browser_start_hash,
		a.browser_transaction_hash,
		a.browser_binder_hash,
		a.grant_revisions_json,
		a.created_at_ms,
		a.expires_at_ms,
	];
}
async function hash(text: string) {
	return Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
	).toString("hex");
}
function registerHistory(test: Test) {
	test.for([false, true])(
		"disconnect history prevents qualification inheritance (relink=%s)",
		async (relink, { fixture: f }) => {
			// Arrange: exact issued qualification is tied to the original live link.
			await f.qualify();
			await f.grant();
			const claim = await f.claim();
			await endConnection(f, relink);
			// Act
			const response = await f.api.verifyCallback(claim.request());
			// Assert: an otherwise valid continuation cannot inherit the old qualification.
			expect(response).toMatchObject({ kind: "rejected" });
			expect(await f.attempt()).toMatchObject({ identity_id: null, link_id: null });
			expect(await f.rows(qualification)).toHaveLength(1);
		},
	);
}
async function endConnection(f: Consumer, relink: boolean) {
	const history = "coordinator_auth_account_connection_history";
	const current = "coordinator_auth_account_links";
	const columns = [...CONNECTION_BIRTH_COLUMNS, "signin_floor"].join(",");
	const result = await f.backend.first<{ definitions: string }>({
		sql: "SELECT json_group_array(json_object('name',name,'sql',sql)) AS definitions FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name LIKE 'account_change_%'",
		values: [history],
	});
	const guards = JSON.parse(result?.definitions ?? "[]") as { name: string; sql: string }[];
	for (const t of guards) await f.exec(`DROP TRIGGER ${t.name}`);
	try {
		await f.exec(
			`INSERT INTO ${history} (${columns},original_rowid,ended_at_ms,end_attempt_id) SELECT ${columns},rowid,1791028800000,'end-a' FROM ${current}`,
		);
	} finally {
		for (const t of guards) await f.exec(t.sql);
	}
	await f.exec(`DELETE FROM ${current}`);
	if (!relink) return;
	const replace = (c: string) => {
		if (c === "link_id") return "'relinked'";
		if (c === "attempt_id") return "'relink-attempt'";
		if (c === "prior_link_id") return `'${String(f.link.link_id)}'`;
		if (
			[
				"browser_start_hash",
				"runtime_verifier_hash",
				"browser_transaction_hash",
				"completion_secret_hash",
			].includes(c)
		)
			return `'${"9".repeat(64)}'`;
		return c;
	};
	await f.exec(
		`INSERT INTO ${current} (${columns}) SELECT ${[...CONNECTION_BIRTH_COLUMNS, "signin_floor"].map(replace).join(",")} FROM ${history}`,
	);
	await f.exec(`UPDATE ${history} SET successor_link_id='relinked'`);
	for (const table of ["coordinator_auth_link_attempts", "coordinator_auth_link_audit_log"]) {
		const info = await f.backend.first<{ columns: string }>({
			sql: `SELECT json_group_array(name) AS columns FROM pragma_table_info('${table}')`,
			values: [],
		});
		const names = JSON.parse(info?.columns ?? "[]") as string[];
		await f.exec(
			`INSERT INTO ${table} (${names.join(",")}) SELECT ${names.map(replace).join(",")} FROM ${table}`,
		);
	}
	expect(
		await f.backend.first({
			sql: `SELECT ${authDeviceClaimProvenanceSql({ link: "l", connections: true })} AS valid FROM ${current} l`,
			values: [],
		}),
	).toEqual({ valid: 1 });
}
function definitions(f: Consumer) {
	return f.backend.first({
		sql: "SELECT json_group_array(sql) AS definitions FROM (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name)",
		values: [],
	});
}
function registerAttemptPin(test: Test) {
	test.for([
		"owner_qualification_id=NULL",
		"owner_qualification_id='different'",
		"link_controller_attestation_id='review-a',owner_qualification_id=NULL",
	])("pins nullable qualification against raw mutation %s", async (assignment, { fixture: f }) => {
		// Arrange
		const id = await f.qualify();
		await f.grant();
		await f.verified();
		const before = await f.attempt();
		// Act / Assert: same-value retry is legal; substitution is not.
		await f.exec(`UPDATE ${attempts} SET owner_qualification_id=?`, id);
		await expect(f.exec(`UPDATE ${attempts} SET ${assignment}`)).rejects.toThrow();
		expect(await f.attempt()).toEqual(before);
	});
}
function registerProvenance(test: Test) {
	test.for([
		"coordinator_id='other'",
		"link_id='other'",
		"device_claim_id='other'",
		"identity_id='other'",
		"source_group_id='other'",
		"device_id='other'",
		"public_key='other'",
		`fingerprint='${"2".repeat(64)}'`,
		`key_id='${"2".repeat(64)}'`,
		"controller_attestation_id='other'",
		"controller_attestation_created_at='other'",
		"review_receipt_id='other'",
		`evidence_digest='${"2".repeat(64)}'`,
		"enrollment_identity_id='identity-a'",
		"link_attempt_id='other'",
		`link_auth_config_revision='${"2".repeat(64)}'`,
		"link_created_at_ms=link_created_at_ms-1",
		"created_at_ms=created_at_ms+1",
	])("denies mismatched qualification birth %s", async (assignment, { fixture: f }) => {
		// Arrange: real issuance and a separate grant are the positive control.
		await f.qualify();
		await f.grant();
		await corrupt(f, qualification, assignment);
		const rows = await f.rows(qualification);
		// Act
		const response = await f.admit();
		// Assert: no replacement qualification or new attempt.
		expect(response?.status).not.toBe(200);
		expect(await f.rows(attempts)).toEqual([]);
		expect(await f.rows(qualification)).toEqual(rows);
		expect(await f.authority()).toEqual(f.original);
	});
}
