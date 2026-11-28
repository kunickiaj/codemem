import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CanaryObservation } from "./serving-proof-wire.js";

const { values } = parseArgs({
	options: { releases: { type: "string" }, version: { type: "string" } },
});
assert.ok(values.releases, "--releases must contain the built release-tag directories");
const current = fileURLToPath(new URL("../../", import.meta.url));
const script = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const cases = ["0.49.1", "0.50.0-beta.2", "0.50.0-beta.3", "0.50.0-beta.4"];
if (values.version) assert.ok(cases.includes(values.version));
const root = mkdtempSync(join(tmpdir(), "serving-proof-matrix-"));
// Isolate even module initialization and fixture helpers from the operator's
// configuration, databases, keychain and inherited sync settings.
for (const name of Object.keys(process.env))
	if (name.startsWith("CODEMEM_") || name.startsWith("XDG_")) delete process.env[name];
Object.assign(process.env, {
	HOME: root,
	CODEMEM_SYNC_KEY_STORE: "file",
	CODEMEM_EMBEDDING_DISABLED: "1",
});
const fixture = await import("./serving-proof-fixture.js");
type Peer = import("./serving-proof-fixture.js").Peer;

function run(args: string[], p: Peer) {
	const r = spawnSync(process.execPath, args, {
		cwd: current,
		env: p.env,
		encoding: "utf8",
		timeout: 30_000,
	});
	if (r.error) throw r.error;
	return r;
}
function checked(args: string[], p: Peer) {
	const r = run(args, p);
	assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
	return r.stdout;
}
async function disconnectedUrl() {
	const s = createServer();
	s.listen(0, "127.0.0.1");
	await once(s, "listening");
	const address = s.address();
	assert.ok(address && typeof address !== "string");
	await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
	return `http://127.0.0.1:${address.port}`;
}
function count(p: Peer, key: string) {
	return p.db.prepare("SELECT COUNT(*) FROM memory_items WHERE import_key=?").pluck().get(key);
}
const visibleTitle = "Synthetic stored history sample";
function readControls(p: Peer, build: string, id: number, expected: "visible" | "refused") {
	const cli = join(build, "packages/cli/dist/index.js");
	for (const args of [
		["memory", "list", "--all-projects", "--json", "--limit", "100"],
		["memory", "show", String(id), "--json"],
		["memory", "search", "sample", "--all-projects", "--json"],
		["memory", "export", "-", "--all-projects"],
	]) {
		const r = run([cli, ...args, "--db-path", p.dbPath], p);
		if (expected === "visible") {
			assert.equal(r.status, 0, r.stderr);
			assert.ok(r.stdout.includes(visibleTitle), `${args[1]} positive control`);
		} else {
			assert.equal(r.status, 1);
			assert.match(r.stderr + r.stdout, /Required tables missing: memory_items/);
			assert.ok(!(r.stdout + r.stderr).includes(visibleTitle));
		}
	}
	const viewer = run([script("serving-proof-peer.mjs"), build, "viewer"], p);
	assert.equal(viewer.status, 0, viewer.stderr);
	const response = JSON.parse(viewer.stdout);
	assert.equal(response.status, expected === "visible" ? 200 : 500);
	assert.equal(response.text.includes(visibleTitle), expected === "visible");
	if (expected === "refused") assert.match(viewer.stderr, /Required tables missing: memory_items/);
}
async function exchange(
	sender: Peer,
	receiver: Peer,
	source: string,
	target: string,
	{ expectTransfer }: { expectTransfer: boolean },
) {
	const keys = fixture.seedCanaries(sender);
	const wireFile = join(receiver.env.HOME, "wire.jsonl");
	writeFileSync(wireFile, "");
	const refused = join(receiver.env.HOME, "open-refused");
	writeFileSync(refused, "");
	const server = fork(script("serving-proof-peer.mjs"), [target, "serve-lazy"], {
		execArgv: [],
		env: receiver.env,
		silent: false,
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	const exit = once(server, "exit");
	try {
		const [message] = await Promise.race([
			once(server, "message", { signal: AbortSignal.timeout(20_000) }),
			exit.then(() => {
				throw new Error("Peer listener exited before binding");
			}),
		]);
		assert.ok(Number.isInteger(message.port));
		sender.db
			.prepare("UPDATE sync_peers SET addresses_json=? WHERE peer_device_id=?")
			.run(JSON.stringify([`http://127.0.0.1:${message.port}`]), receiver.deviceId);
		const r = run(
			[
				join(source, "packages/cli/dist/index.js"),
				"sync",
				"once",
				"--peer",
				receiver.deviceId,
				"--db-path",
				sender.dbPath,
				"--json",
			],
			sender,
		);
		if (expectTransfer) {
			assert.equal(r.status, 0, r.stderr);
			assert.equal(JSON.parse(r.stdout).ok, true);
		} else if (source !== current) {
			assert.equal(r.status, 1);
			assert.match(
				r.stdout + r.stderr,
				/Required tables missing: memory_items|no such table: (?:main\.)?(memory_items|replication_ops|sync_device)/,
			);
		} else {
			assert.equal(r.status, 1, r.stdout);
			assert.ok(
				readFileSync(refused, "utf8").length > 0,
				"Released receiver must refuse the store on the real sync route",
			);
		}
		if (!expectTransfer && source !== current) {
			const daemon = run([script("serving-proof-peer.mjs"), source, "daemon-pass"], sender);
			assert.match(
				daemon.stdout + daemon.stderr,
				/no such table: (?:main\.)?(memory_items|replication_ops|sync_device)|Required tables missing: memory_items/,
			);
		}
		for (const key of keys) {
			assert.equal(count(sender, key), 1);
			assert.equal(
				count(receiver, key),
				Number(expectTransfer),
				`unexpected transfer outcome: ${source} -> ${target}`,
			);
		}
		const observed: CanaryObservation[] = readFileSync(wireFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		if (expectTransfer) {
			for (const key of keys)
				assert.ok(
					observed.some((hit) => hit.direction === "sender-to-receiver" && hit.id === key),
					`Missing outbound control: ${key}`,
				);
		}
		return observed;
	} finally {
		server.kill();
		await exit;
	}
}
async function matrix(source: string, target: string, legacy: string, directory: string) {
	mkdirSync(directory);
	const coordinator = await disconnectedUrl();
	const a = fixture.peer(join(directory, "a"), coordinator);
	const b = fixture.peer(join(directory, "b"), coordinator);
	const generation = randomUUID();
	try {
		await fixture.prime(a, b, coordinator);
		await fixture.prime(b, a, coordinator);
		for (const p of [a, b])
			checked(
				[
					script("serving-proof-peer.mjs"),
					legacy,
					"inspect-cache",
					coordinator,
					"present",
					...fixture.scopes,
				],
				p,
			);
		await exchange(a, b, source, target, { expectTransfer: true });
		for (const stage of ["purge", "first-envelope", "format-before-envelope"])
			for (const p of [a, b]) {
				if (stage === "format-before-envelope") p.db.close();
				const r = run(
					[
						"--import",
						"tsx",
						script("serving-proof-crash.ts"),
						p.dbPath,
						coordinator,
						fixture.groupId,
						generation,
						stage,
					],
					p,
				);
				assert.equal(r.signal, "SIGKILL", r.stderr);
				if (!p.db.open) fixture.reopen(p);
				assert.equal(
					p.db
						.prepare("SELECT count(*) FROM sqlite_schema WHERE name='project_memory_items'")
						.pluck()
						.get(),
					0,
				);
				const installed = p.db
					.prepare("SELECT count(*) FROM sqlite_master WHERE name='scope_serving_preparations'")
					.pluck()
					.get();
				if (installed) {
					assert.equal(
						p.db
							.prepare("SELECT count(*) FROM scope_serving_preparations WHERE group_id=?")
							.pluck()
							.get(fixture.groupId),
						0,
					);
					assert.equal(
						p.db.prepare("SELECT count(*) FROM scope_serving_proofs_v2").pluck().get(),
						0,
					);
				}
				assert.equal(
					p.db
						.prepare("SELECT count(*) FROM scope_membership_authorization_evidence")
						.pluck()
						.get(),
					4,
				);
			}
		// An interrupted preparation cannot acknowledge a transition. The old
		// state still works end to end until preparation succeeds on retry.
		await exchange(a, b, source, target, { expectTransfer: true });
		let historyId = 0;
		if (source === legacy && target === legacy) {
			historyId = Number(
				a.db
					.prepare(`INSERT INTO memory_items(session_id,kind,title,body_text,active,created_at,updated_at,scope_id,visibility)
				SELECT id,'discovery',?,'offline local sample',1,datetime('now'),datetime('now'),'local-default','shared' FROM sessions LIMIT 1`)
					.run(visibleTitle).lastInsertRowid,
			);
			readControls(a, legacy, historyId, "visible");
		}
		fixture.transition(a, b, coordinator, generation);
		fixture.transition(b, a, coordinator, generation);
		const offlineBody = await exchange(a, b, source, target, { expectTransfer: false });
		for (const p of [a, b]) {
			const attempt = run([script("serving-proof-peer.mjs"), legacy, "refresh", coordinator], p);
			assert.equal(attempt.status, 1);
			assert.match(attempt.stderr, /Required tables missing: memory_items/);
			const init = run(
				[
					join(legacy, "packages/cli/dist/index.js"),
					"maintenance",
					"database",
					"init",
					"--db-path",
					p.dbPath,
				],
				p,
			);
			assert.match(init.stdout + init.stderr, /Required tables missing: memory_items/);
			for (const table of ["memory_items", "memory_fts", "sync_device", "replication_ops"])
				assert.equal(
					p.db.prepare("SELECT count(*) FROM sqlite_schema WHERE name=?").pluck().get(table),
					0,
				);
		}
		const refreshedBody = await exchange(a, b, source, target, { expectTransfer: false });
		if (historyId) {
			readControls(a, legacy, historyId, "refused");
			readControls(a, current, historyId, "visible");
		}
		assert.deepEqual(
			{ offlineBody, refreshedBody },
			{ offlineBody: [], refreshedBody: [] },
			"Synthetic body crossed the peer connection",
		);
	} finally {
		if (a.db.open) a.db.close();
		if (b.db.open) b.db.close();
	}
}
const failures: Error[] = [];
try {
	for (const version of cases.filter((v) => !values.version || v === values.version)) {
		const old = resolve(values.releases, `v${version}`);
		const versionRun = spawnSync(
			process.execPath,
			[join(old, "packages/cli/dist/index.js"), "--version"],
			{ env: { HOME: root, PATH: process.env.PATH }, encoding: "utf8", timeout: 15000 },
		);
		assert.equal(versionRun.status, 0, versionRun.stderr);
		assert.equal(versionRun.stdout.trim(), version);
		for (const [direction, source, target] of [
			["old-old", old, old],
			["old-current", old, current],
			["current-old", current, old],
		] as const) {
			try {
				await matrix(source, target, old, join(root, `${direction}-${version}`));
				process.stdout.write(
					`${version} ${direction}: control, crash recovery, offline, legacy refresh passed\n`,
				);
			} catch (cause) {
				failures.push(new Error(`${version} ${direction}`, { cause }));
			}
		}
	}
	if (failures.length) throw new AggregateError(failures, "Serving proof matrix failed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
