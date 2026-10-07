// Manual browser fixture, deliberately not registered with either test runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { request as httpsRequest, createServer as httpsServer } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";

const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(new URL("../../core/package.json", import.meta.url));
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
const { build } = runtimeRequire("esbuild");
const root = fileURLToPath(new URL("../../..", import.meta.url));
const artifacts = join(root, ".tmp");
mkdirSync(artifacts, { recursive: true });
const dir = mkdtempSync(join(artifacts, "browser-auth-fixture-"));
const certPath = join(dir, "localhost.crt");
const keyPath = join(dir, "localhost.key");
// This key is disposable fixture TLS material, never installed in a trust store.
execFileSync(
	"openssl",
	[
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"1",
		"-subj",
		"/CN=127.0.0.1",
		"-addext",
		"subjectAltName=IP:127.0.0.1,IP:::1",
		"-keyout",
		keyPath,
		"-out",
		certPath,
	],
	{ stdio: "ignore" },
);
const cert = readFileSync(certPath);
const nodeBundle = await build({
	stdin: {
		contents: `
export { linkCoordinatorAccount } from './coordinator-account-link-runtime.ts';
export { initTestSchema } from './test-utils.ts';
export { fingerprintPublicKey } from './sync-fingerprint.ts';
export { D1CoordinatorStore } from './d1-coordinator-store.ts';
export { review } from './coordinator-auth-store-test-fixtures.ts';
export { oidcFixture, PROVIDER } from './coordinator-oidc-test-fixtures.ts';`,
		resolveDir: fileURLToPath(new URL("../../core/src", import.meta.url)),
		sourcefile: "fixture-node.ts",
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
				builder.onResolve({ filter: /^vitest$/ }, () => ({ path: "vitest", namespace: "fixture" }));
				builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
					contents: "export const vi = { fn: (implementation) => implementation };",
					loader: "js",
				}));
				builder.onResolve({ filter: /^[^./]/ }, async ({ path, pluginData }) => {
					if (pluginData?.resolving) return;
					if (path.startsWith("node:")) return { path, external: true };
					const resolved = await builder.resolve(path, {
						kind: "import-statement",
						resolveDir: fileURLToPath(new URL("../../core", import.meta.url)),
						pluginData: { resolving: true },
					});
					return { path: resolved.path, external: true, errors: resolved.errors };
				});
			},
		},
	],
});
const bundlePath = join(dir, "node-fixture.cjs");
writeFileSync(bundlePath, nodeBundle.outputFiles[0].text);
const {
	linkCoordinatorAccount,
	initTestSchema,
	fingerprintPublicKey,
	D1CoordinatorStore,
	review,
	oidcFixture,
	PROVIDER,
} = require(bundlePath);
const Database = coreRequire("better-sqlite3");
const keysDir = join(dir, "device-keys");
mkdirSync(keysDir);
const keys = generateKeyPairSync("ed25519");
const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
const kind = Buffer.from("ssh-ed25519");
const wire = Buffer.alloc(8 + kind.length + raw.length);
wire.writeUInt32BE(kind.length, 0);
kind.copy(wire, 4);
wire.writeUInt32BE(raw.length, 4 + kind.length);
raw.copy(wire, 8 + kind.length);
const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
const fingerprint = fingerprintPublicKey(publicKey);
writeFileSync(
	join(keysDir, "device.key"),
	keys.privateKey.export({ type: "pkcs8", format: "pem" }),
	{ mode: 0o600 },
);
writeFileSync(join(keysDir, "device.key.pub"), publicKey);
const dbPath = join(dir, "device.sqlite");
const local = new Database(dbPath);
initTestSchema(local);
local
	.prepare("INSERT INTO sync_device(device_id,public_key,fingerprint,created_at) VALUES (?,?,?,?)")
	.run("device-a", publicKey, fingerprint, new Date().toISOString());
local.close();
const demo = review({ publicKey, fingerprint });
const calls = [];
let mf;
let store;
let running;
let stopping = false;
let flow = { state: "idle" };
let origin;
const fake = oidcFixture({ issuer: "https://accounts.google.com" });
fake.claims.picture = undefined;
fake.claims.name = "Fake demo actor";
// Never use the production issuer as a network destination. Only the fixture fetch signs tokens.
async function boundedBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 65536) throw new Error("Fixture request too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
function send(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
	});
	response.end(JSON.stringify(value));
}
const provider = httpServer(async (request, response) => {
	try {
		if (request.method !== "POST" || request.url !== "/oidc") return send(response, 404, {});
		const input = JSON.parse((await boundedBody(request)).toString());
		const result = await fake.fetch(input.url, {
			method: input.method,
			headers: input.headers,
			body: input.body === null ? undefined : new URLSearchParams(input.body),
		});
		response.writeHead(result.status, Object.fromEntries(result.headers));
		response.end(await result.text());
	} catch {
		send(response, 502, { error: "fixture_provider_rejected" });
	}
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}/oidc`;
const server = httpsServer({ cert, key: readFileSync(keyPath) }, async (request, response) => {
	try {
		if (!mf || !store) return send(response, 503, { state: "initializing" });
		if (request.headers.host !== new URL(origin).host) return send(response, 400, {});
		const url = new URL(request.url, origin);
		if (url.pathname.startsWith("/__fixture/")) {
			// Control endpoints are loopback-only and reject browser cross-origin mutation.
			if (request.headers.origin && request.headers.origin !== origin)
				return send(response, 403, {});
			if (url.pathname === "/__fixture/health" && request.method === "GET")
				return send(response, 200, { ready: true });
			if (url.pathname === "/__fixture/status" && request.method === "GET")
				return send(response, 200, {
					flow,
					actorId: demo.identityId,
					deviceId: demo.deviceId,
					sessionCount: (
						await db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_sessions").first()
					).count,
					calls,
					providerCalls: fake.requests.map(({ url }) => new URL(url).pathname),
				});
			if (url.pathname === "/__fixture/start" && request.method === "POST") {
				const host = url.searchParams.get("host") || "127.0.0.1";
				if (!["127.0.0.1", "::1"].includes(host)) return send(response, 400, {});
				if (running) return send(response, 409, { error: "flow_active" });
				const controller = new AbortController();
				let ready;
				const browserReady = new Promise((resolve) => {
					ready = resolve;
				});
				flow = { state: "starting", host };
				running = { controller };
				running.task = linkCoordinatorAccount({
					dbPath,
					keysDir,
					groupId: demo.groupId,
					coordinatorUrl: origin,
					loopbackHost: host,
					signal: controller.signal,
					fetch: async (input, init) => {
						const target = new URL(String(input));
						if (target.origin !== origin) throw new Error("Nonlocal runtime destination");
						if (
							process.argv.includes("--sanity") &&
							process.argv.includes("--sanity-fail-cancel") &&
							target.pathname.endsWith("/cancel")
						)
							return new Response(null, { status: 503 });
						const result = await pinnedRequest(target, init);
						calls.push({ method: init.method, path: target.pathname, status: result.status });
						return result;
					},
					onBrowserStart: (privateUrl) => {
						flow = { state: "awaiting_browser", host };
						process.stderr.write(`${JSON.stringify({ PRIVATEstartURL: privateUrl })}\n`);
						ready();
					},
				})
					.then(
						(result) => {
							flow = { state: result.state, actorId: result.identityId, host };
						},
						(error) => {
							flow = { state: "stopped", code: error.code || "fixture_failure", host };
						},
					)
					.finally(() => {
						ready();
						running = undefined;
					});
				await browserReady;
				return send(response, flow.state === "awaiting_browser" ? 202 : 500, { state: flow.state });
			}
			if (url.pathname === "/__fixture/cancel" && request.method === "POST") {
				running?.controller.abort();
				await running?.task;
				return send(response, 200, { flow });
			}
			if (url.pathname === "/__fixture/fake-authorize" && request.method === "GET") {
				const authorization = new URL(url.searchParams.get("authorizationURL") || "invalid");
				if (
					authorization.origin !== "https://accounts.google.com" ||
					authorization.pathname !== "/authorize" ||
					authorization.searchParams.get("client_id") !== PROVIDER.clientId ||
					authorization.searchParams.get("redirect_uri") !== PROVIDER.redirectUri ||
					authorization.searchParams.get("code_challenge_method") !== "S256"
				)
					return send(response, 400, {});
				return send(response, 200, { callbackURL: fake.authorize(authorization).href });
			}
			return send(response, 404, {});
		}
		const headers = new Headers(request.headers);
		headers.set("CF-Connecting-IP", "127.0.0.1");
		const body = await boundedBody(request);
		const result = await mf.dispatchFetch(url.href, {
			method: request.method,
			headers,
			body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
			redirect: "manual",
		});
		response.statusCode = result.status;
		for (const [name, value] of result.headers)
			if (name !== "set-cookie") response.setHeader(name, value);
		response.setHeader("set-cookie", result.headers.getSetCookie());
		if (result.body) Readable.fromWeb(result.body).pipe(response);
		else response.end();
	} catch {
		send(response, 400, { error: "fixture_request_rejected" });
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `https://127.0.0.1:${server.address().port}`;
PROVIDER.redirectUri = `${origin}/auth/callback`;
// Node clients trust exactly this certificate; browser acceptance is a separate user decision.
function pinnedRequest(url, init = {}) {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			url,
			{ ca: cert, method: init.method || "GET", headers: init.headers },
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () =>
					resolve(
						new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), {
							status: res.statusCode,
							headers: res.headers,
						}),
					),
				);
			},
		);
		req.setTimeout(10000, () => req.destroy(new Error("Fixture timeout")));
		req.on("error", reject);
		req.end(init.body);
	});
}
const entry = `
import { createCloudflareCoordinatorWorker } from './src/index.ts';
import { importBrowserCsrfKey } from '../core/src/coordinator-browser-csrf.ts';
const csrfKey = await importBrowserCsrfKey(new Uint8Array(${JSON.stringify([...randomBytes(32)])}));
const worker = createCloudflareCoordinatorWorker({ browserAuth: {
 config: ${JSON.stringify({
		enabled: true,
		coordinatorId: demo.coordinatorId,
		revision: "a".repeat(64),
		issuer: fake.issuer,
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
		redirectUri: PROVIDER.redirectUri,
 })},
 csrfKey, oidcOptions: { fetch: async (url, options) => fetch('${providerUrl}', {
  method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({url,
  method: options?.method, headers: Object.fromEntries(new Headers(options?.headers)),
  body: options?.body ? options.body.toString() : null}) }) }
} });
export default { fetch(request, env) { return worker.fetch(request, {COORDINATOR_DB: env.DB}); } };`;
const workerBundle = await build({
	stdin: {
		contents: entry,
		resolveDir: fileURLToPath(new URL("..", import.meta.url)),
		sourcefile: "fixture-worker.ts",
	},
	bundle: true,
	write: false,
	platform: "browser",
	format: "esm",
	target: "es2022",
	external: ["node:crypto", "node:path"],
	alias: {
		"@codemem/core/internal/cloudflare-coordinator": fileURLToPath(
			new URL("../../core/src/internal/cloudflare-coordinator.ts", import.meta.url),
		),
	},
});
mf = new Miniflare(
	convertV4MiniflareOptions({
		modules: true,
		script: workerBundle.outputFiles[0].text,
		compatibilityDate: "2026-03-28",
		compatibilityFlags: ["nodejs_compat"],
		d1Databases: { DB: "manual-browser-fixture" },
		d1Persist: join(dir, "d1"),
		cf: false,
		host: "127.0.0.1",
		port: 0,
	}),
);
const db = await mf.getD1Database("DB");
const migrations = await readD1Migrations(fileURLToPath(new URL("../migrations", import.meta.url)));
for (const migration of migrations) {
	await db.batch(migration.queries.map((sql) => db.prepare(sql)));
}
store = new D1CoordinatorStore(db);
await store.createGroup(demo.groupId, "Fake browser demo group");
await store.enrollDevice(demo.groupId, { ...demo, identityId: null });
assert.equal((await store.createAuthControllerAttestation(demo)).kind, "created");
async function stop() {
	if (stopping) return;
	stopping = true;
	running?.controller.abort();
	await running?.task;
	server.closeAllConnections();
	provider.closeAllConnections();
	await Promise.all([
		new Promise((resolve) => server.close(resolve)),
		new Promise((resolve) => provider.close(resolve)),
	]);
	await mf.dispose();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
// Arrange: a fresh D1, explicit device key directory and exact controller review.
// Act: native TLS page request plus rejected control inputs, with no cookie bootstrap.
const health = await pinnedRequest(`${origin}/__fixture/health`);
const signin = await pinnedRequest(`${origin}/auth/sign-in`);
const rejected = await pinnedRequest(`${origin}/__fixture/start?host=example.test`, {
	method: "POST",
});
const badAuthorize = await pinnedRequest(
	`${origin}/__fixture/fake-authorize?authorizationURL=https%3A%2F%2Fevil.example.test`,
);
// Assert: production HTML/cookie flags, positive health and negative control boundaries.
assert.equal(health.status, 200);
assert.equal(signin.status, 200);
assert.match(await signin.text(), /csrf/);
assert.match(signin.headers.get("set-cookie"), /__Host-.*Secure.*HttpOnly.*SameSite=Lax/i);
assert.equal(rejected.status, 400);
assert.equal(badAuthorize.status, 400);
console.log(
	JSON.stringify({
		READY: {
			origin,
			certificatePublicPath: certPath,
			certificateFingerprint: new X509Certificate(cert).fingerprint256,
			controlUrls: {
				health: `${origin}/__fixture/health`,
				status: `${origin}/__fixture/status`,
				start: `${origin}/__fixture/start?host=127.0.0.1`,
				cancel: `${origin}/__fixture/cancel`,
				fakeAuthorize: `${origin}/__fixture/fake-authorize?authorizationURL=`,
			},
			sanityAssertions: 7,
		},
	}),
);
if (process.argv.includes("--sanity")) {
	try {
		const started = await pinnedRequest(`${origin}/__fixture/start`, { method: "POST" });
		assert.equal(started.status, 202);
		const cancelled = await pinnedRequest(`${origin}/__fixture/cancel`, { method: "POST" });
		assert.equal(cancelled.status, 200);
		assert.deepEqual((await cancelled.json()).flow, {
			state: "stopped",
			code: "link_stopped",
			host: "127.0.0.1",
		});
		assert.ok(
			calls.some(
				(call) => call.method === "POST" && call.path.endsWith("/cancel") && call.status === 200,
			),
		);
		assert.equal(
			(await db.prepare("SELECT state FROM coordinator_auth_link_attempts").first()).state,
			"failed",
		);
		assert.ok(
			calls.some(
				(call) =>
					call.method === "POST" && call.path === "/v1/auth/link-attempts" && call.status === 201,
			),
		);
		assert.equal(
			(await db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_sessions").first()).count,
			0,
		);
	} finally {
		await stop();
	}
	console.log(JSON.stringify({ SANITY: "passed", assertions: 14, browserValidated: false }));
}
