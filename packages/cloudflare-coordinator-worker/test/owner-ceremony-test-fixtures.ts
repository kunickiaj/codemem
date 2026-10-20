import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import type { AuthLinkBackend, AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { issueBrowserCookie } from "../../core/src/coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
} from "../../core/src/coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL } from "../../core/src/coordinator-owner-enrollment-commit.js";
import {
	type OwnerAttempt,
	ownerEnrollmentFinalMessage,
} from "../../core/src/coordinator-owner-enrollment-proof.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentStartMessage,
} from "../../core/src/owner-enrollment-start.js";
import { pendingKey, seedOwnerAuthority } from "./owner-authority-test-fixture.js";
export { pendingKey } from "./owner-authority-test-fixture.js";

// Deliberately do not import the core SQLite fixture into the native worker pool.
export const NOW = 1_791_028_800_000;
export const ORIGIN = "https://app.example.test";
export const config = {
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	revision: "a".repeat(64),
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};
export const hash = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
export const proof = () => Buffer.alloc(32, 9).toString("base64url");
const prepare = (s: AuthLinkStatement) => env.COORDINATOR_DB.prepare(s.sql).bind(...s.values);
export const backend: AuthLinkBackend = {
	first: <T>(s: AuthLinkStatement) => prepare(s).first<T>(),
	run: async (s) => (await prepare(s).run()).meta.changes,
	batch: async (statements) => {
		await env.COORDINATOR_DB.batch(statements.map(prepare));
	},
};
export const exec = (sql: string, ...values: AuthLinkStatement["values"]) =>
	backend.run({ sql, values });
export const rows = async (table: string) => {
	const orderBy = table === "coordinator_auth_device_claims" ? "claim_id" : "rowid";
	return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all()).results;
};
export async function attempt() {
	const row = await env.COORDINATOR_DB.prepare(
		"SELECT * FROM coordinator_owner_enrollment_attempts WHERE attempt_id = 'attempt-a'",
	).first<OwnerAttempt>();
	if (!row) throw new Error("Missing native ceremony attempt");
	return row;
}
export async function snapshot(options: { authorityOnly?: boolean } = {}) {
	const tables = await env.COORDINATOR_DB.prepare(
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	).all<{ name: string }>();
	const excluded = new Set([
		"coordinator_owner_enrollment_attempts",
		"coordinator_auth_browser_transactions",
	]);
	return Promise.all(
		tables.results
			.filter(({ name }) => !name.startsWith("_cf_"))
			.filter(({ name }) => !options.authorityOnly || !excluded.has(name))
			.map(async ({ name }) => [name, await rows(name)]),
	);
}

export async function resetCeremony() {
	// Native pool cases share storage; recreate immutable owner receipts between cases.
	await exec("DROP TRIGGER IF EXISTS ceremony_reject_write");
	await disposeNativeAuthFixture();
	for (const table of [
		"coordinator_owner_enrollment_attempts",
		"coordinator_device_ownership_bindings",
		"coordinator_owner_enrollment_audit_log",
	])
		await exec(`DROP TABLE IF EXISTS ${table}`);
	for (const table of [
		"enrolled_devices",
		"coordinator_identity_group_grants",
		"coordinator_device_revocations",
		"groups",
	])
		await exec(`DELETE FROM ${table}`);
	for (const name of [
		"0028_add_device_ownership_bindings.sql",
		"0030_add_owner_enrollment_attempts.sql",
	]) {
		const migration = env.TEST_MIGRATIONS.find((m) => m.name === name);
		if (!migration) throw new Error(`Missing native migration fixture: ${name}`);
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	}
	await exec(COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL);
}

/** Dispose only between test cases, with no active fixture or pending operation.
 * Recreate the complete installed auth graph, including its indexes and guards.
 * No predecessor migration replay or schema-version branch belongs here.
 */
export async function disposeNativeAuthFixture() {
	const definitions = await env.COORDINATOR_DB.prepare(
		`SELECT type, name, sql FROM sqlite_master
		WHERE tbl_name GLOB 'coordinator_auth_*' AND sql IS NOT NULL
		AND type IN ('table', 'index', 'trigger')
		ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
	).all<{ type: string; name: string; sql: string }>();
	const tables = definitions.results.filter(({ type }) => type === "table");
	await env.COORDINATOR_DB.batch([
		...tables.map(({ name }) => env.COORDINATOR_DB.prepare(`DROP TABLE "${name}"`)),
		...definitions.results.map(({ sql }) => env.COORDINATOR_DB.prepare(sql)),
	]);
}

export const seedNativeOwnerAuthority = (pins: Parameters<typeof seedOwnerAuthority>[1]) =>
	seedOwnerAuthority(env.COORDINATOR_DB, pins);

async function seedAuthority() {
	await seedNativeOwnerAuthority({
		coordinatorId: config.coordinatorId, issuer: config.issuer, revision: "b".repeat(64),
		linkId: "link-a", subject: "fixture-subject", identityId: "identity-a",
		attemptId: "historical-attempt", controllerAttestationId: "historical-controller",
		controllerReviewReceiptId: "historical-receipt", redirectUri: config.redirectUri,
		groupId: "historical-group", deviceId: "historical-device",
		publicKey: "fixture-historical-controller-key", fingerprint: hash("fixture-historical-controller-key"),
		createdAtMs: NOW - 1000,
	});
	for (const [group, revision, archived, revoked] of [
		["group-b", 3, false, false],
		["group-a", 2, false, false],
		["group-archived", 4, true, false],
		["group-revoked", 5, false, true],
	] as const) {
		const date = new Date(NOW).toISOString();
		await exec(
			"INSERT INTO groups (group_id,created_at,archived_at) VALUES (?,?,?)",
			group,
			date,
			archived ? date : null,
		);
		await exec(
			`INSERT INTO coordinator_identity_group_grants
			(coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at,revoked_at)
			VALUES (?,'identity-a',?,?,?,'controller_attestation','historical-receipt',?,?)`,
			config.coordinatorId,
			group,
			revoked ? "revoked" : "active",
			revision,
			date,
			revoked ? date : null,
		);
	}
}

export async function ceremonyFixture() {
	const key = await pendingKey();
	const start = {
		attemptId: "attempt-a",
		deviceId: "device-a",
		publicKey: key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	start.signature = await key.sign(
		ownerEnrollmentStartMessage(start, { ...config, origin: ORIGIN }),
	);
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const startCookie = await issueBrowserCookie("start");
	const scope = { publicOrigin: ORIGIN, store: config };
	const csrf = await issueBrowserCsrfToken(csrfKey, startCookie.secret, "start", scope);
	const provider = oidcFixture({ issuer: config.issuer });
	let now = NOW;
	const options = {
		purpose: "owner_enroll" as const,
		mode: "local_test" as const,
		config,
		backend: { ...backend },
		csrfKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: provider.fetch },
		clock: () => now,
	};
	const compose = async (storage: AuthLinkBackend = options.backend, revision = config.revision) => {
		const result = await createCoordinatorOwnerEnrollment({
			...options,
			config: { ...config, revision },
			backend: storage,
		});
		if (!result.ok) throw new Error("Native ceremony composition failed");
		return result.enrollment;
	};
	await seedAuthority();
	const api = await compose();
	const claimRequest = (startCode = start.browserStartCode) =>
		formRequest("start", startCookie.setCookie.split(";")[0] ?? "", {
			csrf,
			attempt_id: start.attemptId,
			start_code: startCode,
		});
	return {
		api,
		key,
		start,
		provider,
		options,
		compose,
		claimRequest,
		setNow: (value: number) => {
			now = value;
		},
	};
}
export function formRequest(action: string, cookie: string, fields: Record<string, string>) {
	return new Request(`${ORIGIN}/auth/owner/${action}`, {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields),
	});
}
export type Ceremony = Awaited<ReturnType<typeof ceremonyFixture>>;
export async function claimed(f: Ceremony) {
	const started = await f.api.start(f.start, "transport-a");
	if (started.kind !== "started")
		throw new Error(`Native start failed: ${JSON.stringify(started)}`);
	const claim = await f.api.claimBrowser(f.claimRequest(), "browser-a");
	if (claim.kind !== "browser_claimed")
		throw new Error(`Native claim failed: ${JSON.stringify(claim)}`);
	const cookie = claim.setCookies[0]?.split(";")[0];
	if (!cookie) throw new Error("Missing original browser cookie");
	const callbackUrl = f.provider.authorize(claim.authorizationUrl);
	const callbackRequest = () => new Request(callbackUrl, { headers: { cookie } });
	return { cookie, callbackRequest };
}
export async function verified(f: Ceremony) {
	const { cookie, callbackRequest } = await claimed(f);
	const callback = await f.api.verifyCallback(callbackRequest());
	if (callback.kind !== "verified")
		throw new Error(`Native callback failed: ${JSON.stringify(callback)}`);
	const fields = { csrf: callback.csrf, attempt_id: f.start.attemptId };
	const request = (patch: { cookie?: string; fields?: Record<string, string> } = {}) =>
		formRequest("confirm", patch.cookie ?? cookie, patch.fields ?? fields);
	return { callback, callbackRequest, cookie, fields, request };
}
export async function confirmed(f: Ceremony) {
	const c = await verified(f);
	const result = await f.api.confirm(
		c.request(),
		"browser-a",
		c.callback.confirmation.confirmationHash,
	);
	if (result.kind !== "confirmed")
		throw new Error(`Native confirm failed: ${JSON.stringify(result)}`);
	const input = {
		attemptId: f.start.attemptId,
		completionSecret: result.completionSecret,
		signature: await f.key.sign(
			ownerEnrollmentFinalMessage(await attempt(), result.completionSecret),
		),
	};
	return { ...c, result, input };
}
