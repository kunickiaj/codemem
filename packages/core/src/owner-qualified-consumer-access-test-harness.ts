import { expect, vi } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { authDeviceClaimProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { ownerAdmissionSessionGuard } from "./owner-browser-admission-authority.js";
import {
	NOW,
	type QualifiedFixture,
	type qualifiedTest,
} from "./owner-qualified-consumer-test-harness.js";

const COUNT = 240;
const links = "coordinator_auth_account_links";
const attempts = "coordinator_owner_enrollment_attempts";
const identityColumns = new Set(
	"device_id identity_id attempt_id link_id claim_id device_claim_id attestation_id controller_attestation_id review_receipt_id enrollment_identity_id session_id subject account_subject qualification_id source_receipt_id".split(
		" ",
	),
);
const hashColumns = new Set(
	"credential_hash browser_transaction_hash state_hash binder_hash claim_token runtime_verifier_hash completion_secret_hash browser_start_hash browser_binder_hash".split(
		" ",
	),
);

async function append(f: QualifiedFixture, table: string, rows: Record<string, unknown>[]) {
	const columns = Object.keys(rows[0] ?? {});
	await f.exec(
		`INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns.map((c) => `json_extract(value,'$.${c}')`).join(",")} FROM json_each(?)`,
		JSON.stringify(rows),
	);
}
async function populate(f: QualifiedFixture) {
	const tables = [
		"enrolled_devices",
		"coordinator_auth_browser_transactions",
		"coordinator_auth_link_attempts",
		"coordinator_auth_device_claims",
		links,
		"coordinator_auth_link_audit_log",
		"coordinator_auth_controller_attestations",
		"coordinator_owner_enrollment_qualifications",
		"coordinator_identity_group_grants",
		"coordinator_auth_sessions",
	];
	const keys = await Promise.all(
		Array.from({ length: COUNT }, async () => {
			const key = await f.key();
			return {
				public_key: key.publicKey,
				key_id: await ed25519KeyId(key.publicKey),
				fingerprint: Buffer.from(
					await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.publicKey)),
				).toString("hex"),
			};
		}),
	);
	const substitutions = Array.from({ length: COUNT }, () => new Map<string, string>());
	for (const table of tables) {
		const source = await f.rows(table);
		const rows = substitutions.flatMap((map, n) =>
			source.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([column, value]) => [
						column,
						cloneValue({ column, value, map, n, key: keys[n] ?? {} }),
					]),
				),
			),
		);
		await append(f, table, rows);
	}
	await populateRetainedAttempts(f);
	// Actual stored proof validates every cloned link, not a mock eligibility oracle.
	expect(
		await f.backend.first({
			sql: `SELECT count(*) AS total,sum(${authDeviceClaimProvenanceSql({ link: "l", connections: true })}) AS valid FROM ${links} l`,
			values: [],
		}),
	).toEqual({ total: COUNT + 1, valid: COUNT + 1 });
	expect(await f.rows(attempts)).toHaveLength(COUNT);
}
function cloneValue({
	column,
	value,
	map,
	n,
	key,
}: {
	column: string;
	value: unknown;
	map: Map<string, string>;
	n: number;
	key: Record<string, unknown>;
}) {
	if (typeof value !== "string") return value;
	if (Object.hasOwn(key, column)) return key[column];
	if (hashColumns.has(column)) {
		if (!map.has(value))
			map.set(value, (100000 + n * 100 + map.size).toString(16).padStart(64, "0"));
		return map.get(value);
	}
	return identityColumns.has(column) ? `unrelated-${n}-${value}` : value;
}
async function populateRetainedAttempts(f: QualifiedFixture) {
	const q = (await f.rows("coordinator_owner_enrollment_qualifications"))[0];
	await append(
		f,
		attempts,
		Array.from({ length: COUNT }, (_, n) => ({
			coordinator_id: f.link.coordinator_id,
			attempt_id: `retained-${n}`,
			purpose: "owner_enroll",
			origin: "https://app.example.test",
			device_id: `retained-device-${n}`,
			public_key: q?.public_key,
			key_id: q?.key_id,
			fingerprint: q?.fingerprint,
			issuer: f.link.issuer,
			auth_config_revision: f.link.auth_config_revision,
			state: "expired",
			browser_start_hash: (500000 + n).toString(16).padStart(64, "0"),
			created_at_ms: NOW - 600000,
			expires_at_ms: NOW,
		})),
	);
}
function capture(f: QualifiedFixture) {
	const statements: AuthLinkStatement[] = [];
	const first = f.backend.first.bind(f.backend);
	const run = f.backend.run.bind(f.backend);
	const batch = f.backend.batch.bind(f.backend);
	vi.spyOn(f.backend, "first").mockImplementation(async (s) => {
		statements.push(s);
		return first(s);
	});
	vi.spyOn(f.backend, "run").mockImplementation(async (s) => {
		statements.push(s);
		return run(s);
	});
	vi.spyOn(f.backend, "batch").mockImplementation(async (s) => {
		statements.push(...s);
		return batch(s);
	});
	return statements;
}
export function registerQualifiedAccessTests(test: ReturnType<typeof qualifiedTest>) {
	registerWrongScope(test);
	registerWrongAttempt(test);
	test("exact qualified ceremony indexes its account and attempt among 240 unrelated proven accounts and retained attempts", async ({
		fixture: f,
	}) => {
		// Arrange: raw SQL adds only unrelated valid storage; the tested ceremony stays real.
		const qualificationId = await f.qualify();
		await f.grant();
		await populate(f);
		const before = await f.rows(links);
		const retained = await f.rows(attempts);
		const statements = capture(f);
		// Act
		const final = await f.confirmed();
		const result = await f.api.finalize(final);
		// Assert: functional result and immutable unrelated rows do not depend on table size.
		expect(result).toMatchObject({
			kind: "finalized",
			identityId: "identity-a",
			groups: ["group-a"],
		});
		expect(await f.attempt()).toMatchObject({
			owner_qualification_id: qualificationId,
			link_id: f.link.link_id,
		});
		expect(await f.rows(links)).toEqual(before);
		expect(
			(await f.rows(attempts)).filter((a) => String(a.attempt_id).startsWith("retained-")),
		).toEqual(retained);
		await assertIndexedAccess(f, statements);
	});
}
function registerWrongScope(test: ReturnType<typeof qualifiedTest>) {
	test.for(["session", "coordinator", "link", "identity", "qualification"])(
		"exact %s scope cannot borrow an unrelated qualified owner",
		async (fault, { fixture: f }) => {
			// Arrange: both owners have valid independent persisted proof and qualification.
			await f.qualify();
			await f.grant();
			await populate(f);
			const sessions = await f.rows("coordinator_auth_sessions");
			const session = sessions.find((s) => s.link_id === f.link.link_id);
			const other = sessions.find((s) => s.link_id !== f.link.link_id);
			const config = {
				enabled: true,
				coordinatorId: String(f.link.coordinator_id),
				issuer: String(f.link.issuer),
				revision: String(f.link.auth_config_revision),
				redirectUri: "https://app.example.test/auth/callback",
			};
			const owner = {
				coordinatorId: config.coordinatorId,
				issuer: config.issuer,
				subject: String(f.link.subject),
				identityId: String(f.link.identity_id),
				linkId: String(f.link.link_id),
			};
			const input = {
				backend: f.backend,
				config,
				sessionCookieHash: String(session?.credential_hash),
				owner,
				deviceId: f.start.deviceId,
				fingerprint: f.fingerprint,
				time: NOW,
			};
			expect(await f.backend.first(await ownerAdmissionSessionGuard(input))).not.toBeNull();
			if (fault === "session") input.sessionCookieHash = String(other?.credential_hash);
			if (fault === "coordinator") input.config.coordinatorId = "wrong-coordinator";
			if (fault === "link") input.owner.linkId = String(other?.link_id);
			if (fault === "identity") input.owner.identityId = String(other?.identity_id);
			if (fault === "qualification")
				await f.exec(
					"UPDATE coordinator_owner_enrollment_qualifications SET revoked_at_ms=? WHERE link_id=?",
					NOW,
					String(f.link.link_id),
				);
			// Act
			const result = await f.backend.first(await ownerAdmissionSessionGuard(input));
			// Assert: narrowing the query must not turn its exact tuple into an OR fallback.
			expect(result).toBeNull();
			expect(await f.rows("coordinator_device_ownership_bindings")).toEqual([]);
		},
	);
}
function registerWrongAttempt(test: ReturnType<typeof qualifiedTest>) {
	test("an unrelated retained attempt cannot borrow the confirmed attempt proof", async ({
		fixture: f,
	}) => {
		// Arrange
		await f.qualify();
		await f.grant();
		await populate(f);
		const final = await f.confirmed();
		// Act
		const denied = await f.api.finalize({ ...final, attemptId: "retained-17" });
		const accepted = await f.api.finalize(final);
		// Assert: failed substitution leaves the legitimate exact proof usable.
		expect(denied).toMatchObject({ kind: "rejected" });
		expect(accepted).toMatchObject({ kind: "finalized", identityId: "identity-a" });
	});
}
async function assertIndexedAccess(f: QualifiedFixture, statements: AuthLinkStatement[]) {
	const relevant = statements.filter((s) =>
		/owner_admission_proven_links|owner_claim_proven_links|owner_confirm_authority|owner_commit_authority/.test(
			s.sql,
		),
	);
	expect(relevant.length).toBeGreaterThan(3);
	for (const phase of [
		"owner_admission_proven_links",
		"owner_callback_attempts",
		"owner_confirm_authority",
		"owner_commit_links",
	]) {
		expect(
			relevant.some((s) => s.sql.includes(phase)),
			phase,
		).toBe(true);
	}
	let checked = 0;
	for (const s of relevant) {
		const plan = await f.explain(s);
		const detail = plan.map((p) => p.detail).join("\n");
		expect(s.values.length).toBeLessThanOrEqual(100);
		for (const cte of baseAccessStages(s.sql)) {
			const roots = plan.filter((p) => p.detail === `MATERIALIZE ${cte.name}`);
			expect(roots.length, `${cte.name}\n${detail}`).toBeGreaterThan(0);
			for (const root of roots) {
				checked++;
				const access = plan
					.filter((p) => p.parent === root.id)
					.map((p) => p.detail)
					.join("\n");
				// Only direct access to these large base tables is constrained. Micro-CTE scans remain legal.
				expect(access, cte.name).not.toMatch(new RegExp(`SCAN ${cte.alias}\\b`));
				const key =
					cte.key === "link_id"
						? "(?:link_id=\\?|issuer=\\? AND subject=\\?)"
						: "(?:attempt_id|browser_transaction_hash|completion_secret_hash|browser_start_hash)=\\?";
				expect(access, cte.name).toMatch(
					new RegExp(`SEARCH ${cte.alias} USING .*\\(coordinator_id=\\? AND ${key}\\)`),
				);
			}
		}
		if (
			/(?:FROM|UPDATE) coordinator_owner_enrollment_attempts (?:AS )?a\b/.test(topLevelBody(s.sql))
		) {
			const root = plan
				.filter((p) => p.parent === 0)
				.map((p) => p.detail)
				.join("\n");
			expect(root, "outer attempt access").not.toMatch(/SCAN a\b/);
			expect(root, "outer attempt access").toMatch(
				/SEARCH a USING .*\(coordinator_id=\? AND (?:attempt_id|browser_transaction_hash|browser_start_hash|completion_secret_hash)=\?\)/,
			);
		}
	}
	expect(checked).toBeGreaterThan(6);
}
function baseAccessStages(sql: string) {
	sql = sql.replace(/'(?:''|[^'])*'/g, "''");
	const stages: { name: string; alias: string; key: string }[] = [];
	for (const match of sql.matchAll(/(\w+) AS MATERIALIZED \(/g)) {
		const start = (match.index ?? 0) + match[0].length;
		const body = materializedBody(sql, start);
		const from =
			/FROM (coordinator_auth_account_links|coordinator_owner_enrollment_attempts) ([la])\b/.exec(
				topLevelBody(body),
			);
		if (from)
			stages.push({
				name: match[1] ?? "",
				alias: from[2] ?? "",
				key: from[1] === links ? "link_id" : "attempt_id",
			});
	}
	return stages;
}
function materializedBody(sql: string, start: number) {
	let depth = 1;
	let end = start;
	for (; end < sql.length && depth > 0; end++) {
		if (sql[end] === "(") depth++;
		if (sql[end] === ")") depth--;
	}
	return sql.slice(start, end - 1);
}
function topLevelBody(body: string) {
	let depth = 0;
	let text = "";
	for (const c of body) {
		if (c === "(") depth++;
		if (depth === 0) text += c;
		if (c === ")") depth--;
	}
	return text;
}
