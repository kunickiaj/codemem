// Disposable configured Worker, synthetic OIDC, real native HTTP and local keys.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS } from "@codemem/core";
import { ownerHttpRequest } from "./owner-handoff-fixture.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(new URL("../../core/package.json", import.meta.url));
const Database = coreRequire("better-sqlite3");
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
const { build } = runtimeRequire("esbuild");
const coreDir = fileURLToPath(new URL("../../core", import.meta.url));
const migrations = await readD1Migrations(fileURLToPath(new URL("../migrations", import.meta.url)));
export const origin = "https://app.example.test";
export const groupId = "journey-discovery";
export const teamId = "journey-team";

export function recordFixtureHttpFailure({ response, error, errors }) {
	errors.push(error);
	if (response.headersSent) {
		response.destroy();
		return;
	}
	response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
	response.end("Fixture request failed.");
}

async function helpers(directory) {
	const result = await build({
		stdin: { resolveDir: join(coreDir, "src"), sourcefile: "qualified-owner-fixture.ts", contents: `
export { createConfiguredCloudflareCoordinatorWorker } from '../../cloudflare-coordinator-worker/src/index.ts';
export { D1CoordinatorStore } from './d1-coordinator-store.ts';
export { oidcFixture, PROVIDER } from './coordinator-oidc-test-fixtures.ts';
export { MemoryStore } from './store.ts';
export { syncRoutes, reconcileConfiguredCoordinatorEnrollment, createRecipientPolicyReconcilerEffects, reconcileRecipientPolicyProjects } from '../../viewer-server/src/routes/sync.ts';
export { createSyncApp } from '../../viewer-server/src/index.ts';
export { readCoordinatorSyncConfig } from './coordinator-sync-config.ts';
export { refreshAuthorizedCoordinatorPeerTrust, registerCoordinatorPresence } from './coordinator-runtime.ts';
export { buildAuthHeaders, buildDirectPeerAuthHeaders } from './sync-auth.ts';
export { updatePeerAddresses } from './sync-peer-addresses.ts';
export { syncOnce } from './sync-pass.ts';
export { coordinatorRevokeDeviceAction } from './coordinator-device-revocation-client.ts';
export { ensureDeviceIdentity } from './sync-identity.ts';
export { coordinatorImportInviteAction, coordinatorCreateScopeAction, coordinatorGrantScopeMembershipAction } from './coordinator-actions.ts';
export { previewRecipientPolicyEdges, commitRecipientPolicyEdges } from './recipient-policy-edges.ts';
export { upsertProjectScopeSettingsMappings } from './project-scope-settings.ts';
export { refreshScopeMembershipCache } from './scope-membership-cache.ts';
export { ACCOUNT_CONNECTION_MIGRATION_STATEMENTS } from './coordinator-account-connection-schema.ts';
export { recipientReviewedIntentDigest } from './recipient-reviewed-intent.ts';
export { previewRecipientPolicyOnboardingFromReviewedIntent } from './recipient-policy-onboarding.ts';
export { linkCoordinatorAccount } from './coordinator-account-link-runtime.ts';
export { readCoordinatorAccountLinkStatus } from './coordinator-account-link-status-client.ts';
export { enrollOwnerProfile } from './coordinator-owner-profile-client.ts';
export { COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL } from './coordinator-owner-enrollment-commit.ts';
` },
		bundle: true, write: false, platform: "node", format: "cjs", target: "node24",
		define: {
			"import.meta.url": JSON.stringify(new URL("../../core/src/index.ts", import.meta.url).href),
			"import.meta.dirname": JSON.stringify(join(coreDir, "src")),
			"process.env.CODEMEM_EMBEDDING_DISABLED": '"1"',
			"process.env.CODEMEM_SYNC_KEY_STORE": '"file"',
		},
		plugins: [{ name: "fixture-dependencies", setup(builder) {
			builder.onResolve({ filter: /^@codemem\/core\/internal\/cloudflare-coordinator$/ }, () => ({
				path: join(coreDir, "src/internal/cloudflare-coordinator.ts"),
			}));
			builder.onResolve({ filter: /^vitest$/ }, () => ({ path: "vitest", namespace: "fixture" }));
			builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
				contents: "export const vi = { fn: f => f };", loader: "js",
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
		} }],
	});
	const path = join(directory, "helpers.cjs");
	await writeFile(path, result.outputFiles[0].text);
	return require(path);
}

export async function fields(response, action) {
	assert.equal(response.status, 200, await response.clone().text());
	const html = await response.text();
	const markup = html.match(new RegExp(`<form[^>]+action="${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1];
	assert.ok(markup, `Missing ${action} form`);
	return new URLSearchParams([...markup.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map(m => [m[1], m[2]]));
}

export function cookie(response) {
	const value = response.headers.getSetCookie().find(value => !value.includes("Max-Age=0"));
	assert.ok(value, "Missing browser cookie");
	return value.split(";")[0];
}

export async function journeyFixture(t) {
	const cleanup = [];
	const serverErrors = [];
	t.after(async () => {
		const errors = [];
		for (const close of cleanup.reverse()) {
			try { await close(); } catch (error) { errors.push(error); }
		}
		errors.push(...serverErrors);
		if (errors.length) throw new AggregateError(errors, "Journey cleanup failed");
	});
	const artifacts = fileURLToPath(new URL("../../../.tmp", import.meta.url));
	await mkdir(artifacts, { recursive: true });
	const directory = await mkdtemp(join(artifacts, "qualified-owner-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const configPath = join(directory, "config.json");
	await writeFile(configPath, "{}");
	const envNames = ["CODEMEM_CONFIG", "CODEMEM_ACTOR_ID", "CODEMEM_DEVICE_ID", "CODEMEM_KEYS_DIR", "CODEMEM_DB", "CODEMEM_ACTOR_DISPLAY_NAME", "CODEMEM_SYNC_COORDINATOR_GROUP", "CODEMEM_SYNC_COORDINATOR_GROUPS", "CODEMEM_WORKSPACE_ID",
		"CODEMEM_SYNC_COORDINATOR_URL", "CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET"];
	const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
	for (const name of envNames) delete process.env[name];
	process.env.CODEMEM_CONFIG = configPath;
	cleanup.push(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const h = await helpers(directory);
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const provider = h.oidcFixture({ issuer: "https://accounts.google.com" });
	provider.claims.picture = undefined;
	const mf = new Miniflare(convertV4MiniflareOptions({
		modules: true, script: "export default { fetch() { return new Response(null, {status:404}); } };",
		compatibilityDate: "2026-03-28", compatibilityFlags: ["nodejs_compat"],
		d1Databases: { DB: "qualified-owner-journey" }, cf: false, host: "127.0.0.1", port: 0,
		outboundService: () => { throw new Error("External network forbidden"); },
	}));
	cleanup.push(() => mf.dispose());
	const db = await mf.getD1Database("DB");
	for (const migration of migrations) await db.batch(migration.queries.map(sql => db.prepare(sql)));
	await db.batch(AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS.map(sql => db.prepare(sql)));
	// Current account qualification requires the maintained explicit connection-schema upgrade,
	// which is intentionally separate from the numbered D1 migrations. Apply it before any profiles exist.
	await db.batch(h.ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.map(sql => db.prepare(sql)));
	await db.prepare(h.COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL).run();
	const remote = new h.D1CoordinatorStore(db, { authClock: () => now });
	// The sole direct remote setup operation is the discovery group, not enrollment or authority.
	await remote.createGroup(groupId, "Synthetic journey transport");
	const { clientSecret, ...config } = {
		enabled: true, coordinatorId: "journey-browser-namespace", revision: "a".repeat(64),
		issuer: "https://accounts.google.com", clientId: h.PROVIDER.clientId,
		clientSecret: h.PROVIDER.clientSecret, redirectUri: `${origin}/auth/callback`, ownerEnrollmentEnabled: true,
	};
	const adminSecret = "synthetic-journey-admin";
	const workerEnv = {
		COORDINATOR_DB: db, CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: adminSecret,
		CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(config),
		CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: clientSecret, CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: "b".repeat(64),
	};
	const worker = h.createConfiguredCloudflareCoordinatorWorker();
	const requests = [];
	const server = createServer(async (incoming, response) => {
		try {
			const chunks = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			const request = new Request(new URL(incoming.url, origin), {
				method: incoming.method, headers: incoming.headers,
				body: ["GET", "HEAD"].includes(incoming.method) ? undefined : bytes,
			});
			request.headers.set("CF-Connecting-IP", "127.0.0.1");
			const result = await worker.fetch(request, workerEnv);
			requests.push({ path: incoming.url, status: result.status });
			response.writeHead(result.status, { ...Object.fromEntries(result.headers), "set-cookie": result.headers.getSetCookie() });
			response.end(Buffer.from(await result.arrayBuffer()));
		} catch (error) { recordFixtureHttpFailure({ response, error, errors: serverErrors }); }
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	cleanup.push(() => {
		server.closeAllConnections();
		return new Promise(resolve => server.close(resolve));
	});
	const nativeOrigin = `http://127.0.0.1:${server.address().port}`;
	const viewerOrigins = new Set();
	const request = async (input, init) => {
		const r = new Request(input, init);
		assert.equal(new URL(r.url).origin, origin, "External network forbidden");
		const result = await ownerHttpRequest(`${nativeOrigin}${new URL(r.url).pathname}${new URL(r.url).search}`, {
			method: r.method, headers: Object.fromEntries(r.headers),
			body: ["GET", "HEAD"].includes(r.method) ? undefined : Buffer.from(await r.arrayBuffer()),
		});
		const headers = new Headers();
		for (const [name, values] of Object.entries(result.headers))
			for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
		return new Response(result.body || null, { status: result.status, headers });
	};
	t.mock.method(globalThis, "fetch", async (input, init) => {
		const target = new URL(input instanceof Request ? input.url : String(input));
		if (target.origin === "https://accounts.google.com") return provider.fetch(input, init);
		if (viewerOrigins.has(target.origin)) {
			const r = new Request(input, init);
			const result = await ownerHttpRequest(r.url, { method: r.method, headers: Object.fromEntries(r.headers),
				body: ["GET", "HEAD"].includes(r.method) ? undefined : Buffer.from(await r.arrayBuffer()) });
			return new Response(result.body || null, { status: result.status, headers: result.headers });
		}
		return request(input, init);
	});
	const admin = async (path, body) => request(`${origin}${path}`, {
		method: "POST", headers: { "X-Codemem-Coordinator-Admin": adminSecret, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const keysDir = join(directory, "a-keys");
	await mkdir(keysDir);
	const keys = generateKeyPairSync("ed25519");
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11); wire.write("ssh-ed25519", 4); wire.writeUInt32BE(32, 15);
	Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32).copy(wire, 19);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	await writeFile(join(keysDir, "device.key"), keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	await writeFile(join(keysDir, "device.key.pub"), publicKey);
	return { h, directory, configPath, keysDir, dbPath: join(directory, "a.sqlite"), publicKey, adminSecret,
		now, provider, request, admin, requests, db, remote, serverErrors,
		rows: async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results,
		openStore: () => {
			const store = new h.MemoryStore(join(directory, "a.sqlite"), { keysDir });
			store.enqueueVectorWrite = () => {};
			cleanup.push(() => { if (store.db.open) store.close(); });
			return store;
		},
		createProfile: async name => {
			const base = join(directory, name);
			const paths = { dbPath: join(base, "memory.sqlite"), configPath: join(base, "config.json"),
				keysDir: join(base, "keys"), stateDir: join(base, "enrollment") };
			await mkdir(paths.keysDir, { recursive: true });
			await writeFile(paths.configPath, "{}", { mode: 0o600 });
			const previousConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = paths.configPath;
			try {
				const store = new h.MemoryStore(paths.dbPath, { keysDir: paths.keysDir });
				store.enqueueVectorWrite = () => {};
				cleanup.push(() => { if (store.db.open) store.close(); });
				// Capture while the device is still local-only, then let maintained key adoption associate its birth.
				const session = store.startSession({ project: "b-original-private-project" });
				store.remember(session, "discovery", "B preexisting history", "Keep B's original author even after adoption.", 0.8);
				const [deviceId] = h.ensureDeviceIdentity(store.db, { keysDir: paths.keysDir });
				store.adoptEnsuredDeviceIdentity(deviceId);
				// The ordinary Viewer inventory read initializes the local actor record; it grants no Identity binding.
				const app = h.syncRoutes(() => store, () => null);
				process.env.CODEMEM_KEYS_DIR = paths.keysDir;
				try {
					const inventory = await app.fetch(new Request("http://127.0.0.1/api/sync/recipient-policy/v1/device-inventory"));
					assert.equal(inventory.status, 200, await inventory.clone().text());
				} finally { delete process.env.CODEMEM_KEYS_DIR; }
				store.close();
				return { ...paths, deviceId };
			} finally { process.env.CODEMEM_CONFIG = previousConfig; }
		},
		profileRows: (paths, table) => {
			const local = new Database(paths.dbPath, { readonly: true });
			try { return local.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
			finally { local.close(); }
		},
		openProfile: paths => {
			const store = new h.MemoryStore(paths.dbPath, { keysDir: paths.keysDir });
			store.enqueueVectorWrite = () => {};
			cleanup.push(() => { if (store.db.open) store.close(); });
			return store;
		},
		serveProfile: async (store, paths) => {
			const app = h.createSyncApp({ storeFactory: () => store });
			const wires = [];
			let url;
			const listener = createServer(async (incoming, response) => {
				const previous = process.env.CODEMEM_KEYS_DIR;
				process.env.CODEMEM_KEYS_DIR = paths.keysDir;
				try {
					const chunks = [];
					for await (const chunk of incoming) chunks.push(chunk);
					const body = Buffer.concat(chunks);
					const result = await app.fetch(new Request(new URL(incoming.url, url), {
						method: incoming.method, headers: incoming.headers,
						body: ["GET", "HEAD"].includes(incoming.method) ? undefined : body,
					}));
					wires.push({ path: incoming.url, status: result.status, headers: incoming.headers, body: body.toString() });
					response.writeHead(result.status, Object.fromEntries(result.headers));
					response.end(Buffer.from(await result.arrayBuffer()));
				} catch (error) { recordFixtureHttpFailure({ response, error, errors: serverErrors }); }
				finally {
					if (previous === undefined) delete process.env.CODEMEM_KEYS_DIR;
					else process.env.CODEMEM_KEYS_DIR = previous;
				}
			});
			await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
			url = `http://127.0.0.1:${listener.address().port}`;
			viewerOrigins.add(url);
			cleanup.push(() => { listener.closeAllConnections(); return new Promise(resolve => listener.close(resolve)); });
			return { url, wires };
		},
	};
}
