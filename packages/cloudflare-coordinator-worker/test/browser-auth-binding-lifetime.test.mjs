import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../package.json", import.meta.url));
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
const versions = Object.fromEntries(
	["miniflare", "workerd"].map((name) => [name, runtimeRequire(`${name}/package.json`).version]),
);
versions.wrangler = require("wrangler/package.json").version;
// Local runtime probe only: no production identity guarantee or auth handler coverage.
const script = `
const mode = 'shared';
let firstDb, setup, cached, complete = false, setupCalls = 0, arrivals = 0, release, joins = 0;
const limiter = { count: 0 }, config = Object.freeze({ revision: 'fixture' });
const key = Object.freeze({ value: 'non-secret-fixture' });
let pinnedLimiter, pinnedConfig, pinnedKey;
const gate = mode === 'barrier' ? new Promise(resolve => { release = resolve; }) : undefined;
export default {
  async fetch(request, env) {
    const concurrent = new URL(request.url).pathname === '/concurrent';
    const db = new URL(request.url).pathname === '/different-db' ? env.OTHER_DB : env.DB;
    firstDb ??= db;
    if (firstDb !== db) {
      return Response.json({ sameBinding: false, setupCalls }, { status: 503 });
    }
    pinnedLimiter ??= limiter; pinnedConfig ??= config; pinnedKey ??= key;
    const count = ++limiter.count;
    if (concurrent && ++arrivals === 10 && mode === 'barrier') release();
    const initialize = async () => {
      setupCalls++;
      if (concurrent && mode === 'barrier') await gate;
      const result = await firstDb.prepare('SELECT 1 AS value').all();
      return result.results[0].value;
    };
    let setupRead;
    if (mode === 'finished') {
      if (cached === undefined) { const value = await initialize(); cached ??= value; }
      setupRead = cached;
    } else {
      if (setup && !complete) joins++;
      setup ??= initialize();
      setupRead = await setup;
      complete = true;
    }
    const result = await firstDb.prepare('SELECT 1 AS value').all();
    return Response.json({ sameBinding: firstDb === db, capturedRead: result.results[0].value,
      setupRead, setupCalls, arrivals, joins, count, sameLimiter: pinnedLimiter === limiter,
      sameSnapshot: pinnedConfig === config && pinnedKey === key });
  }
};`;
const options = (db = "binding-lifetime-fixture-a", mode = "shared") =>
	convertV4MiniflareOptions({
		modules: true,
		script: script.replace("const mode = 'shared';", `const mode = '${mode}';`),
		compatibilityDate: "2026-08-28",
		d1Databases: { DB: db, OTHER_DB: "binding-lifetime-fixture-other" },
		cf: false,
		host: "127.0.0.1",
		port: 0,
	});
const expected = (arrivals, count) => ({
	sameBinding: true,
	capturedRead: 1,
	setupRead: 1,
	setupCalls: 1,
	arrivals,
	joins: 0,
	count,
	sameLimiter: true,
	sameSnapshot: true,
});
async function request(mf, path, status = path === "/different-db" ? 503 : 200) {
	const url = new URL(path, await mf.ready);
	const response = await fetch(url);
	const text = await response.text();
	assert.equal(response.status, status, text);
	return { status: response.status, body: status === 500 ? text : JSON.parse(text) };
}
test("captured D1 binding works across sequential native HTTP request contexts", async (t) => {
	// Arrange: only fake, nonpersistent local D1 databases; never load Wrangler config.
	const mf = new Miniflare(options());
	t.after(() => mf.dispose());
	t.diagnostic(JSON.stringify(versions));
	// Act: each HTTP call enters the exported handler through workerd.
	const results = [];
	for (let index = 0; index < 3; index++) results.push(await request(mf, "/sequential"));
	const different = await request(mf, "/different-db");
	// Assert: fresh prepares on the captured object succeed; a different object fails closed.
	for (const [index, result] of results.entries()) {
		assert.deepEqual(result, { status: 200, body: expected(0, index + 1) });
	}
	assert.deepEqual(different, { status: 503, body: { sameBinding: false, setupCalls: 1 } });
});
test("cross-request global barrier is rejected by native request I/O ownership", async (t) => {
	// Arrange: the tenth arrival releases setup, proving all ten overlap before its D1 read.
	const mf = new Miniflare(options(undefined, "barrier"));
	t.after(() => mf.dispose());
	// Act
	const results = await Promise.all(
		Array.from({ length: 10 }, () => request(mf, "/concurrent", 500)),
	);
	const different = await request(mf, "/different-db");
	// Assert: preserve the unsupported candidate's failure, not a production success claim.
	for (const result of results) {
		assert.match(result.body, /Cannot perform I\/O on behalf of a different request/);
		assert.match(result.body, /I\/O type: SpanParent/);
	}
	assert.deepEqual(different, { status: 503, body: { sameBinding: false, setupCalls: 1 } });
});
test("natural shared setup records whether native requests join pending I/O", async (t) => {
	// Arrange: no resolver barrier; native D1 supplies the initialization await.
	const mf = new Miniflare(options());
	t.after(() => mf.dispose());
	// Act
	const results = await Promise.all(Array.from({ length: 10 }, () => request(mf, "/concurrent")));
	const different = await request(mf, "/different-db");
	// Assert: overlap is observational; native scheduling may complete setup before any join.
	for (const { body } of results) {
		assert.equal(body.setupCalls, 1);
		assert.equal(body.capturedRead, 1);
		assert.equal(body.setupRead, 1);
		assert.equal(body.sameBinding, true);
		assert.ok(Number.isSafeInteger(body.joins) && body.joins >= 0 && body.joins <= 9);
	}
	assert.equal(different.status, 503);
	t.diagnostic(
		JSON.stringify({ observedJoins: Math.max(...results.map(({ body }) => body.joins)) }),
	);
});
test("finished-only cache keeps one limiter and snapshot across cold and warm requests", async (t) => {
	// Arrange: synchronous pinning precedes request-owned initialization I/O.
	const mf = new Miniflare(options(undefined, "finished"));
	t.after(() => mf.dispose());
	// Act
	const cold = await Promise.all(Array.from({ length: 10 }, () => request(mf, "/concurrent")));
	const warm = [];
	for (let index = 0; index < 3; index++) warm.push(await request(mf, "/sequential"));
	const different = await request(mf, "/different-db");
	const after = await request(mf, "/sequential");
	// Assert: duplicate cold setup never creates a new limiter, snapshot, or quota counter.
	const calls = warm[0].body.setupCalls;
	assert.ok(calls >= 1 && calls <= 10);
	assert.deepEqual(
		cold.map(({ body }) => body.count).sort((a, b) => a - b),
		Array.from({ length: 10 }, (_, index) => index + 1),
	);
	for (const { body } of [...cold, ...warm, after]) {
		assert.equal(body.sameBinding && body.sameLimiter && body.sameSnapshot, true);
		assert.equal(body.capturedRead, 1);
		assert.equal(body.setupRead, 1);
		assert.equal(body.joins, 0);
	}
	for (const { body } of [...warm, after]) assert.equal(body.setupCalls, calls);
	assert.deepEqual(
		warm.map(({ body }) => body.count),
		[11, 12, 13],
	);
	assert.deepEqual(different, { status: 503, body: { sameBinding: false, setupCalls: calls } });
	assert.equal(after.body.count, 14);
	t.diagnostic(JSON.stringify({ finishedOnlySetupCalls: calls }));
});
test("reports whether a local binding update preserves the module cache", async (t) => {
	// Arrange
	const mf = new Miniflare(options());
	t.after(() => mf.dispose());
	const before = await request(mf, "/sequential");
	// Act: change only the fake local D1 mapping, not the module source.
	await mf.setOptions(options("binding-lifetime-fixture-b"));
	const after = await request(mf, "/sequential");
	const different = await request(mf, "/different-db");
	// Assert: a restarted isolate cannot demonstrate rejection of a live changed binding.
	assert.equal(before.status, 200);
	assert.ok(after.status === 200 || after.status === 503);
	assert.equal(different.status, 503);
	t.diagnostic(JSON.stringify({ bindingUpdate: after }));
});
