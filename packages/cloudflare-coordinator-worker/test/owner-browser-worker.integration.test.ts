import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyAccountConnectionSchema } from "../../core/src/coordinator-account-connection-schema.js";
import { CONNECTION_BIRTH_COLUMNS } from "../../core/src/coordinator-account-connection-storage.js";
import { AuthSessionOperations } from "../../core/src/coordinator-auth-session.js";
import { oidcFixture } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { OWNER_ADMISSION_BODY_MAX_BYTES } from "../../core/src/owner-browser-admission-body.js";
import { ownerEnrollmentOwnerCommitment } from "../../core/src/owner-enrollment-admission.js";
import { ownerEnrollmentHash } from "../../core/src/owner-enrollment-start.js";
import defaultWorker, { createConfiguredCloudflareCoordinatorWorker } from "../src/index.js";
import { deviceClaimEvidenceSql } from "./device-claim-eligibility-fixture.js";
import {
	ADMIT,
	bindings,
	browserConfig,
	fields,
	ownerBrowserWorkerFixture,
	seedLink,
	send,
} from "./owner-browser-worker-fixture.js";
import {
	backend,
	config,
	exec,
	NOW,
	ORIGIN,
	resetCeremony,
	rows,
	snapshot,
} from "./owner-ceremony-test-fixtures.js";

const ATTEMPTS = "coordinator_owner_enrollment_attempts";
let restoreConnections: (() => Promise<void>) | undefined;
beforeEach(async () => {
	await resetCeremony();
	await exec("DELETE FROM coordinator_legacy_team_completions");
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Live network forbidden"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await restoreConnections?.();
	restoreConnections = undefined;
	await resetCeremony();
});
function providerTransport() {
	const provider = oidcFixture({ issuer: config.issuer });
	vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
		if (typeof input !== "string") throw new Error("Unexpected provider transport");
		return provider.fetch(input, init as Parameters<typeof provider.fetch>[1]);
	});
	return provider;
}
async function assertDenied(response: Response, before: unknown, status: number) {
	expect(response.status, await response.clone().text()).toBe(status);
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(response.headers.get("location")).toBeNull();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(before);
}

it("uses the configured default Worker to admit an uploaded signed start with the exact immutable owner pin", async () => {
	// Arrange: historical link and explicit trusted grant do not themselves enroll the pending key.
	const f = await ownerBrowserWorkerFixture(defaultWorker);
	const authority = await snapshot({ authorityOnly: true });
	const provider = providerTransport();
	// Act: both entrypoints traverse the shipped binding/session composition.
	const page = await f.get();
	const pageHtml = await page.text();
	const callsAfterGet = vi.mocked(globalThis.fetch).mock.calls.length;
	const response = await f.post(f.upload(fields(pageHtml).csrf ?? ""));
	const html = await response.text();
	const [attempt] = await rows(ATTEMPTS);
	const commitment = await ownerEnrollmentOwnerCommitment({
		coordinatorId: config.coordinatorId,
		issuer: config.issuer,
		subject: "fixture-subject",
		identityId: "identity-a",
		linkId: "link-a",
	});
	// Assert: reuse the existing start form, never return admission or claim ownership.
	expect(page.status).toBe(200);
	expect(pageHtml).toContain('enctype="multipart/form-data"');
	expect(pageHtml).toContain("not that the key belongs to this computer");
	expect(page.headers.getSetCookie()).toEqual([]);
	expect(callsAfterGet).toBe(0);
	expect(response.status, html).toBe(200);
	expect(html).toContain('action="/auth/owner/start"');
	expect(html).toContain(f.start.deviceId);
	expect(html).toContain(await ownerEnrollmentHash(f.start.publicKey));
	expect(attempt).toMatchObject({
		state: "pending",
		device_id: f.start.deviceId,
		admission_owner_hash: commitment,
		identity_id: null,
		link_id: null,
	});
	expect(await rows(ATTEMPTS)).toHaveLength(1);
	expect(await snapshot({ authorityOnly: true })).toEqual(authority);
	expect(response.headers.getSetCookie()).toHaveLength(1);
	expect(response.headers.getSetCookie()[0]).toMatch(/^__Host-codemem-auth-start=/);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
	for (const secret of [
		f.start.publicKey,
		f.start.signature,
		f.cookie.split("=")[1] ?? "missing-cookie",
		config.clientSecret,
		"fixture-subject",
		"identity-a",
		"link-a",
		"admissionToken",
	])
		expect(html + JSON.stringify([...response.headers])).not.toContain(secret);
	expect(
		provider.requests.every(({ url }) => url.endsWith("/.well-known/openid-configuration")),
	).toBe(true);
	// Act / Assert: native storage accepts the same pin and rejects retargeting it.
	await exec(`UPDATE ${ATTEMPTS} SET admission_owner_hash=?`, commitment);
	await expect(
		exec(`UPDATE ${ATTEMPTS} SET admission_owner_hash=?`, "b".repeat(64)),
	).rejects.toThrow(/owner_enrollment_admission_immutable/);
	expect((await rows(ATTEMPTS))[0]?.admission_owner_hash).toBe(commitment);
});

it.each(["missing", "disabled", "owner-default-off", "owner-disabled"] as const)(
	"returns 404 for %s admission before storage or provider setup",
	async (mode) => {
		// Arrange: a cold configured Worker must not interpret admission as a callback.
		const settings = { ...bindings };
		if (mode === "missing") delete settings.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG;
		if (mode === "disabled")
			settings.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({ enabled: false });
		if (mode === "owner-default-off") {
			const { ownerEnrollmentEnabled: _enabled, ...publicConfig } = browserConfig;
			settings.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify(publicConfig);
		}
		if (mode === "owner-disabled")
			settings.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({
				...browserConfig,
				ownerEnrollmentEnabled: false,
			});
		const prepare = vi.spyOn(env.COORDINATOR_DB, "prepare");
		const worker = createConfiguredCloudflareCoordinatorWorker();
		// Act.
		const responses = [
			await send(worker, {}, settings),
			await send(worker, { method: "POST", body: "unread" }, settings),
		];
		// Assert.
		expect(responses.map((r) => r.status)).toEqual([404, 404]);
		expect(prepare).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it.each(["callback-collision", "malformed-config", "missing-key", "missing-secret"] as const)(
	"fails closed for %s before OIDC",
	async (mode) => {
		// Arrange.
		const settings = { ...bindings };
		if (mode === "callback-collision")
			settings.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({
				...browserConfig,
				redirectUri: `${ORIGIN}${ADMIT}`,
			});
		if (mode === "malformed-config") settings.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = "{";
		if (mode === "missing-key") settings.CODEMEM_COORDINATOR_BROWSER_CSRF_KEY = "";
		if (mode === "missing-secret") settings.CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET = "";
		const before = await snapshot();
		const worker = createConfiguredCloudflareCoordinatorWorker();
		// Act.
		const response = await send(worker, {}, settings);
		// Assert.
		await assertDenied(response, before, 503);
	},
);

it.each([
	["no-session", "DELETE FROM coordinator_auth_sessions"],
	["no-grants", "DELETE FROM coordinator_identity_group_grants"],
	[
		"session-expiry",
		`UPDATE coordinator_auth_sessions SET created_at_ms=${NOW - 28800000},expires_at_ms=${NOW}`,
	],
	[
		"config-revision",
		`UPDATE coordinator_auth_sessions SET auth_config_revision='${"b".repeat(64)}'`,
	],
	["revoked-link", `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW}`],
	["old-schema", "DROP TRIGGER owner_enrollment_admission_update"],
] as const)("denies %s on GET and POST without discovery or writes", async (mode, mutation) => {
	// Arrange: CSRF is genuine; loss of authority must still deny both methods.
	const f = await ownerBrowserWorkerFixture(createConfiguredCloudflareCoordinatorWorker());
	const csrf = await f.page();
	await exec(mutation);
	const before = await snapshot();
	// Act.
	const get = await f.get();
	const post = await f.post(f.upload(csrf));
	// Assert.
	await assertDenied(get, before, mode === "old-schema" ? 400 : 403);
	await assertDenied(post, before, mode === "old-schema" ? 400 : 403);
});

it.each([
	"foreign-origin",
	"missing-origin",
	"csrf",
	"bad-signature",
	"duplicate-file",
	"oversize",
	"wrong-type",
] as const)("rejects %s uploads without provider setup or writes", async (mode) => {
	// Arrange.
	const f = await ownerBrowserWorkerFixture(createConfiguredCloudflareCoordinatorWorker());
	const csrf = await f.page();
	const headers: Record<string, string> = {};
	let body: BodyInit = f.upload(mode === "csrf" ? "forged" : csrf);
	if (mode === "foreign-origin") headers.origin = "https://other.example.test";
	if (mode === "bad-signature")
		body = f.upload(csrf, JSON.stringify({ start: { ...f.start, signature: "invalid" } }));
	if (mode === "duplicate-file")
		(body as FormData).append("request", new File(["{}"], "extra.json"));
	if (mode === "oversize") body = f.upload(csrf, "x".repeat(OWNER_ADMISSION_BODY_MAX_BYTES + 1));
	if (mode === "wrong-type") {
		body = JSON.stringify({ start: f.start });
		headers["content-type"] = "application/json";
	}
	const before = await snapshot();
	// Act.
	const response =
		mode === "missing-origin"
			? await send(f.worker, { method: "POST", headers: { cookie: f.cookie }, body })
			: await f.post(body, headers);
	// Assert.
	await assertDenied(response, before, 400);
});

/** Intercept execution, not preparation: mutations commit via a separate native D1 request. */
function beforeWinningInsert(mutate: () => Promise<unknown>) {
	const prepare = env.COORDINATOR_DB.prepare.bind(env.COORDINATOR_DB);
	let entered = 0;
	let executionError: unknown;
	vi.spyOn(env.COORDINATOR_DB, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (!sql.includes(`INSERT INTO ${ATTEMPTS}`)) return statement;
		const wrap = (target: D1PreparedStatement): D1PreparedStatement =>
			new Proxy(target, {
				get(target, property) {
					if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
					if (property === "run")
						return async () => {
							entered++;
							await mutate();
							try {
								return await target.run();
							} catch (error) {
								executionError = error;
								throw error;
							}
						};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		return wrap(statement);
	});
	return { entered: () => entered, error: () => executionError };
}

async function archiveLink() {
	// Seed the exact competing management receipt; leave all archive constraints enabled.
	await exec(
		`INSERT INTO coordinator_account_change_attempts
		(coordinator_id,attempt_id,intent,target_link_id,identity_id,issuer,target_subject,group_id,device_id,public_key,fingerprint,key_id,
		auth_config_revision,runtime_verifier_hash,browser_start_hash,loopback_redirect,state,created_at_ms,expires_at_ms,consumed_at_ms,verified_at_ms,confirmed_at_ms,completion_secret_hash)
		SELECT coordinator_id,'replace-link','disconnect',link_id,identity_id,issuer,subject,'historical-group','historical-link-a','fixture-key',?,?,auth_config_revision,?,?,
		'http://127.0.0.1:43210/codemem/auth/complete','committing',?,?,?,?,?,? FROM coordinator_auth_account_links WHERE link_id='link-a'`,
		"a".repeat(64),
		"b".repeat(64),
		"c".repeat(64),
		"d".repeat(64),
		NOW - 100,
		NOW + 599900,
		NOW - 80,
		NOW - 60,
		NOW - 40,
		"e".repeat(64),
	);
	const columns = [...CONNECTION_BIRTH_COLUMNS, "signin_floor"].join(",");
	await exec(
		`INSERT INTO coordinator_auth_account_connection_history (${columns},original_rowid,ended_at_ms,end_attempt_id)
		SELECT ${columns},rowid,?,'replace-link' FROM coordinator_auth_account_links WHERE link_id='link-a'`,
		NOW,
	);
}

async function installConnections() {
	// Preserve the pre-extension graph: the shared ceremony reset retains installed auth DDL.
	const definitions = (
		await env.COORDINATOR_DB.prepare(`SELECT type,name,sql FROM sqlite_master
		WHERE (tbl_name GLOB 'coordinator_auth_*' OR tbl_name='coordinator_account_change_attempts')
		AND sql IS NOT NULL AND type IN ('table','index','trigger')
		ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name`).all<{
			type: string;
			name: string;
			sql: string;
		}>()
	).results;
	restoreConnections = async () => {
		const tables = (
			await env.COORDINATOR_DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'
			AND (name GLOB 'coordinator_auth_*' OR name='coordinator_account_change_attempts')`).all<{
				name: string;
			}>()
		).results;
		await env.COORDINATOR_DB.batch([
			...tables.map(({ name }) => env.COORDINATOR_DB.prepare(`DROP TABLE "${name}"`)),
			...definitions.map(({ sql }) => env.COORDINATOR_DB.prepare(sql)),
		]);
	};
	await applyAccountConnectionSchema(backend);
}

async function excludePendingKey(options: { mode: string; deviceId: string; fingerprint: string }) {
	const device =
		options.mode === "pending-device-exclusion" ? options.deviceId : "different-device";
	const key = options.mode === "pending-key-exclusion" ? options.fingerprint : "f".repeat(64);
	// Keep the excluded historical device enrolled: test exact matching, not orphan denial.
	await exec(
		"INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,created_at) VALUES ('group-a',?,?,?,'created')",
		device,
		"fixture-excluded-key",
		key,
	);
	await exec(
		`INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
		VALUES ('group-a','completion-a',1,?, 'completed','created')`,
		JSON.stringify({
			coordinator_id: config.coordinatorId,
			device_decisions: [{ decision: "excluded", device_id: device, key_fingerprint: key }],
		}),
	);
}

it.each([
	"unchanged",
	"connection-unchanged",
	"session-revocation",
	"link-replacement",
	"config-revision",
	"session-expiry",
	"connection-revocation",
	"grant-revocation",
	"pending-device-exclusion",
	"pending-key-exclusion",
] as const)("rechecks %s at the winning native D1 INSERT", async (mode) => {
	// Arrange: all application admission reads succeed before the competing D1 write.
	const f = await ownerBrowserWorkerFixture(createConfiguredCloudflareCoordinatorWorker());
	if (mode === "connection-unchanged" || mode === "connection-revocation")
		await installConnections();
	const csrf = await f.page();
	const fingerprint = await ownerEnrollmentHash(f.start.publicKey);
	const provider = providerTransport();
	let afterMutation: unknown;
	let mutationError: unknown;
	const mutate = async () => {
		if (mode === "session-revocation")
			await exec("UPDATE coordinator_auth_sessions SET revoked_at_ms=?", NOW);
		if (mode === "config-revision")
			await exec("UPDATE coordinator_auth_sessions SET auth_config_revision=?", "b".repeat(64));
		if (mode === "session-expiry")
			await exec(
				"UPDATE coordinator_auth_sessions SET created_at_ms=?,expires_at_ms=?",
				NOW - 28800000,
				NOW,
			);
		if (mode === "grant-revocation")
			await exec(
				"UPDATE coordinator_identity_group_grants SET status='revoked',revoked_at='revoked'",
			);
		if (mode === "link-replacement") {
			await exec("DELETE FROM coordinator_auth_account_links WHERE link_id='link-a'");
			await seedLink("link-b", "replacement-subject");
			await exec(
				"UPDATE coordinator_auth_sessions SET link_id='link-b',subject='replacement-subject'",
			);
		}
		if (mode === "connection-revocation") {
			await archiveLink();
			await exec("UPDATE coordinator_auth_account_connection_history SET revoked_at_ms=?", NOW);
		}
		if (mode === "pending-device-exclusion" || mode === "pending-key-exclusion") {
			await excludePendingKey({ mode, deviceId: f.start.deviceId, fingerprint });
		}
		afterMutation = await snapshot();
	};
	const entered = beforeWinningInsert(() =>
		mutate().catch((error: unknown) => {
			mutationError = error;
			throw error;
		}),
	);
	// Act: the real native statement runs after the competing mutation commits.
	const response = await f.post(f.upload(csrf));
	// Assert: include a positive control proving interception still executes the real INSERT.
	expect(entered.entered()).toBe(1);
	expect(mutationError).toBeUndefined();
	expect(entered.error()).toBeUndefined();
	const unchanged = mode === "unchanged" || mode === "connection-unchanged";
	expect(response.status, await response.clone().text()).toBe(unchanged ? 200 : 400);
	if (unchanged) expect(await rows(ATTEMPTS)).toHaveLength(1);
	else {
		expect(await rows(ATTEMPTS)).toEqual([]);
		expect(await snapshot()).toEqual(afterMutation);
		expect(response.headers.getSetCookie()).toEqual([]);
	}
	expect(await rows("coordinator_device_ownership_bindings")).toEqual([]);
	expect(await rows("coordinator_owner_enrollment_audit_log")).toEqual([]);
	expect(
		provider.requests.every(({ url }) => url.endsWith("/.well-known/openid-configuration")),
	).toBe(true);
});

it("denies a proven device-claim session even with independent trusted grants", async () => {
	// Arrange: retain genuine committed claim provenance, not a malformed attested link.
	const f = await ownerBrowserWorkerFixture(createConfiguredCloudflareCoordinatorWorker());
	const evidence = deviceClaimEvidenceSql({ identityId: "claim-identity" }).replaceAll(
		"https://accounts.example.test",
		config.issuer,
	);
	for (const sql of evidence.split(";").filter((part) => part.trim())) await exec(sql);
	await exec(`INSERT INTO coordinator_auth_account_links
		(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
		SELECT coordinator_id,link_id,issuer,account_subject,identity_id,attempt_id,auth_config_revision,finalized_at_ms,'device_claim',link_id
		FROM coordinator_auth_link_attempts WHERE attempt_id='completed-attempt'`);
	await exec(`INSERT INTO coordinator_auth_link_audit_log
		(coordinator_id,link_id,attempt_id,action,identity_id,group_id,device_id,fingerprint,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
		SELECT coordinator_id,link_id,attempt_id,'link_created',identity_id,group_id,device_id,fingerprint,auth_config_revision,finalized_at_ms,'device_claim',link_id
		FROM coordinator_auth_link_attempts WHERE attempt_id='completed-attempt'`);
	await exec(
		"UPDATE coordinator_auth_sessions SET link_id='claim-a',identity_id='claim-identity',subject='private-claim-subject'",
	);
	await exec(
		`INSERT INTO coordinator_identity_group_grants (coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at)
		VALUES (?,'claim-identity','group-a','active',1,'controller_attestation','independent-review','created')`,
		config.coordinatorId,
	);
	expect(
		await new AuthSessionOperations(backend).readAuthSession(f.session.cookieHash, config),
	).toMatchObject({ identityId: "claim-identity", linkId: "claim-a" });
	const before = await snapshot();
	// Act.
	const get = await f.get();
	const post = await f.post(f.upload("unread-csrf"));
	// Assert: valid management access is not owner-enrollment authority.
	await assertDenied(get, before, 403);
	await assertDenied(post, before, 403);
});

it.each(["exact", "overflow", "lying-length"] as const)(
	"enforces the native multipart %s byte boundary",
	async (mode) => {
		// Arrange: a valid signed multipart body with a padded epilogue measures the whole body.
		const f = await ownerBrowserWorkerFixture(createConfiguredCloudflareCoordinatorWorker());
		const encoded = new Request(`${ORIGIN}${ADMIT}`, {
			method: "POST",
			body: f.upload(await f.page()),
		});
		const bytes = new Uint8Array(OWNER_ADMISSION_BODY_MAX_BYTES + (mode === "exact" ? 0 : 1)).fill(
			32,
		);
		bytes.set(new Uint8Array(await encoded.arrayBuffer()));
		const headers: Record<string, string> = {
			"content-type": encoded.headers.get("content-type") ?? "",
		};
		if (mode === "lying-length") headers["content-length"] = "1";
		const before = await snapshot();
		const provider = providerTransport();
		// Act.
		const response = await f.post(bytes, headers);
		// Assert: 16 KiB succeeds; one extra observed byte fails even with a false declared length.
		expect(bytes.length).toBe(mode === "exact" ? 16384 : 16385);
		if (mode === "exact") {
			expect(response.status).toBe(200);
			expect(await rows(ATTEMPTS)).toHaveLength(1);
		} else await assertDenied(response, before, 400);
		expect(
			provider.requests.every(({ url }) => url.endsWith("/.well-known/openid-configuration")),
		).toBe(true);
	},
);

it.each(["client", "identity"] as const)(
	"enforces the configured %s admission quota without OIDC",
	async (mode) => {
		// Arrange: changing an untrusted forwarding header must not reset either bucket.
		const f = await ownerBrowserWorkerFixture(createConfiguredCloudflareCoordinatorWorker());
		const limit = mode === "client" ? 20 : 10;
		const before = await snapshot();
		const statuses: number[] = [];
		const request = (n: number) =>
			send(f.worker, {
				headers: {
					cookie: mode === "identity" ? f.cookie : "",
					"x-forwarded-for": `192.0.2.${n}`,
				},
			});
		// Act: exercise every allowed token and then one excess request on the same Worker.
		for (let n = 0; n < limit; n++) statuses.push((await request(n)).status);
		const exhausted = await request(limit);
		// Assert: identity gets ten form reads; a sessionless client gets twenty denied checks.
		expect(statuses).toEqual(Array(limit).fill(mode === "client" ? 403 : 200));
		await assertDenied(exhausted, before, 429);
	},
);
