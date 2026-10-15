// Synthetic handoff only: owner HTTP exists only in the Node test adapter.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { AUTH_LINK_AUTHORITY_UPGRADE_SQL } from "../../core/src/coordinator-auth-link-authority-upgrade.ts";
import {
	ownerHandoffClient,
	ownerBrowserStart,
	ownerFormFields,
	ownerHttpDispatcher,
	ownerHttpRequest,
} from "./owner-handoff-fixture.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
const { build } = runtimeRequire("esbuild");
const coreDir = fileURLToPath(new URL("../../core", import.meta.url));
const artifacts = fileURLToPath(new URL("../../../.tmp", import.meta.url));
const migrations = await readD1Migrations(fileURLToPath(new URL("../migrations", import.meta.url)));

// Reuse existing key, authority, browser and fake-provider fixtures, not a second runtime.
async function loadHelpers(t) {
	await mkdir(artifacts, { recursive: true });
	const directory = await mkdtemp(join(artifacts, "owner-handoff-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const bundle = await build({
		stdin: {
			contents: `
export { ownerStartFixture, seedOwnerCallbackAuthority, browserForm, config, ORIGIN, proof } from './coordinator-owner-enrollment-start-test-fixtures.ts';
export { commitPendingKey } from './coordinator-owner-enrollment-commit-test-fixtures.ts';
export { createCoordinatorOwnerEnrollment, ownerEnrollmentStartMessage } from './owner-enrollment-start.ts';
export { createCoordinatorOwnerEnrollmentHttp } from './coordinator-owner-enrollment-http.ts';
export { ownerEnrollmentFinalMessage } from './coordinator-owner-enrollment-proof.ts';
export { ed25519KeyId } from './coordinator-ed25519-key-id.ts';
export { ownerEnrollmentHash } from './owner-enrollment-start.ts';
export { COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL } from './coordinator-owner-enrollment-commit.ts';
export { createCoordinatorOwnerEnrollmentReceiver } from './coordinator-account-link-receiver.ts';
export { issueBrowserCookie } from './coordinator-browser-credential.ts';
export { oidcFixture, PROVIDER } from './coordinator-oidc-test-fixtures.ts';
export { NOW } from './coordinator-auth-link-test-fixtures.ts';`,
			resolveDir: join(coreDir, "src"),
			sourcefile: "test-only-owner-handoff.ts",
		},
		bundle: true,
		write: false,
		platform: "node",
		format: "cjs",
		target: "node24",
		plugins: [
			{
				name: "fixture-only-dependencies",
				setup(builder) {
					// Fixtures use vi.fn only as a transparent fake transport wrapper. Node cannot
					// import Vitest outside its runner; assertions/mocks are never used here.
					builder.onResolve({ filter: /^vitest$/ }, () => ({
						path: "vitest",
						namespace: "fixture",
					}));
					builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
						contents:
							"export const vi = { fn: (f) => f }; export const it = {}; export const expect = () => { throw new Error('Unexpected Vitest assertion'); };",
						loader: "js",
					}));
					builder.onResolve({ filter: /^[^./]/ }, async ({ path, pluginData }) => {
						if (pluginData?.resolving) return;
						if (path.startsWith("node:")) return { path, external: true };
						const resolved = await builder.resolve(path, {
							kind: "import-statement",
							resolveDir: coreDir,
							pluginData: { resolving: true },
						});
						return { path: resolved.path, external: true, errors: resolved.errors };
					});
				},
			},
		],
	});
	const path = join(directory, "helpers.cjs");
	await writeFile(path, bundle.outputFiles[0].text);
	return require(path);
}

async function storage(t, h, kind) {
	const sqlite = h.ownerStartFixture();
	t.after(() => sqlite.close());
	h.seedOwnerCallbackAuthority(sqlite);
	if (kind === "SQLite")
		return { backend: sqlite.backend, rows: async (table) => sqlite.rows(table) };
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch() { return new Response(null, {status:404}); } };",
			compatibilityDate: "2026-03-28",
			compatibilityFlags: ["nodejs_compat"],
			d1Databases: { DB: "owner-handoff-fixture" },
			cf: false,
			host: "127.0.0.1",
			port: 0,
			outboundService: () => {
				throw new Error("External network forbidden");
			},
		}),
	);
	t.after(() => mf.dispose());
	const db = await mf.getD1Database("DB");
	for (const migration of migrations)
		await db.batch(migration.queries.map((sql) => db.prepare(sql)));
	await db.batch(AUTH_LINK_AUTHORITY_UPGRADE_SQL.split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
	await db.prepare(h.COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL).run();
	// Copy only existing synthetic account/grant authority, never an owner attempt or device.
	for (const table of [
		"groups",
		"coordinator_auth_account_links",
		"coordinator_identity_group_grants",
	]) {
		for (const row of sqlite.rows(table)) {
			const names = Object.keys(row);
			await db
				.prepare(
					`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
				)
				.bind(...Object.values(row))
				.run();
		}
	}
	const prepare = (s) => db.prepare(s.sql).bind(...s.values);
	return {
		backend: {
			first: (s) => prepare(s).first(),
			run: async (s) => (await prepare(s).run()).meta.changes,
			batch: async (statements) => {
				await db.batch(statements.map(prepare));
			},
		},
		rows: async (table) =>
			(await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
	};
}

function navigate(url) {
	return ownerHttpRequest(url, {
		headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
	});
}

async function fixture(t, kind, host = "127.0.0.1") {
	const h = await loadHelpers(t);
	const store = await storage(t, h, kind);
	const controller = new AbortController();
	const key = h.commitPendingKey();
	const client = await ownerHandoffClient({
		helpers: h,
		pin: { ...h.config, origin: h.ORIGIN },
		key,
		deviceId: "fresh-device-b",
		attemptId: "owner-attempt-b",
		host,
		signal: controller.signal,
	});
	const { receiver, start } = client;
	t.after(() => receiver.close());
	const provider = h.oidcFixture({ issuer: h.config.issuer });
	const options = {
		purpose: "owner_enroll",
		mode: "local_test",
		config: { ...h.config, clientId: h.PROVIDER.clientId, clientSecret: h.PROVIDER.clientSecret },
		backend: store.backend,
		oidcOptions: { fetch: provider.fetch },
		clock: () => h.NOW,
	};
	const compose = async (backend = store.backend) => {
		return h.createCoordinatorOwnerEnrollmentHttp({ ...options, backend });
	};
	const api = await compose();
	let loseReply = false;
	const dispatcher = await ownerHttpDispatcher({
		getApi: () => api,
		origin: h.ORIGIN,
		loseFinalReply: () => {
			const lose = loseReply;
			loseReply = false;
			return lose;
		},
	});
	t.after(() => dispatcher.close());
	const base = dispatcher.base;
	const send = (path, init) => ownerHttpRequest(`${base}${path}`, init);
	const finalize = async (input) => JSON.parse((await client.finalize(base, input)).body);
	return {
		h,
		...store,
		controller,
		receiver,
		key,
		start,
		provider,
		compose,
		client,
		base,
		send,
		finalize,
		loseNextFinalReply: () => {
			loseReply = true;
		},
	};
}

async function verify(f) {
	assert.equal(JSON.parse((await f.client.startRequest(f.base)).body).kind, "started");
	const claimed = await ownerBrowserStart(f.send, f.start, f.h.ORIGIN);
	assert.equal(claimed.status, 303);
	assert.equal(claimed.headers["cache-control"], "no-store");
	const cookie = claimed.headers["set-cookie"][0].split(";")[0];
	const callback = new URL(f.provider.authorize(claimed.headers.location));
	const response = await f.send(callback.pathname + callback.search, { headers: { cookie } });
	return { response, fields: ownerFormFields(response.body), cookie };
}

function confirm(f, c, patch = {}) {
	return f.send("/auth/owner/confirm", {
		method: "POST",
		headers: {
			origin: patch.origin ?? f.h.ORIGIN,
			cookie: patch.cookie ?? c.cookie,
			"content-type": "application/x-www-form-urlencoded",
		},
		body:
			patch.body ??
			new URLSearchParams({
				...c.fields,
				csrf: patch.csrf ?? c.fields.csrf,
				attempt_id: f.start.attemptId,
			}).toString(),
	});
}

async function deliver(f, c) {
	assert.equal(c.response.status, 200);
	const confirmed = await confirm(f, c);
	assert.equal(confirmed.status, 303);
	assert.equal(confirmed.headers["cache-control"], "no-store");
	assert.equal(confirmed.headers["referrer-policy"], "no-referrer");
	assert.equal(confirmed.body, "");
	const url = new URL(confirmed.headers.location);
	assert.equal(url.origin + url.pathname, f.receiver.destination);
	const wrong = new URL(url);
	wrong.searchParams.set("attempt_id", "another-attempt");
	assert.equal((await navigate(wrong)).status, 400);
	const response = await navigate(url);
	assert.equal(response.status, 200);
	assert.equal(response.headers["cache-control"], "no-store");
	assert.equal(response.headers["referrer-policy"], "no-referrer");
	assert.ok(!response.body.includes(url.searchParams.get("completion")));
	assert.ok(!response.body.includes("/auth/link/complete"));
	const input = await f.client.consumeCompletion();
	assert.equal(input.completionSecret, url.searchParams.get("completion"));
	assert.match(url.searchParams.get("confirmation"), /^[0-9a-f]{64}$/);
	assert.equal((await navigate(url)).status, 410);
	return input;
}

async function effects(f) {
	return Promise.all(
		[
			"coordinator_device_ownership_bindings",
			"enrolled_devices",
			"coordinator_owner_enrollment_audit_log",
		].map(f.rows),
	);
}

async function authority(f) {
	return Promise.all(
		[
			"groups",
			"coordinator_auth_account_links",
			"coordinator_identity_group_grants",
			"coordinator_auth_sessions",
		].map(f.rows),
	);
}

for (const kind of ["SQLite", "D1"]) {
	for (const host of ["127.0.0.1", "::1"]) {
		test(`${kind}: fresh device B handoff over ${host}, wrong key denial and exact retry`, {
			timeout: 30000,
		}, async (t) => {
			// Arrange: receiver is already bound before signing the exact saved destination.
			const f = await fixture(t, kind, host);
			const originalAuthority = await authority(f);
			const substitutedDestination = new URL(f.receiver.destination);
			substitutedDestination.port = String((Number(substitutedDestination.port) % 65535) + 1);
			assert.equal((await f.client.startRequest(f.base, { ...f.start, loopbackRedirect: substitutedDestination.href })).status, 400);
			const c = await verify(f);
			assert.equal(c.response.status, 200);
			assert.ok(c.response.body.includes("<dt>Identity</dt><dd>identity-a</dd>"));
			assert.ok(c.response.body.includes(await f.h.ownerEnrollmentHash(f.start.publicKey)));
			assert.deepEqual(await effects(f), [[], [], []]);
			// Act: browser confirmation and actual HTTP delivery do not enroll the device.
			const input = await deliver(f, c);
			assert.deepEqual(await effects(f), [[], [], []]);
			const wrongKey = f.h.commitPendingKey();
			const [attempt] = await f.rows("coordinator_owner_enrollment_attempts");
			const denied = await f.client.finalize(f.base, {
				...input,
				signature: wrongKey.sign(f.h.ownerEnrollmentFinalMessage(attempt, input.completionSecret)),
			});
			assert.deepEqual(await effects(f), [[], [], []]);
			const finalized = await f.finalize();
			const beforeRetry = await effects(f);
			const retry = await f.finalize();
			const mismatchedRetry = await f.client.finalize(f.base, { ...input, completionSecret: f.h.proof() });
			// Assert: one binding/audit, only active existing grants, and read-only exact replay.
			assert.equal(denied.status, 400);
			assert.equal(finalized.kind, "finalized");
			assert.equal(finalized.identityId, attempt.identity_id);
			assert.deepEqual(finalized.groups, ["group-a", "group-b"]);
			assert.deepEqual(retry, { ...finalized, kind: "prior_commit" });
			assert.equal(mismatchedRetry.status, 400);
			assert.deepEqual(await effects(f), beforeRetry);
			assert.deepEqual(await authority(f), originalAuthority);
			const [bindings, enrollments, audits] = beforeRetry;
			assert.equal(bindings.length, 1);
			assert.equal(bindings[0].device_id, "fresh-device-b");
			assert.equal(bindings[0].identity_id, "identity-a");
			assert.equal(audits.length, 1);
			assert.equal(enrollments.length, 2);
			assert.ok(
				enrollments.every(
					(row) =>
						row.device_id === f.start.deviceId &&
						row.public_key === f.key.publicKey &&
						row.identity_id === "identity-a",
				),
			);
			assert.equal((await f.rows("coordinator_auth_sessions")).length, 0);
			assert.ok(f.provider.requests.some(({ url }) => url.endsWith("/token")));
			assert.ok(f.provider.requests.some(({ url }) => url.endsWith("/jwks")));
		});
	}

	test(`${kind}: wrong browser and CSRF deny confirmation; abort is local only`, {
		timeout: 30000,
	}, async (t) => {
		// Arrange
		const f = await fixture(t, kind);
		const c = await verify(f);
		assert.equal(c.response.status, 200);
		const foreign = await f.h.issueBrowserCookie("transaction");
		// Act: neither a different cookie nor an invalid CSRF may issue completion.
		const browserDenial = await confirm(f, c, { cookie: foreign.setCookie.split(";")[0] });
		const csrfDenial = await confirm(f, c, { csrf: f.h.proof() });
		assert.equal((await confirm(f, c, { origin: "https://wrong.example.test" })).status, 400);
		assert.equal(
			(await confirm(f, c, { body: "csrf=x&csrf=y&attempt_id=owner-attempt-b" })).status,
			400,
		);
		assert.equal((await confirm(f, c, { body: "x".repeat(16385) })).status, 400);
		const confirmed = await confirm(f, c);
		f.controller.abort();
		// Assert: abort stops receipt, not the server attempt; no finalization/binding occurred.
		assert.equal(browserDenial.status, 400);
		assert.equal(csrfDenial.status, 400);
		assert.equal(confirmed.status, 303);
		await assert.rejects(f.receiver.completion, /receiver stopped/);
		await f.receiver.close();
		assert.equal((await f.rows("coordinator_owner_enrollment_attempts"))[0].state, "confirmed");
		assert.deepEqual(await effects(f), [[], [], []]);
	});

	for (const failure of ["wrong account", "invalid provider signature"]) {
		test(`${kind}: ${failure} cannot authorize handoff`, { timeout: 30000 }, async (t) => {
			// Arrange: still use the maintained SDK verification path, not supplied account claims.
			const f = await fixture(t, kind);
			if (failure === "wrong account") f.provider.claims.sub = "unlinked-subject";
			else f.provider.settings.signature = "wrong-key";
			// Act
			const c = await verify(f);
			// Assert
			assert.equal(c.response.status, 400);
			assert.deepEqual(await effects(f), [[], [], []]);
		});
	}

	test(`${kind}: lost HTTP reply reconciles with the retained exact proof`, {
		timeout: 30000,
	}, async (t) => {
		// Arrange: retain the original completion and pending-key signature, never start a replacement.
		const f = await fixture(t, kind);
		const input = await deliver(f, await verify(f));
		f.loseNextFinalReply();
		// Act
		await assert.rejects(f.finalize(), /socket hang up/);
		const before = await effects(f);
		const retry = await f.finalize();
		// Assert: unknown is not rollback; exact proof returns prior_commit without writing again.
		assert.strictEqual(await f.client.consumeCompletion(), input);
		assert.equal(before[0].length, 1);
		assert.equal(retry.kind, "prior_commit");
		assert.equal(retry.bindingId, before[0][0].binding_id);
		assert.deepEqual(await effects(f), before);
	});
}
