import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
	renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const packages = ["core", "cli", "viewer-server", "mcp-server", "embeddings"];
const revision = "1".repeat(40);
const query = "refresh authentication keys";
const project = "installed-semantic";
const title = "Credential rotation";
const body = "Replace secrets every quarter.";

function run(command, args, cwd, env) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 90_000 });
	assert.equal(result.status, 0, `${command} failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

function environment(home) {
	mkdirSync(home, { recursive: true });
	return {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
		XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
		CODEMEM_DB: join(home, "memory.sqlite"), CODEMEM_CONFIG: join(home, "config.json"),
		CODEMEM_KEYS_DIR: join(home, "keys"), CODEMEM_RUNTIME_ROOT: join(home, "runtime"),
		CODEMEM_SYNC_KEY_STORE: "file", CODEMEM_DEVICE_ID: "installed-semantic",
		CODEMEM_ACTOR_ID: "local:installed-semantic", CODEMEM_ACTOR_DISPLAY_NAME: "Test actor",
		CODEMEM_EMBEDDING_DISABLED: "0", CODEMEM_EMBEDDING_OFFLINE: "1",
		CODEMEM_EMBEDDING_MODEL: "fixture/offline-semantic", CODEMEM_EMBEDDING_REVISION: revision,
		HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
	};
}

// This preload uses only normal installed exports. It also runs in CLI children.
async function preload() {
	const { registerHooks } = await import("node:module");
	const { realpathSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const { resolve, sep } = await import("node:path");
	const root = resolve(import.meta.dirname);
	registerHooks({
		resolve(specifier, context, next) {
			const result = next(specifier, context);
			if (result.url.startsWith("file:")) {
				const path = realpathSync(fileURLToPath(result.url));
				if (specifier === "codemem" || specifier.startsWith("@codemem/")) {
					if (!path.startsWith(root + sep) || !path.includes(`${sep}dist${sep}`)) {
						throw new Error(`Application import escaped installed dist: ${specifier}`);
					}
				}
				if (path.startsWith(process.env.FIXTURE_SOURCE_ROOT + sep)) {
					throw new Error(`Application source loaded from checkout: ${specifier}`);
				}
			}
			return result;
		},
	});
	globalThis.fetch = async () => { throw new Error("Offline acceptance forbids fetch"); };
	const core = await import("@codemem/core");
	core._setEmbeddingRuntimeFactory(async () => ({
		model: "fixture/offline-semantic", dimensions: 384,
		identity: {
			package: "@huggingface/transformers", version: "4.2.0", model: "fixture/offline-semantic",
			revision: "1".repeat(40), requestedRevision: "1".repeat(40), dtype: "fp32", device: "cpu",
			pooling: "mean", normalization: "l2", dimensions: 384,
		},
		embed: async (texts) => texts.map(() => {
			const vector = new Float32Array(384); vector[0] = 1; return vector;
		}),
	}));
	// Catch inline parent ranking even when it originates inside the CLI bundle.
	const { default: Database } = await import("better-sqlite3");
	const prepare = Database.prototype.prepare;
	Database.prototype.prepare = function (sql, ...args) {
		if (/vec_distance_l2\s*\(/i.test(sql)) throw new Error("Parent attempted inline vector ranking");
		return prepare.call(this, sql, ...args);
	};
}

function stage(source, destination, temp, env) {
	const manifests = packages.map((directory) => {
		const path = join(source, "packages", directory);
		const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		const extra = {
			core: ["dist/semantic-worker-entry.js"],
			"viewer-server": ["static/index.html"],
			"mcp-server": ["dist/http.js"],
		};
		for (const artifact of ["dist/index.js", ...(extra[directory] ?? [])]) {
			assert(existsSync(join(path, artifact)), `Missing ${directory}/${artifact}; run pnpm run build first`);
		}
		return { path, manifest };
	});
	const applicationNames = new Set(manifests.map(({ manifest }) => manifest.name));
	for (const { path, manifest } of manifests) {
		const packed = run("pnpm", ["pack", "--pack-destination", temp], path, env).trim().split(/\r?\n/).at(-1);
		const target = join(destination, "node_modules", manifest.name);
		mkdirSync(target, { recursive: true });
		const listing = run("tar", ["-tf", packed], source, env);
		assert(listing.includes("package/dist/index.js"), `${manifest.name} pack omitted its entrypoint`);
		if (manifest.name === "@codemem/core") {
			assert(listing.includes("package/dist/semantic-worker-entry.js"), "Core pack omitted semantic worker");
		}
		run("tar", ["-xf", packed, "--strip-components=1", "-C", target], source, env);
	}
	// External dependencies may use the existing offline install; application packages never do.
	for (const { path, manifest } of manifests) {
		for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
			if (applicationNames.has(name)) continue;
			const installed = join(path, "node_modules", name);
			assert(existsSync(installed), `Offline dependency missing: ${name}; run pnpm install first`);
			const target = join(destination, "node_modules", name);
			if (existsSync(target)) continue;
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(realpathSync(installed), target, "dir");
		}
	}
	writeFileSync(join(destination, "package.json"), '{"private":true,"type":"module"}');
	writeFileSync(join(destination, "preload.mjs"), `await (${preload.toString()})();\n`);
	cpSync(fileURLToPath(import.meta.url), join(destination, "acceptance.mjs"));
}

function post(url, payload, mcp = false) {
	return new Promise((resolveResponse, reject) => {
		const req = request(url, { method: "POST", headers: {
			"content-type": "application/json", accept: mcp ? "application/json, text/event-stream" : "application/json",
			...(mcp ? { "mcp-protocol-version": "2025-03-26" } : {}),
		} }, (res) => {
			let text = "";
			res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => {
				try {
					assert.equal(res.statusCode, 200, text);
					const data = text.startsWith("event:") || text.startsWith("data:")
						? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) : text;
					resolveResponse(JSON.parse(data));
				} catch (error) { reject(error); }
			});
		});
		req.on("error", reject); req.setTimeout(15_000, () => req.destroy(new Error("HTTP acceptance timed out")));
		req.end(JSON.stringify(payload));
	});
}

function semantic(pack, id) {
	assert(pack.metrics.sources.semantic > 0, "Semantic-only evidence was not retrieved");
	assert.equal(pack.metrics.fallback_used, false, "Keyword fallback cannot satisfy acceptance");
	assert.deepEqual(pack.item_ids, [id]);
}

async function installedAcceptance() {
	const { MemoryStore, storeVectors, ensureDeviceIdentity } = await import("@codemem/core");
	const embeddings = await import("@codemem/embeddings");
	assert.equal(typeof embeddings.createEmbeddingRuntime, "function", "Packed embedding export is missing");
	for (const name of ["codemem", "@codemem/core", "@codemem/server", "@codemem/mcp", "@codemem/embeddings"]) {
		const path = join(import.meta.dirname, "node_modules", name);
		assert.equal(realpathSync(path), path, `${name} must be a staged package copy, not a checkout link`);
	}
	const workers = new Set();
	const send = Worker.prototype.postMessage;
	Worker.prototype.postMessage = function (...args) { workers.add(this); return send.apply(this, args); };
	const store = new MemoryStore(process.env.CODEMEM_DB);
	let viewer;
	let mcp;
	try {
		// Public identity setup creates disposable file keys, never an OS keychain entry.
		ensureDeviceIdentity(store.db, { keysDir: process.env.CODEMEM_KEYS_DIR, deviceId: process.env.CODEMEM_DEVICE_ID });
		// Arrange: ordinary constructor, remember, flush, and supported vector writer only.
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		const session = store.startSession({ project });
		const id = store.remember(session, "decision", title, body, 0.9);
		await store.flushPendingVectorWrites();
		process.env.CODEMEM_EMBEDDING_DISABLED = "0";
		await storeVectors(store.db, id, title, body);
		assert.deepEqual(store.search(query, 10, { project }), [], "Fixture must have no lexical hit");
		const counts = () => ["usage_events WHERE event = 'pack'", "retrieval_attempts", "retrieval_exposures"]
			.map((table) => store.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
		const before = counts();
		// Act: normal exports must bootstrap the relocated worker without attachment APIs.
		const pack = await store.buildMemoryPackAsync(query, 10, null, { project });
		const artifacts = await store.buildMemoryPackWithTraceAsync(query, 10, null, { project });
		const afterPacks = counts();
		const trace = await store.buildMemoryPackTraceAsync(query, 10, null, { project });
		// Assert: response variants, read-only trace, usage counts, and excluded project.
		semantic(pack, id); semantic(artifacts.response, id);
		for (const current of [trace, artifacts.trace]) {
			assert.deepEqual([...new Set(Object.values(current.assembly.sections).flat())], [id]);
		}
		assert.deepEqual(afterPacks, [before[0] + 2, before[1], before[2]]);
		assert.deepEqual(counts(), afterPacks);
		for (const method of ["buildMemoryPackAsync", "buildMemoryPackWithTraceAsync", "buildMemoryPackTraceAsync"]) {
			const hidden = await store[method](query, 10, null, { project: "absent" });
			if (method === "buildMemoryPackTraceAsync") assert.deepEqual(Object.values(hidden.assembly.sections).flat(), []);
			else assert.deepEqual((hidden.response ?? hidden).item_ids, []);
		}

		// Arrange/Act/Assert: real viewer HTTP uses its packaged Hono app and static assets.
		const { createApp } = await import("@codemem/server");
		const { serve } = await import("@hono/node-server");
		const ready = Promise.withResolvers();
		viewer = serve({ fetch: createApp({ storeFactory: () => store }).fetch, hostname: "127.0.0.1", port: 0 }, ready.resolve);
		const address = await ready.promise;
		const url = `http://127.0.0.1:${address.port}/api/pack`;
		semantic(await post(url, { context: query, project }), id);
		assert.deepEqual((await post(url, { context: query, project: "absent" })).item_ids, []);

		// Arrange/Act/Assert: actual stateless Streamable HTTP, not a mocked tool callback.
		const { startCodememMcpHttpServer } = await import("@codemem/mcp/http");
		mcp = await startCodememMcpHttpServer({ dbPath: process.env.CODEMEM_DB, port: 0 });
		for (const selected of [project, "absent"]) {
			const response = await post(mcp.url, { jsonrpc: "2.0", id: 1, method: "tools/call",
				params: { name: "memory_pack", arguments: { context: query, project: selected } } }, true);
			assert.equal(response.error, undefined, JSON.stringify(response));
			assert.notEqual(response.result.isError, true, JSON.stringify(response));
			const result = response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
			if (selected === project) semantic(result, id);
			else assert.deepEqual(result.item_ids, []);
		}

		// Arrange/Act/Assert: shipped CLI opens the same file; preload imports installed core.
		for (const selected of [project, "absent"]) {
			const result = JSON.parse(run(process.execPath, ["--import", join(import.meta.dirname, "preload.mjs"),
				join(import.meta.dirname, "node_modules/codemem/dist/index.js"), "pack", query,
				"--project", selected, "--json"], import.meta.dirname, process.env));
			if (selected === project) semantic(result, id);
			else assert.deepEqual(result.item_ids, []);
		}
	} finally {
		if (viewer) await new Promise((resolveClose, reject) => viewer.close((error) => error ? reject(error) : resolveClose()));
		await mcp?.close();
		await store.closeAsync();
		Worker.prototype.postMessage = send;
	}
	assert(workers.size > 0, "Acceptance never started a real semantic worker");
	assert([...workers].every((worker) => worker.threadId === -1), "closeAsync did not join workers");
	assert.equal(store.db.open, false);
	await assert.rejects(store.buildMemoryPackAsync(query), /closed/);
}

if (process.argv.includes("--installed")) {
	await installedAcceptance();
} else {
	test("relocated installed packages retrieve semantic-only evidence offline through every surface", { timeout: 180_000 }, () => {
		// Arrange: pack normal artifacts, install workspace copies, then relocate before any import.
		const source = resolve(import.meta.dirname, "../../..");
		const temporaryRoot = join(tmpdir(), "opencode");
		mkdirSync(temporaryRoot, { recursive: true });
		const temp = mkdtempSync(join(temporaryRoot, "codemem-installed-semantic-"));
		try {
			const env = environment(join(temp, "home"));
			const staged = join(temp, "original");
			stage(source, staged, temp, env);
			const relocated = join(temp, "relocated");
			renameSync(staged, relocated);
			// Act: strip all inherited Node hooks, conditions, profiles, credentials, and CODEMEM variables.
			const output = run(process.execPath, ["--import", join(relocated, "preload.mjs"),
				join(relocated, "acceptance.mjs"), "--installed"], relocated,
				{ ...env, FIXTURE_SOURCE_ROOT: join(source, "packages") });
			// Assert: child assertions are mandatory; a hanging worker also fails the subprocess timeout.
			assert.equal(typeof output, "string");
		} finally {
			// This directory was created by this test; no checkout or shared install is modified.
			rmSync(temp, { recursive: true, force: true });
		}
	});
}
