// Fake-only acceptance: no production owner routes, provider network, or user state.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { ownerHttpRequest } from "./owner-handoff-fixture.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(new URL("../../core/package.json", import.meta.url));
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
const { build } = runtimeRequire("esbuild");
const Database = coreRequire("better-sqlite3");
const coreDir = fileURLToPath(new URL("../../core", import.meta.url));
const artifacts = fileURLToPath(new URL("../../../.tmp", import.meta.url));
const migrations = await readD1Migrations(fileURLToPath(new URL("../migrations", import.meta.url)));
const origin = "https://app.example.test";
const scopeId = "synthetic-reviewed-project";

async function helpers(directory) {
	const bundle = await build({
		stdin: {
			contents: `
export { linkCoordinatorAccount } from './coordinator-account-link-runtime.ts';
export { createCoordinatorApp } from './coordinator-api.ts';
export { captureCoordinatorBrowserAuthOptions, createCoordinatorBrowserAuth } from './coordinator-browser-auth-app.ts';
export { createInMemoryRequestRateLimiter } from './request-rate-limit.ts';
export { verifySignature, buildDirectPeerAuthHeaders } from './sync-auth.ts';
export { D1CoordinatorStore } from './d1-coordinator-store.ts';
export { review } from './coordinator-auth-store-test-fixtures.ts';
export { oidcFixture, PROVIDER } from './coordinator-oidc-test-fixtures.ts';
export { browserForm, proof } from './coordinator-owner-enrollment-start-test-fixtures.ts';
export { createCoordinatorOwnerEnrollmentHttp } from './coordinator-owner-enrollment-http.ts';
export { runOwnerEnrollment } from './coordinator-owner-enrollment-client.ts';
export { COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL } from './coordinator-owner-enrollment-commit.ts';
export { initTestSchema } from './test-utils.ts';
export { MemoryStore } from './store.ts';
export { fingerprintPublicKey } from './sync-fingerprint.ts';
export { syncOnce } from './sync-pass.ts';
export { createSyncApp } from '../../viewer-server/src/index.ts';
export { loadReplicationOpsSince, filterReplicationOpsForSyncWithStatus, applyReplicationOps } from './sync-replication.ts';`,
			resolveDir: join(coreDir, "src"),
			sourcefile: "fake-only-two-device.ts",
		},
		bundle: true, write: false, platform: "node", format: "cjs", target: "node24",
		// Compile fixture-local defaults; runtime config/key paths are scoped and restored below.
		define: {
			// CJS has no import.meta; sync-discovery's createRequire needs a source URL.
			"import.meta.url": JSON.stringify(new URL("../../core/src/index.ts", import.meta.url).href),
			"import.meta.dirname": JSON.stringify(join(coreDir, "src")),
			"process.env.CODEMEM_EMBEDDING_DISABLED": '"1"',
			"process.env.CODEMEM_SYNC_KEY_STORE": '"file"',
		},
		plugins: [{
			name: "fixture-only-dependencies",
			setup(builder) {
				builder.onResolve({ filter: /^vitest$/ }, () => ({ path: "vitest", namespace: "fixture" }));
				builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
					contents: "export const vi = { fn: f => f }; export const it = {}; export const expect = () => { throw new Error('Unexpected Vitest assertion'); };",
					loader: "js",
				}));
				builder.onResolve({ filter: /^@codemem\/core$/ }, () => ({ path: join(coreDir, "src/index.ts") }));
				builder.onResolve({ filter: /^@codemem\/embeddings$/ }, () => ({
					path: fileURLToPath(new URL("../../embeddings/src/index.ts", import.meta.url)),
				}));
				builder.onResolve({ filter: /^[^./]/ }, async ({ path, pluginData, resolveDir }) => {
					if (pluginData?.resolving) return;
					if (path.startsWith("node:")) return { path, external: true };
					const resolved = await builder.resolve(path, {
						kind: "import-statement", resolveDir: resolveDir || coreDir, pluginData: { resolving: true },
					});
					return { path: resolved.path, external: true, errors: resolved.errors };
				});
			},
		}],
	});
	const path = join(directory, "helpers.cjs");
	await writeFile(path, bundle.outputFiles[0].text);
	await writeFile(join(directory, "config.json"), "{}");
	return require(path);
}

function key() {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	return {
		publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
		privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
		sign: message => sign(null, Buffer.from(message), keys.privateKey).toString("base64url"),
	};
}

async function device(h, directory, deviceId) {
	const keysDir = join(directory, deviceId);
	await mkdir(keysDir);
	const k = key();
	await writeFile(join(keysDir, "device.key"), k.privateKey, { mode: 0o600 });
	await writeFile(join(keysDir, "device.key.pub"), k.publicKey);
	const dbPath = join(keysDir, "memory.sqlite");
	const db = new Database(dbPath);
	h.initTestSchema(db);
	db.prepare("INSERT INTO sync_device(device_id,public_key,fingerprint,created_at) VALUES (?,?,?,?)")
		.run(deviceId, k.publicKey, h.fingerprintPublicKey(k.publicKey), new Date().toISOString());
	db.close();
	const store = new h.MemoryStore(dbPath, { keysDir, runtimeSigningKey: { deviceId, publicKey: k.publicKey } });
	// Embeddings are an external service, not part of this acceptance boundary.
	store.enqueueVectorWrite = () => {};
	return { deviceId, key: k, keysDir, dbPath, store };
}

async function coordinator(h, now) {
	const mf = new Miniflare(convertV4MiniflareOptions({
		modules: true,
		script: "export default { fetch() { return new Response(null, {status:404}); } };",
		compatibilityDate: "2026-03-28", compatibilityFlags: ["nodejs_compat"],
		d1Databases: { DB: "synthetic-two-device" }, cf: false, host: "127.0.0.1", port: 0,
		outboundService: () => { throw new Error("External network forbidden"); },
	}));
	const db = await mf.getD1Database("DB");
	for (const migration of migrations) await db.batch(migration.queries.map(sql => db.prepare(sql)));
	await db.prepare(h.COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL).run();
	const prepare = s => db.prepare(s.sql).bind(...s.values);
	return {
		dispose: () => mf.dispose(),
		store: new h.D1CoordinatorStore(db, { authClock: () => now }),
		backend: {
			first: s => prepare(s).first(),
			run: async s => (await prepare(s).run()).meta.changes,
			batch: async statements => { await db.batch(statements.map(prepare)); },
		},
		rows: async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
	};
}

// Small native HTTP adapter for A's maintained signed/browser app. No new routes.
async function linkDispatcher(t, app) {
	const server = createServer(async (incoming, response) => {
		try {
			const chunks = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const result = await app.fetch(new Request(new URL(incoming.url, origin), {
				method: incoming.method, headers: incoming.headers,
				body: incoming.method === "GET" ? undefined : Buffer.concat(chunks),
			}));
			const headers = Object.fromEntries(result.headers);
			headers["set-cookie"] = result.headers.getSetCookie();
			response.writeHead(result.status, headers);
			response.end(Buffer.from(await result.arrayBuffer()));
		} catch { response.writeHead(500); response.end(); }
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise(resolve => server.close(resolve));
	});
	const base = `http://127.0.0.1:${server.address().port}`;
	return async (url, init = {}) => {
		const target = new URL(url);
		assert.equal(target.origin, origin);
		const result = await ownerHttpRequest(`${base}${target.pathname}${target.search}`, init);
		const headers = new Headers();
		for (const [name, values] of Object.entries(result.headers)) {
			for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
		}
		return new Response(result.body || null, { status: result.status, headers });
	};
}

function cookie(response) {
	const value = response.headers.getSetCookie().find(value => !value.includes("Max-Age=0"));
	assert.ok(value, "Original browser cookie missing");
	return value.split(";")[0];
}

async function fields(response, action) {
	assert.equal(response.status, 200);
	const html = await response.text();
	const markup = html.match(new RegExp(`<form[^>]+action="${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1];
	assert.ok(markup, "Expected browser form missing");
	return new URLSearchParams([...markup.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map(m => [m[1], m[2]]));
}

async function linkA(f) {
	const { h, remote, a, config, provider, now, t } = f;
	const review = h.review({ identityId: a.store.actorId, publicKey: a.key.publicKey, fingerprint: h.fingerprintPublicKey(a.key.publicKey) });
	await remote.store.createGroup(review.groupId, "Fake transport group");
	await remote.store.enrollDevice(review.groupId, { ...review, identityId: null });
	assert.equal((await remote.store.createAuthControllerAttestation(review)).kind, "created");
	const csrfKey = (await h.browserForm("unused", h.proof())).csrfKey;
	const auth = await h.createCoordinatorBrowserAuth(h.captureCoordinatorBrowserAuthOptions({
		config, csrfKey, oidcOptions: { fetch: provider.fetch },
	}), remote.store, h.createInMemoryRequestRateLimiter({ now: () => now }));
	assert.equal(auth.ok, true);
	const app = h.createCoordinatorApp({
		storeFactory: () => remote.store,
		runtime: { adminSecret: () => null, now: () => new Date(now).toISOString() },
		requestVerifier: input => h.verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: { kind: "ready", auth: auth.auth, storeFactory: () => remote.store, clientKey: () => "fake-browser-a" },
	});
	const request = await linkDispatcher(t, app);
	let browserDone;
	const result = await h.linkCoordinatorAccount({
		dbPath: a.dbPath, keysDir: a.keysDir, coordinatorUrl: origin, groupId: review.groupId,
		fetch: request,
		onBrowserStart: url => {
			browserDone = linkBrowser(request, provider, url);
			void browserDone.catch(() => {});
		},
	});
	await browserDone;
	assert.equal(result.state, "finalized");
	assert.equal(result.identityId, review.identityId);
	const links = await remote.rows("coordinator_auth_account_links");
	assert.equal(links.length, 1);
	assert.equal(links[0].attempt_id, result.attemptId);
	assert.equal(links[0].subject, "fixture-subject");
	assert.equal(links[0].controller_attestation_id, review.attestationId);
	assert.equal((await remote.rows("coordinator_auth_link_audit_log")).length, 1);
	assert.equal((await remote.store.issueIdentityGroupGrantFromControllerAttestation({
		coordinatorId: review.coordinatorId, attestationId: review.attestationId,
	})).kind, "created");
	return result;
}

async function linkBrowser(request, provider, url) {
	const page = await request(url);
	const binder = cookie(page);
	const started = await request(`${origin}/auth/link/start`, {
		method: "POST", headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
		body: (await fields(page, "/auth/link/start")).toString(),
	});
	assert.equal(started.status, 200);
	const transactionCookie = cookie(started);
	const html = await started.text();
	const href = html.match(/href="(https:[^"]+\/authorize[^\"]+)"/)?.[1];
	assert.ok(href);
	const callback = provider.authorize(href.replaceAll("&amp;", "&"));
	const verified = await request(callback, { headers: { cookie: transactionCookie } });
	const confirmed = await request(`${origin}/auth/link/confirm`, {
		method: "POST", headers: { origin, cookie: transactionCookie, "content-type": "application/x-www-form-urlencoded" },
		body: (await fields(verified, "/auth/link/confirm")).toString(),
	});
	assert.equal(confirmed.status, 200);
	const hop = (await confirmed.text()).match(/href="(http:\/\/127\.0\.0\.1[^\"]+)"/)?.[1];
	assert.ok(hop);
	assert.equal((await ownerHttpRequest(hop.replaceAll("&amp;", "&"))).status, 200);
}

async function fixture(t) {
	// Explicit reverse acquisition order: close servers/stores before removing files.
	const cleanup = [];
	t.after(async () => {
		const errors = [];
		for (const close of cleanup.reverse()) {
			try { await close(); } catch (error) { errors.push(error); }
		}
		if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
	});
	t = { mock: t.mock, after: close => cleanup.push(close) };
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	let syncOrigin;
	t.mock.method(globalThis, "fetch", async (input, init) => {
		if (!syncOrigin) throw new Error("External network forbidden");
		const request = new Request(input, init);
		assert.equal(new URL(request.url).origin, syncOrigin, "External network forbidden");
		const result = await ownerHttpRequest(request.url, {
			method: request.method, headers: Object.fromEntries(request.headers),
			body: Buffer.from(await request.arrayBuffer()),
		});
		return new Response(result.body || null, { status: result.status, headers: result.headers });
	});
	await mkdir(artifacts, { recursive: true });
	const directory = await mkdtemp(join(artifacts, "two-device-owner-"));
	const environment = Object.fromEntries(["CODEMEM_CONFIG", "CODEMEM_ACTOR_ID", "CODEMEM_DEVICE_ID", "CODEMEM_KEYS_DIR"].map(name => [name, process.env[name]]));
	process.env.CODEMEM_CONFIG = join(directory, "config.json");
	for (const name of ["CODEMEM_ACTOR_ID", "CODEMEM_DEVICE_ID", "CODEMEM_KEYS_DIR"]) delete process.env[name];
	t.after(() => {
		for (const [name, value] of Object.entries(environment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	let a;
	let remote;
	t.after(async () => {
		a?.store.close();
		await remote?.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	const h = await helpers(directory);
	const config = {
		enabled: true, coordinatorId: "coordinator-a", revision: "a".repeat(64),
		issuer: "https://accounts.google.com", clientId: h.PROVIDER.clientId,
		clientSecret: h.PROVIDER.clientSecret, redirectUri: `${origin}/auth/callback`,
	};
	const provider = h.oidcFixture({ issuer: config.issuer });
	provider.claims.picture = undefined;
	a = await device(h, directory, "device-a");
	remote = await coordinator(h, now);
	const f = { t, h, a, remote, config, provider, now, directory,
		allowSyncOrigin: url => { syncOrigin = url; } };
	f.link = await linkA(f);
	return f;
}

async function ownerEffects(f) {
	return Promise.all(["coordinator_device_ownership_bindings", "coordinator_owner_enrollment_audit_log"].map(f.remote.rows));
}

function provisionScope(device, peer, now) {
	const db = device.store.db;
	const timestamp = new Date(now).toISOString();
	// Explicit independent local policy, not an inference from the owner transport grant.
	db.prepare(`INSERT INTO replication_scopes(scope_id,label,kind,authority_type,membership_epoch,status,created_at,updated_at)
		VALUES (?, 'Synthetic Project', 'team', 'manual', 1, 'active', ?, ?)`)
		.run(scopeId, timestamp, timestamp);
	for (const id of [device.deviceId, peer.deviceId]) {
		db.prepare(`INSERT INTO scope_memberships(scope_id,device_id,role,status,membership_epoch,updated_at)
			VALUES (?, ?, 'member', 'active', 1, ?)`).run(scopeId, id, timestamp);
	}
	db.prepare(`INSERT INTO sync_peers(peer_device_id,public_key,pinned_fingerprint,created_at)
		VALUES (?, ?, ?, ?)`).run(peer.deviceId, peer.key.publicKey, device.fingerprint(peer.key.publicKey), timestamp);
}

function capture(f) {
	const { a, h } = f;
	const session = a.store.startSession({
		cwd: "/synthetic/device-a/workspace", project: "synthetic-project",
		gitRemote: "https://example.test/synthetic.git", gitBranch: "synthetic-local-branch",
		user: "synthetic-user", toolVersion: "synthetic-test", metadata: { local_only: "synthetic-session-metadata" },
	});
	a.store.db.prepare(`INSERT INTO project_scope_mappings(workspace_identity,project_pattern,scope_id,priority,source,created_at,updated_at)
		VALUES (?, ?, ?, 100, 'user', ?, ?)`).run("/synthetic/device-a/workspace", "/synthetic/device-a/workspace", scopeId, new Date(f.now).toISOString(), new Date(f.now).toISOString());
	const id = a.store.remember(session, "discovery", "Synthetic portable memory", "A captured this local fact.", 0.8,
		["synthetic"], { visibility: "shared", workspace_id: scopeId, workspace_kind: "shared", origin_source: "manual" });
	const memory = a.store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id);
	assert.equal(memory.scope_id, scopeId);
	const [loaded] = h.loadReplicationOpsSince(a.store.db, null, 100);
	const ops = loaded.filter(op => op.entity_id === memory.import_key);
	assert.equal(ops.length, 1);
	return { memory, ops };
}

function replicate(f, ops) {
	const [allowed] = f.h.filterReplicationOpsForSyncWithStatus(f.a.store.db, ops, f.b.deviceId, { localDeviceId: f.a.deviceId });
	return f.h.applyReplicationOps(f.b.store.db, allowed, f.b.deviceId, f.b.store.scanner, {
		inboundScopeValidation: { peerDeviceId: f.a.deviceId, enabled: true }, keysDir: f.b.keysDir,
	});
}

async function syncServer(f) {
	const app = f.h.createSyncApp({ storeFactory: () => f.b.store });
	const requests = [];
	let url;
	const server = createServer(async (incoming, response) => {
		const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
		process.env.CODEMEM_KEYS_DIR = f.b.keysDir;
		try {
			const chunks = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			const headers = new Headers();
			for (let index = 0; index < incoming.rawHeaders.length; index += 2)
				headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
			const target = new URL(incoming.url, url);
			assert.equal(target.origin, url);
			const wire = { method: incoming.method, path: target.pathname, headers, body: bytes.toString() };
			requests.push(wire);
			const result = await app.fetch(new Request(target, {
				method: incoming.method, headers,
				body: ["GET", "HEAD"].includes(incoming.method) ? undefined : bytes,
			}));
			wire.status = result.status;
			response.writeHead(result.status, Object.fromEntries(result.headers));
			response.end(Buffer.from(await result.arrayBuffer()));
		} catch { response.writeHead(500); response.end(); }
		finally {
			if (previousKeysDir === undefined) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
		}
	});
	f.t.after(() => {
		server.closeAllConnections();
		return new Promise(resolve => server.close(resolve));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	url = `http://127.0.0.1:${server.address().port}`;
	f.allowSyncOrigin(url);
	return { url, requests };
}

async function maintainedOwnerB(f) {
	const profileDir = join(f.directory, "owner-profile-b");
	const http = await f.h.createCoordinatorOwnerEnrollmentHttp({ config: f.config, backend: f.remote.backend,
		oidcOptions: { fetch: f.provider.fetch }, clock: () => f.now });
	const request = await linkDispatcher(f.t, { fetch: r => http.handle(r, "owner-socket") });
	const openBrowser = async url => {
		const page = await request(url);
		const claimed = await request(`${origin}/auth/owner/start`, { method: "POST",
			headers: { origin, cookie: cookie(page), "content-type": "application/x-www-form-urlencoded" },
			body: (await fields(page, "/auth/owner/start")).toString() });
		assert.equal(claimed.status, 303);
		const binder = cookie(claimed);
		const callback = await request(f.provider.authorize(claimed.headers.get("location")), { headers: { cookie: binder } });
		const confirmed = await request(`${origin}/auth/owner/confirm`, { method: "POST",
			headers: { origin, cookie: binder, "content-type": "application/x-www-form-urlencoded" },
			body: (await fields(callback, "/auth/owner/confirm")).toString() });
		assert.equal(confirmed.status, 303);
		assert.equal((await ownerHttpRequest(confirmed.headers.get("location"), {
			headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
		})).status, 200);
	};
	const previousConfig = process.env.CODEMEM_CONFIG;
	process.env.CODEMEM_CONFIG = join(profileDir, "config.json");
	try {
		const receipt = await f.h.runOwnerEnrollment({ profileDir, coordinatorUrl: origin, groupId: "group-a", fetch: request, openBrowser });
		const privateKey = await readFile(join(profileDir, "keys/device.key"), "utf8");
		const keysDir = join(profileDir, "keys");
		const store = new f.h.MemoryStore(join(profileDir, "mem.sqlite"), { keysDir });
		f.t.after(() => store.close());
		store.enqueueVectorWrite = () => {};
		const publicKey = (await readFile(join(keysDir, "device.key.pub"), "utf8")).trim();
		f.b = { store, keysDir, deviceId: store.deviceId,
			key: { publicKey } };
		assert.equal(await readFile(join(keysDir, "device.key"), "utf8"), privateKey);
		assert.equal(store.actorId, receipt.identityId);
		assert.equal(store.db.prepare("SELECT identity_id FROM identity_devices WHERE device_id=?").get(store.deviceId).identity_id, receipt.identityId);
		assert.equal(JSON.parse(await readFile(join(profileDir, "config.json"), "utf8")).actor_id, receipt.identityId);
		return receipt;
	} finally {
		if (previousConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = previousConfig;
	}
}

test("fake-only A runtime link → maintained B owner client → separately scoped portable capture", { timeout: 60000 }, async t => {
	// Arrange: B does not exist until the maintained client creates its isolated profile.
	const f = await fixture(t);
	const authority = await Promise.all(["coordinator_auth_account_links", "coordinator_identity_group_grants", "coordinator_scope_memberships"].map(f.remote.rows));
	// Act: real browser forms, SDK and receiver create B from the verified receipt.
	const receipt = await maintainedOwnerB(f);
	// Assert: only the verified receipt adopts B; A identity is compared, never injected.
	assert.equal(receipt.kind, "finalized");
	assert.equal(receipt.identityId, f.a.store.actorId);
	assert.equal(receipt.identityId, f.link.identityId);
	assert.notEqual(f.a.key.publicKey, f.b.key.publicKey);
	const [bindings, audits] = await ownerEffects(f);
	assert.equal(bindings.length, 1);
	assert.equal(audits.length, 1);
	assert.equal(bindings[0].device_id, f.b.deviceId);
	assert.equal(bindings[0].identity_id, receipt.identityId);
	assert.equal(receipt.bindingId, bindings[0].binding_id);
	const enrollments = await f.remote.rows("enrolled_devices");
	assert.equal(enrollments.length, 2);
	const enrolledB = enrollments.find(row => row.device_id === f.b.deviceId);
	assert.equal(enrolledB?.identity_id, f.link.identityId);
	assert.equal(enrolledB?.public_key, f.b.key.publicKey);
	assert.equal(enrolledB?.group_id, enrollments.find(row => row.device_id === f.a.deviceId)?.group_id);
	assert.deepEqual(await Promise.all(["coordinator_auth_account_links", "coordinator_identity_group_grants", "coordinator_scope_memberships"].map(f.remote.rows)), authority);
	assert.equal(authority[2].length, 0);
	for (const d of [f.a, f.b]) assert.equal(d.store.db.prepare("SELECT COUNT(*) AS n FROM scope_memberships").get().n, 0);
	await scopedCaptureAcceptance(f);
	assert.ok(f.provider.requests.some(({ url }) => url.endsWith("/token")));
	assert.ok(f.provider.requests.some(({ url }) => url.endsWith("/jwks")));
	assert.ok(globalThis.fetch.mock.callCount() > 0, "syncOnce used the owned HTTP server");
});

async function scopedCaptureAcceptance(f) {
	// Arrange/Act: owner enrollment alone cannot authenticate signed A-to-B HTTP sync.
	const server = await syncServer(f);
	const denied = await f.h.syncOnce(f.a.store.db, f.b.deviceId, [server.url], {
		keysDir: f.a.keysDir, scanner: f.a.store.scanner,
	});
	// syncOnce refuses a missing local pin; separately prove the receiver denies signed HTTP.
	const statusUrl = `${server.url}/v1/status`;
	const response = await globalThis.fetch(statusUrl, { headers: f.h.buildDirectPeerAuthHeaders({
		deviceId: f.a.deviceId, recipientId: f.b.deviceId, method: "GET", url: statusUrl,
		bodyBytes: Buffer.alloc(0), keysDir: f.a.keysDir,
	}) });
	// Assert: owner enrollment is neither a local peer pin nor receiver-side trust.
	assert.equal(denied.ok, false);
	assert.equal(denied.failureCategory, "trust");
	assert.equal(response.status, 401);
	assert.ok(server.requests.some(request => request.status === 401 && request.headers.get("X-Opencode-Signature")));
	assert.equal(f.b.store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get().n, 0);
	// Arrange: explicitly provision local scope memberships and exact peer-key trust on A/B.
	for (const d of [f.a, f.b]) d.fingerprint = f.h.fingerprintPublicKey;
	provisionScope(f.a, f.b, f.now);
	provisionScope(f.b, f.a, f.now);
	const { memory, ops } = capture(f);
	// In-process preflight: revoked memberships deny even though B is owner-enrolled.
	f.a.store.db.prepare("UPDATE scope_memberships SET status='revoked' WHERE device_id=?").run(f.b.deviceId);
	assert.equal(replicate(f, ops).applied, 0);
	f.a.store.db.prepare("UPDATE scope_memberships SET status='active' WHERE device_id=?").run(f.b.deviceId);
	f.b.store.db.prepare("UPDATE scope_memberships SET status='revoked' WHERE device_id=?").run(f.b.deviceId);
	assert.equal(replicate(f, ops).applied, 0);
	assert.equal(f.b.store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get().n, 0);
	f.b.store.db.prepare("UPDATE scope_memberships SET status='active' WHERE device_id=?").run(f.b.deviceId);
	await assert.rejects(globalThis.fetch("https://example.test/not-owned"), /External network forbidden/);
	const result = await f.h.syncOnce(f.a.store.db, f.b.deviceId, [server.url], {
		keysDir: f.a.keysDir, scanner: f.a.store.scanner,
	});
	// Assert: portable fields survive; local session context never crosses the replication wire.
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.opsOut, 1);
	const pushed = server.requests.filter(request => request.method === "POST" && request.path === "/v1/ops");
	assert.equal(pushed.length, 1);
	assert.equal(pushed[0].headers.get("X-Opencode-Device"), f.a.deviceId);
	assert.ok(pushed[0].headers.get("X-Opencode-Signature"));
	const received = f.b.store.db.prepare("SELECT * FROM memory_items WHERE import_key=?").get(memory.import_key);
	for (const field of ["kind", "title", "body_text", "confidence", "tags_text", "actor_id", "actor_display_name", "origin_device_id", "visibility", "workspace_id", "workspace_kind", "scope_id", "trust_state", "origin_source", "project", "import_key", "created_at", "updated_at", "rev"]) {
		assert.equal(received[field], memory[field], `Portable field ${field}`);
	}
	assert.ok(memory.dedup_key, "A has a local deduplication key");
	assert.equal(received.dedup_key, null, "A's session-local deduplication key is not replicated");
	assert.equal(received.origin_device_id, f.a.deviceId);
	assert.equal(received.actor_id, f.link.identityId);
	const session = f.b.store.db.prepare("SELECT * FROM sessions WHERE id=?").get(received.session_id);
	assert.equal(session.cwd, null, "direct replication creates no copy of A's local directory");
	assert.equal(session.project, "synthetic-project");
	assert.equal(session.git_remote, null);
	assert.equal(session.git_branch, null);
	const wire = pushed[0].body;
	for (const local of ["/synthetic/device-a/workspace", "https://example.test/synthetic.git", "synthetic-local-branch", "synthetic-session-metadata", "synthetic-user"]) {
		assert.ok(!wire.includes(local));
		assert.ok(!JSON.stringify(session).includes(local));
	}
	assert.equal(replicate(f, ops).applied, 0, "In-process replay preflight remains idempotent");
	assert.equal(f.b.store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get().n, 1);
}
