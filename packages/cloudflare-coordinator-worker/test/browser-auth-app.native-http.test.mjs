import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
const { build } = runtimeRequire("esbuild");
const ORIGIN = "https://app.example.test";
// Test-only HTTP URL rewrite exercises Worker request contexts, not browser HTTPS/Secure cookies.
async function harness(t, { coldRequests = 1 } = {}) {
	let discoveries = 0;
	const waiting = [];
	const metadata = JSON.stringify({
		issuer: "https://accounts.google.com",
		authorization_endpoint: "https://accounts.google.com/authorize",
		token_endpoint: "https://accounts.google.com/token",
		jwks_uri: "https://accounts.google.com/jwks",
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256"],
		token_endpoint_auth_methods_supported: ["client_secret_post"],
	});
	const provider = createServer((_request, response) => {
		discoveries++;
		const reply = () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(metadata);
		};
		// The barrier lives in Node, not a shared workerd promise. Every request owns its fetch.
		if (discoveries <= coldRequests) {
			waiting.push(reply);
			if (waiting.length === coldRequests) for (const release of waiting) release();
		} else reply();
	});
	await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		provider.closeAllConnections();
		return new Promise((resolve) => provider.close(resolve));
	});
	const providerUrl = `http://127.0.0.1:${provider.address().port}/discovery`;
	const entry = `
import { createCloudflareCoordinatorWorker } from './src/index.ts';
import { importBrowserCsrfKey } from '../core/src/coordinator-browser-csrf.ts';
const csrfKey = await importBrowserCsrfKey(new Uint8Array(${JSON.stringify([...randomBytes(32)])}));
const worker = createCloudflareCoordinatorWorker({ browserAuth: {
 config: { enabled: true, coordinatorId: 'native-http-fixture', revision: '${"a".repeat(64)}',
 issuer: 'https://accounts.google.com', clientId: 'fixture-client', clientSecret: 'fixture-secret',
 redirectUri: '${ORIGIN}/auth/callback' }, csrfKey,
 oidcOptions: { fetch: async (url) => {
  if (url !== 'https://accounts.google.com/.well-known/openid-configuration') throw new Error('Unexpected provider request');
  return fetch('${providerUrl}');
 } }
} });
export default { async fetch(request, env) {
 const url = new URL(request.url); const mismatch = url.pathname === '/test-only/different-db';
 const headers = new Headers(request.headers);
 headers.set('CF-Connecting-IP', headers.get('x-test-client') || '127.0.0.1');
 const target = '${ORIGIN}' + (mismatch ? '/auth/sign-in' : url.pathname + url.search);
 return worker.fetch(new Request(target, { method: request.method, headers,
  body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  redirect: 'manual' }), { COORDINATOR_DB: mismatch ? env.OTHER_DB : env.DB });
} };`;
	const bundled = await build({
		stdin: {
			contents: entry,
			resolveDir: fileURLToPath(new URL("..", import.meta.url)),
			sourcefile: "test-only-native-entry.ts",
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: "es2022",
		external: ["node:buffer", "node:crypto", "node:path"],
		alias: {
			"@codemem/core/internal/cloudflare-coordinator": fileURLToPath(
				new URL("../../core/src/internal/cloudflare-coordinator.ts", import.meta.url),
			),
		},
	});
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: bundled.outputFiles[0].text,
			compatibilityDate: "2026-03-28",
			compatibilityFlags: ["nodejs_compat"],
			d1Databases: { DB: "native-browser-auth-fixture", OTHER_DB: "native-browser-auth-other" },
			cf: false,
			host: "127.0.0.1",
			port: 0,
		}),
	);
	t.after(() => mf.dispose());
	const db = await mf.getD1Database("DB");
	const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(
		/--[^\n]*/g,
		"",
	);
	for (const sql of schema.split(";")) if (sql.trim()) await db.prepare(sql).run();
	const base = await mf.ready;
	const request = async (path, init) => {
		const response = await fetch(new URL(path, base), { ...init, redirect: "manual" });
		return { status: response.status, headers: response.headers, body: await response.text() };
	};
	return { request, db, discoveries: () => discoveries };
}
function fields(page) {
	return Object.fromEntries(
		[...page.body.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
	);
}
function post(page, { client = "127.0.0.1", csrf = fields(page).csrf } = {}) {
	return {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: page.headers.getSetCookie()[0].split(";")[0],
			"content-type": "application/x-www-form-urlencoded",
			"x-test-client": client,
		},
		body: new URLSearchParams({ csrf }),
	};
}
async function transactionCount(f) {
	const row = await f.db
		.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_browser_transactions")
		.first();
	return row.count;
}

test("actual SDK cold requests own discovery I/O; warm HTTP requests reuse composition and CSRF key", {
	timeout: 30000,
}, async (t) => {
	// Arrange: ten separate loopback HTTP requests, held at provider discovery outside workerd.
	const f = await harness(t, { coldRequests: 10 });
	// Act: all cold requests must enter discovery before any can finish initialization.
	const cold = await Promise.all(Array.from({ length: 10 }, () => f.request("/auth/sign-in")));
	const discoveries = f.discoveries();
	const started = await f.request("/auth/sign-in", post(cold[0]));
	const warm = await f.request("/auth/sign-in");
	const badCsrf = await f.request("/auth/sign-in", post(warm, { csrf: fields(cold[0]).csrf }));
	// Assert: no shared pending promise or I/O ownership error; GET A/POST B accepts the MAC.
	assert.deepEqual(
		cold.map((r) => r.status),
		Array(10).fill(200),
	);
	assert.equal(discoveries, 30);
	assert.equal(started.status, 200, started.body);
	assert.match(started.body, /https:\/\/accounts\.google\.com\/authorize/);
	assert.equal(warm.status, 200);
	assert.equal(badCsrf.status, 403);
	assert.equal(f.discoveries(), discoveries);
	assert.equal(await transactionCount(f), 1);
});

test("mounted warm HTTP quota survives new requests and a different D1 reference fails without mixing", {
	timeout: 30000,
}, async (t) => {
	// Arrange
	const f = await harness(t);
	const statuses = [];
	// Act: fresh cookies avoid reusing a transaction binder; the trusted client remains the same.
	for (let index = 0; index < 21; index++) {
		const page = await f.request("/auth/sign-in");
		statuses.push((await f.request("/auth/sign-in", post(page))).status);
	}
	const otherPage = await f.request("/auth/sign-in");
	const other = await f.request("/auth/sign-in", post(otherPage, { client: "::1" }));
	const mismatch = await f.request("/test-only/different-db");
	const after = await f.request("/auth/sign-in");
	// Assert: quota belongs to the composition, not each Hono request app, and mismatch grants nothing.
	assert.deepEqual(statuses, [...Array(20).fill(200), 429]);
	assert.equal(other.status, 200);
	assert.equal(mismatch.status, 503);
	assert.equal(mismatch.headers.get("cache-control"), "no-store");
	assert.equal(after.status, 200);
	assert.equal(f.discoveries(), 3);
	assert.equal(await transactionCount(f), 21);
});
