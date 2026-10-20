import { expect, vi } from "vitest";
import type { AuthLinkBackend } from "../../core/src/coordinator-auth-link.js";
import { EXPECTED_KEY_ID } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { type Context, Hono } from "../../core/src/coordinator-hono-test-fixtures.js";
import { COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL } from "../../core/src/coordinator-owner-enrollment-schema.js";
import {
	createOwnerQualificationHandler,
	type OwnerQualificationRouteDeps,
	ownerQualificationAttemptDefinitionChecks,
} from "../../core/src/coordinator-owner-qualification-route.js";
import { config, input, NOW, otherKey } from "./device-claim-eligibility-fixture.js";
import {
	type Fixture,
	type Test,
	table,
} from "./owner-enrollment-qualification-ops-test-harness.js";

const attemptTable = "coordinator_owner_enrollment_attempts";
const reviewId = `controller-v1:${"c".repeat(64)}`;
const body = { attestation_id: reviewId };
const secret = "fixture-admin-credential";
type Migration = { name: string; queries: string[] };

async function migrate(f: Fixture, migrations: Migration[], options = { current: true }) {
	const objects = await f.query(
		`SELECT type,name FROM sqlite_master WHERE tbl_name='${attemptTable}' AND sql IS NOT NULL ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`,
	);
	for (const o of objects) await f.exec(`DROP ${String(o.type).toUpperCase()} "${o.name}"`);
	const names = ["0030_add_owner_enrollment_attempts.sql", "0034_add_owner_admission_pin.sql"];
	if (options.current) names.push("0036_add_owner_attempt_qualification_pin.sql");
	for (const name of names) {
		const migration = migrations.find((m) => m.name === name);
		if (!migration) throw new Error(`Missing fixture migration ${name}`);
		await f.backend.batch(migration.queries.map((sql) => ({ sql, values: [] })));
		if (name === "0034_add_owner_admission_pin.sql")
			await f.exec(
				`INSERT INTO ${attemptTable} (coordinator_id,attempt_id,purpose,origin,device_id,public_key,key_id,fingerprint,issuer,auth_config_revision,loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms) VALUES ('coordinator-a','existing-owner-attempt','owner_enroll','https://coordinator.example.test','device-a','${input.signer.publicKey}','${EXPECTED_KEY_ID}','${input.signer.fingerprint}','${config.issuer}','${config.revision}','http://127.0.0.1:4567/complete','${"e".repeat(64)}','pending',${NOW},${NOW + 600000})`,
			);
	}
}

function app(f: Fixture, overrides: Partial<OwnerQualificationRouteDeps> = {}) {
	const read = vi.fn(async (c: Context, limit: number) => {
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		return bytes.byteLength > limit ? null : bytes;
	});
	const parse = vi.fn((bytes: Uint8Array) => {
		try {
			const value = JSON.parse(new TextDecoder().decode(bytes));
			return value && typeof value === "object" && !Array.isArray(value) ? value : null;
		} catch {
			return null;
		}
	});
	const rate = vi.fn(() => null);
	const router = new Hono();
	router.post(
		"/qualification",
		createOwnerQualificationHandler({
			backend: f.backend,
			config,
			adminSecret: () => secret,
			readRequestBytes: read,
			parseJsonObject: parse,
			rateLimitedResponse: rate,
			...overrides,
		}),
	);
	return {
		read,
		parse,
		rate,
		request: (data: unknown = body, credential: string | null = secret) =>
			router.request("http://fixture.test/qualification", {
				method: "POST",
				headers: credential === null ? {} : { "X-Codemem-Coordinator-Admin": credential },
				body: typeof data === "string" ? data : JSON.stringify(data),
			}),
	};
}

async function preview(a: ReturnType<typeof app>) {
	const response = await a.request();
	expect(response.status).toBe(200);
	return response.json() as Promise<{ evidence_digest: string }>;
}
async function proof(f: Fixture) {
	const p = await f.ops.preview({ attestationId: reviewId });
	if (p.kind !== "ready") throw new Error(`Real fixture proof rejected: ${JSON.stringify(p)}`);
	return p;
}
function confirm(digest: string) {
	return { ...body, confirm_evidence_digest: digest };
}
function safe(response: Response, value: unknown) {
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	for (const privateValue of [
		secret,
		"private-claim-subject",
		input.signer.publicKey,
		"provider-access-token",
		"backend-sensitive-error",
	])
		expect(JSON.stringify(value)).not.toContain(privateValue);
}

export function registerOwnerQualificationRouteTests(test: Test, migrations: Migration[]) {
	test.beforeEach(async ({ fixture: f }) => {
		vi.spyOn(Date, "now").mockReturnValue(NOW + 100);
		await migrate(f, migrations);
		await f.corrupt("coordinator_auth_controller_attestations", `attestation_id='${reviewId}'`);
	});
	test.afterEach(() => vi.restoreAllMocks());
	registerMigratedDefinition(test);
	registerIssuance(test);
	registerAuthorization(test);
	registerConfiguration(test);
	registerInput(test);
	registerLimits(test);
	registerStaleConfirmation(test);
	registerSchemaTests(test, migrations);
	registerSchemaStatusTests(test);
	registerRaceTests(test);
	registerFaultTests(test);
}
function registerMigratedDefinition(test: Test) {
	test("accepts every exact owner-attempt definition produced by explicit migration 0036", async ({
		fixture: f,
	}) => {
		// Arrange
		const checks = ownerQualificationAttemptDefinitionChecks;
		// Act
		const results = await Promise.all(
			checks.map(async (check) => ({
				name: check.name,
				rows: await f.query(`SELECT (${check.matches}) AS ready`),
			})),
		);
		// Assert
		expect(results).toEqual(checks.map((check) => ({ name: check.name, rows: [{ ready: 1 }] })));
		// Arrange: replace isolated migrated storage with the canonical fresh spelling.
		await f.exec(`DROP TABLE ${attemptTable}`);
		await f.backend.batch(
			COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL.replace(/^--[^\n]*$/gm, "")
				.trim()
				.split(/\n(?=CREATE )/u)
				.map((sql) => ({ sql, values: [] })),
		);
		// Act
		const fresh = await Promise.all(
			checks.map((check) => f.query(`SELECT (${check.matches}) AS ready`)),
		);
		// Assert
		expect(fresh).toEqual(checks.map(() => [{ ready: 1 }]));
		for (const altered of [
			COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL.replace(
				"purpose = 'owner_enroll'",
				"purpose IN ('owner_enroll','other')",
			),
			COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL.replace(
				"link_controller_attestation_id IS NOT NULL AND owner_qualification_id IS NULL",
				"link_controller_attestation_id IS NOT NULL",
			),
			COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL.replace(
				"purpose = 'owner_enroll'",
				`purpose = '"owner_enroll"'`,
			),
		]) {
			// Arrange: normalization must not erase CHECK, authority-XOR, or quoted literal changes.
			await f.exec(`DROP TABLE ${attemptTable}`);
			await f.backend.batch(
				altered
					.replace(/^--[^\n]*$/gm, "")
					.trim()
					.split(/\n(?=CREATE )/u)
					.map((sql) => ({ sql, values: [] })),
			);
			// Act
			const changed = await Promise.all(
				checks.map((check) => f.query(`SELECT (${check.matches}) AS ready`)),
			);
			// Assert
			expect(changed).toEqual(checks.map((_, index) => [{ ready: index === 0 ? 0 : 1 }]));
			expect((await app(f).request()).status).toBe(503);
			expect(await f.rows()).toEqual([]);
		}
	});
}
function registerIssuance(test: Test) {
	test("previews without writes and explicitly confirms one immutable qualification on the original device claim", async ({
		fixture: f,
	}) => {
		// Arrange: fixture has real validated proof, no owner grant for identity-a.
		const a = app(f);
		const before = await f.snapshot();
		const attempts = await f.rows(attemptTable);
		// Act
		const response = await a.request();
		const p = (await response.json()) as { evidence_digest: string };
		// Assert
		expect(response.status).toBe(200);
		expect(p).toEqual({
			state: "ready",
			coordinator_id: config.coordinatorId,
			evidence_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
			attestation_id: reviewId,
			review_receipt_id: "receipt-a",
			link_id: "claim-a",
			claim_id: "claim-a",
			identity_id: "identity-a",
			group_id: "group-a",
			device_id: "device-a",
			fingerprint: input.signer.fingerprint,
		});
		safe(response, p);
		expect(await f.rows()).toEqual([]);
		expect(await f.snapshot()).toEqual(before);
		const created = await a.request(confirm(p.evidence_digest));
		const receipt = (await created.json()) as Record<string, unknown>;
		expect(created.status).toBe(201);
		expect(receipt).toEqual({
			state: "created",
			qualification_id: expect.any(String),
			attestation_id: body.attestation_id,
			coordinator_id: config.coordinatorId,
			evidence_digest: p.evidence_digest,
		});
		safe(created, receipt);
		const retry = await a.request(confirm(p.evidence_digest));
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual({ ...receipt, state: "existing" });
		expect(await f.rows()).toEqual([
			expect.objectContaining({
				qualification_id: receipt.qualification_id,
				link_id: "claim-a",
				device_claim_id: "claim-a",
				controller_attestation_id: reviewId,
			}),
		]);
		await expect(f.exec(`UPDATE ${table} SET link_id='replacement'`)).rejects.toThrow();
		expect(await f.snapshot()).toEqual(before);
		expect(await f.rows(attemptTable)).toEqual(attempts);
	});
}
function registerAuthorization(test: Test) {
	test.for([null, "wrong", "x".repeat(8193)])(
		"denies invalid admin credential before reading body or store: %s",
		async (credential, { fixture: f }) => {
			// Arrange
			const a = app(f);
			f.calls.length = 0;
			// Act
			const response = await a.request("invalid-json", credential);
			// Assert
			expect(response.status).toBe(401);
			safe(response, await response.json());
			expect(a.read).not.toHaveBeenCalled();
			expect(a.parse).not.toHaveBeenCalled();
			expect(f.calls).toEqual([]);
		},
	);
	test("rate limits an authenticated request before body/store access", async ({ fixture: f }) => {
		// Arrange
		const a = app(f, { rateLimitedResponse: (c) => c.json({ error: "rate_limited" }, 429) });
		f.calls.length = 0;
		// Act
		const response = await a.request();
		// Assert
		expect(response.status).toBe(429);
		expect(a.read).not.toHaveBeenCalled();
		expect(f.calls).toEqual([]);
	});
}
function registerConfiguration(test: Test) {
	test.for([
		{ enabled: false },
		{ coordinatorId: "foreign" },
		{ issuer: "https://foreign.example.test" },
		{ revision: "" },
	])("denies missing or foreign trusted configuration %j", async (changes, { fixture: f }) => {
		// Arrange
		const a = app(f, { config: { ...config, ...changes } });
		// Act
		const response = await a.request(confirm((await proof(f)).digest));
		// Assert
		expect([409, 503]).toContain(response.status);
		safe(response, await response.json());
		expect(await f.rows()).toEqual([]);
	});
}
function registerInput(test: Test) {
	test.for([
		"{",
		"null",
		"[]",
		{},
		{ attestation_id: "" },
		{ attestation_id: "attestation-a" },
		{ attestation_id: "x".repeat(257) },
		{ attestation_id: "a\u0000b" },
		{ ...body, confirm_evidence_digest: null },
		{ ...body, confirm_evidence_digest: "A".repeat(64) },
		...["link_id", "identity_id", "actor", "subject", "provider_token"].map((key) => ({
			...body,
			[key]: "forbidden",
		})),
	])(
		"rejects malformed or caller-nominated fields %j before store access",
		async (data, { fixture: f }) => {
			// Arrange
			const a = app(f);
			f.calls.length = 0;
			// Act
			const response = await a.request(data);
			// Assert
			expect(response.status).toBe(400);
			safe(response, await response.json());
			expect(f.calls).toEqual([]);
			expect(await f.rows()).toEqual([]);
		},
	);
}
function registerLimits(test: Test) {
	test.for([4096, 4097])(
		"enforces the exact request byte limit %i",
		async (length, { fixture: f }) => {
			// Arrange
			const a = app(f);
			const json = JSON.stringify(body);
			const data = json + " ".repeat(length - json.length);
			// Act
			const response = await a.request(data);
			// Assert
			expect(response.status).toBe(length === 4096 ? 200 : 413);
			expect(await f.rows()).toEqual([]);
		},
	);
}
function registerStaleConfirmation(test: Test) {
	test.for([
		"digest",
		"config",
		"enrollment",
		"revoked-review",
		"revoked-qualification",
		"disconnected-link",
	])("rejects stale confirmation: %s", async (change, { fixture: f }) => {
		// Arrange
		let a = app(f);
		const p = await preview(a);
		let digest = p.evidence_digest;
		if (change === "digest") digest = "f".repeat(64);
		if (change === "config") a = app(f, { config: { ...config, revision: "b".repeat(64) } });
		if (change === "enrollment")
			await f.exec("UPDATE enrolled_devices SET display_name='changed' WHERE device_id='device-a'");
		if (change === "revoked-review")
			await f.exec(
				`UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked' WHERE attestation_id='${reviewId}'`,
			);
		if (change === "disconnected-link") await f.end();
		if (change === "revoked-qualification") {
			const issued = await f.ops.issue({
				attestationId: reviewId,
				expectedDigest: p.evidence_digest,
			});
			if (issued.kind !== "created") throw new Error("Fixture issue failed");
			await f.ops.revoke({ qualificationId: issued.qualificationId, linkId: "claim-a" });
		}
		const before = await f.rows();
		// Act
		const response = await a.request(confirm(digest));
		// Assert
		expect(response.status).toBe(409);
		safe(response, await response.json());
		expect(await f.rows()).toEqual(before);
	});
}

function registerSchemaTests(test: Test, migrations: Migration[]) {
	test.for([
		"missing-0035",
		"rowid-0035",
		"missing-0036",
		"owner_enrollment_authority_insert",
		"owner_enrollment_authority_update",
		"tampered-trigger",
		"future-column",
		"partial-connection",
	])(
		"fails closed without repairing noncanonical storage: %s",
		async (mutation, { fixture: f }) => {
			// Arrange
			const digest = (await preview(app(f))).evidence_digest;
			await mutateSchema(f, migrations, mutation);
			if (["missing-0035", "rowid-0035", "partial-connection"].includes(mutation))
				await assertAttemptReady(f);
			const schema = await f.query(
				"SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name",
			);
			const a = app(f);
			// Act
			const response = await a.request(confirm(digest));
			// Assert
			expect(response.status).toBe(503);
			expect(await response.clone().json()).toEqual({ error: "qualification_unavailable" });
			await assertSchemaUnavailable(await a.request());
			safe(response, await response.json());
			expect(
				await f.query("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"),
			).toEqual(schema);
			if (mutation !== "missing-0035") expect(await f.rows()).toEqual([]);
			expect(f.calls.some((s) => s.sql.startsWith(`INSERT INTO ${table}`))).toBe(false);
		},
	);
}
async function mutateSchema(f: Fixture, migrations: Migration[], mutation: string) {
	if (mutation === "missing-0035") await f.exec(`DROP TABLE ${table}`);
	if (mutation === "rowid-0035") {
		const definitions = await f.query(
			`SELECT sql FROM sqlite_master WHERE tbl_name='${table}' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`,
		);
		await f.exec(`DROP TABLE ${table}`);
		for (const row of definitions) await f.exec(String(row.sql).replace(/WITHOUT ROWID/iu, ""));
	}
	if (mutation === "missing-0036") await migrate(f, migrations, { current: false });
	if (mutation.startsWith("owner_enrollment_authority_")) await f.exec(`DROP TRIGGER ${mutation}`);
	if (mutation === "tampered-trigger") {
		await f.exec("DROP TRIGGER owner_enrollment_authority_update");
		await f.exec(
			`CREATE TRIGGER owner_enrollment_authority_update BEFORE UPDATE ON ${attemptTable} BEGIN SELECT 1; END`,
		);
	}
	if (mutation === "future-column")
		await f.exec(`ALTER TABLE ${attemptTable} ADD COLUMN future_pin TEXT`);
	if (mutation === "partial-connection")
		await f.exec("DROP TABLE coordinator_auth_account_connection_history");
}

async function assertAttemptReady(f: Fixture) {
	const checks = ownerQualificationAttemptDefinitionChecks
		.map((check) => `(${check.matches})`)
		.join(" AND ");
	expect(await f.query(`SELECT (${checks}) AS ready`)).toEqual([{ ready: 1 }]);
}
async function invalidateOpsSchema(f: Fixture, mutation: string) {
	if (mutation === "qualification-trigger")
		await f.exec("DROP TRIGGER owner_enrollment_qualification_insert_active");
	if (mutation === "connection-column")
		await f.exec(
			"ALTER TABLE coordinator_auth_account_connection_history RENAME COLUMN signin_floor TO wrong_signin_floor",
		);
}
async function assertSchemaUnavailable(response: Response) {
	expect(response.status).toBe(503);
	const value = await response.json();
	expect(value).toEqual({ error: "qualification_unavailable" });
	safe(response, value);
}
function registerSchemaStatusTests(test: Test) {
	registerPartialOpsSchema(test);
	registerOpsSchemaRaces(test);
	registerHealthyEvidenceDenials(test);
}
function registerPartialOpsSchema(test: Test) {
	test.for(["qualification-trigger", "connection-column"])(
		"reports partial Ops schema %s as unavailable for preview and confirmation with canonical 0036",
		async (mutation, { fixture: f }) => {
			// Arrange
			const a = app(f);
			const digest = (await preview(a)).evidence_digest;
			await invalidateOpsSchema(f, mutation);
			await assertAttemptReady(f);
			f.calls.length = 0;
			// Act
			const responses = [await a.request(), await a.request(confirm(digest))];
			// Assert
			for (const response of responses) await assertSchemaUnavailable(response);
			expect(await f.rows()).toEqual([]);
			expect(f.calls.some((s) => s.sql.startsWith(`INSERT INTO ${table}`))).toBe(false);
		},
	);
}
function registerOpsSchemaRaces(test: Test) {
	test.for(["qualification-trigger", "connection-column"])(
		"rechecks schema status when %s becomes invalid after the successful preflight",
		async (mutation, { fixture: f }) => {
			// Arrange
			const digest = (await preview(app(f))).evidence_digest;
			await assertAttemptReady(f);
			for (const data of [body, confirm(digest)]) {
				const definitions = await f.query(
					"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name",
				);
				let qualificationChecks = 0;
				let readsAfterInvalidation = 0;
				f.calls.length = 0;
				const backend: AuthLinkBackend = {
					...f.backend,
					first: async <T>(s: Parameters<AuthLinkBackend["first"]>[0]) => {
						if (qualificationChecks > 0) readsAfterInvalidation++;
						const result = await f.backend.first<T>(s);
						if (
							s.sql.startsWith("SELECT (") &&
							s.sql.includes("owner_enrollment_qualification_insert_active")
						) {
							qualificationChecks++;
							if (qualificationChecks === 1) await invalidateOpsSchema(f, mutation);
						}
						return result;
					},
				};
				// Act
				const response = await app(f, { backend }).request(data);
				// Assert
				await assertSchemaUnavailable(response);
				expect(qualificationChecks).toBeGreaterThanOrEqual(1);
				expect(readsAfterInvalidation).toBeGreaterThanOrEqual(2);
				expect(await f.rows()).toEqual([]);
				expect(f.calls.some((s) => s.sql.startsWith(`INSERT INTO ${table}`))).toBe(false);
				// Restore only the fixture mutation before checking the other request mode.
				if (mutation === "connection-column")
					await f.exec(
						"ALTER TABLE coordinator_auth_account_connection_history RENAME COLUMN wrong_signin_floor TO signin_floor",
					);
				else {
					const trigger = definitions.find(
						(row) => row.name === "owner_enrollment_qualification_insert_active",
					);
					await f.exec(String(trigger?.sql));
				}
			}
		},
	);
}
function registerHealthyEvidenceDenials(test: Test) {
	test.for(["missing-review", "revoked-review", "missing-link", "revoked-link"])(
		"keeps healthy-schema %s evidence denial distinct from schema unavailability",
		async (mutation, { fixture: f }) => {
			// Arrange
			const a = app(f);
			const digest = (await preview(a)).evidence_digest;
			let reference = body;
			if (mutation === "missing-review")
				reference = { attestation_id: `controller-v1:${"d".repeat(64)}` };
			if (mutation === "revoked-review")
				await f.exec(
					`UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked' WHERE attestation_id='${reviewId}'`,
				);
			if (mutation === "missing-link") await f.end();
			if (mutation === "revoked-link")
				await f.exec(`UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW + 1}`);
			await assertAttemptReady(f);
			f.calls.length = 0;
			// Act
			const responses = [
				await a.request(reference),
				await a.request({ ...reference, confirm_evidence_digest: digest }),
			];
			// Assert
			for (const response of responses) {
				expect(response.status).toBe(409);
				const value = await response.json();
				expect(value).toEqual({ error: "unavailable" });
				safe(response, value);
			}
			expect(await f.rows()).toEqual([]);
			expect(f.calls.some((s) => s.sql.startsWith(`INSERT INTO ${table}`))).toBe(false);
		},
	);
}

function registerRaceTests(test: Test) {
	test("does not require a transport grant or let an unrelated grant change block qualification", async ({
		fixture: f,
	}) => {
		// Arrange: the source identity has no grant; qualification is independent of target authority.
		const a = app(f);
		const p = await preview(a);
		const grants = await f.rows("coordinator_identity_group_grants");
		expect(grants.every((grant) => grant.identity_id !== "identity-a")).toBe(true);
		f.onInsert(() =>
			f.exec(
				"UPDATE coordinator_identity_group_grants SET status='revoked',revision=revision+1,revoked_at='revoked' WHERE identity_id='unrelated-identity'",
			),
		);
		// Act
		const response = await a.request(confirm(p.evidence_digest));
		// Assert
		expect(response.status).toBe(201);
		expect(await f.rows()).toHaveLength(1);
		expect(await f.rows("coordinator_identity_group_grants")).toEqual(
			grants.map((grant) => ({
				...grant,
				status: "revoked",
				revision: Number(grant.revision) + 1,
				revoked_at: "revoked",
			})),
		);
	});
	test.for(["device", "key", "controller", "link", "enrollment"])(
		"rechecks %s at the winning native INSERT",
		async (mutation, { fixture: f }) => {
			// Arrange
			const a = app(f);
			const p = await preview(a);
			f.onInsert(() => raceMutation(f, mutation));
			// Act
			const response = await a.request(confirm(p.evidence_digest));
			// Assert
			expect(response.status).toBe(409);
			safe(response, await response.json());
			expect(await f.rows()).toEqual([]);
		},
	);
}
async function raceMutation(f: Fixture, mutation: string) {
	if (mutation === "device" || mutation === "key") {
		const kind = mutation === "device" ? "device_id" : "ed25519_key";
		const value = mutation === "device" ? "device-a" : EXPECTED_KEY_ID;
		await f.exec(
			`INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES ('${kind}','${value}','revocation-a','group-a','device-a','${input.signer.publicKey}','${input.signer.fingerprint}','revoked')`,
		);
	}
	if (mutation === "controller")
		await f.exec(
			`UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked' WHERE attestation_id='${reviewId}'`,
		);
	if (mutation === "link") await f.end();
	if (mutation === "enrollment")
		await f.exec(`UPDATE enrolled_devices SET public_key='${otherKey}' WHERE device_id='device-a'`);
}
function registerFaultTests(test: Test) {
	test.for(["lost-write-response", "adapter-postcommit-read", "http-response"])(
		"reports a fixed unknown outcome after committed %s failure without retry or rollback",
		async (fault, { fixture: f }) => {
			// Arrange
			const p = await proof(f);
			let writes = 0;
			let committed = false;
			const backend: AuthLinkBackend = {
				...f.backend,
				first: async <T>(s: Parameters<AuthLinkBackend["first"]>[0]) => {
					const result = await f.backend.first<T>(s);
					if (committed && fault === "adapter-postcommit-read")
						throw new Error("backend-sensitive-error provider-access-token");
					return result;
				},
				run: async (s) => {
					const result = await f.backend.run(s);
					if (s.sql.startsWith(`INSERT INTO ${table}`)) {
						writes++;
						committed = true;
						if (fault === "lost-write-response") throw new Error("backend-sensitive-error");
						// Adapter completion can fail after commit; Ops itself does not read after a successful INSERT.
						if (fault === "adapter-postcommit-read")
							await backend.first({ sql: `SELECT count(*) AS count FROM ${table}`, values: [] });
					}
					return result;
				},
			};
			// Act
			let response: Response;
			if (fault === "http-response") {
				const handler = createOwnerQualificationHandler({
					backend,
					config,
					adminSecret: () => secret,
					readRequestBytes: async () => new TextEncoder().encode(JSON.stringify(confirm(p.digest))),
					parseJsonObject: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
					rateLimitedResponse: () => null,
				});
				const router = new Hono();
				router.post("/qualification", async (c) => {
					const json = Reflect.get(c, "json") as unknown as (...args: unknown[]) => Response;
					Object.defineProperty(c, "json", {
						value: (...args: unknown[]) => {
							if (committed && args[1] === 201) throw new Error("backend-sensitive-error");
							return Reflect.apply(json, c, args);
						},
					});
					return handler(c);
				});
				response = await router.request("http://fixture.test/qualification", {
					method: "POST",
					headers: { "X-Codemem-Coordinator-Admin": secret },
				});
			} else response = await app(f, { backend }).request(confirm(p.digest));
			// Assert
			expect(response.status).toBe(503);
			const value = await response.json();
			expect(value).toEqual({ error: "qualification_outcome_unknown" });
			safe(response, value);
			expect(writes).toBe(1);
			expect(await f.rows()).toHaveLength(1);
			await assertRetry(f, p.digest);
		},
	);
}
async function assertRetry(f: Fixture, digest: string) {
	const retry = await app(f).request(confirm(digest));
	expect(retry.status).toBe(200);
	expect(((await retry.json()) as { qualification_id: string }).qualification_id).toBe(
		(await f.rows())[0]?.qualification_id,
	);
}
