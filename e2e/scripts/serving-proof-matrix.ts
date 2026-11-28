import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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
async function exchange(
	sender: Peer,
	receiver: Peer,
	source: string,
	target: string,
	{ expectTransfer }: { expectTransfer: boolean },
) {
	const keys = fixture.seedCanaries(sender);
	const wireFile = join(receiver.env.HOME, "wire-count");
	writeFileSync(wireFile, "");
	const server = fork(script("serving-proof-peer.mjs"), [target, "serve"], {
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
		const result = JSON.parse(r.stdout);
		if (!expectTransfer && !result.ok) {
			assert.equal(r.status, 1);
			assert.equal(result.results.length, 1);
			assert.match(
				result.results[0].error,
				/(?:409: reset_required:missing_scope\)|peer access ended during push)$/,
			);
		} else {
			assert.equal(r.status, 0, r.stderr);
			assert.equal(result.ok, true);
		}
		for (const key of keys) {
			assert.equal(count(sender, key), 1);
			assert.equal(
				count(receiver, key),
				Number(expectTransfer),
				`unexpected transfer outcome: ${source} -> ${target}`,
			);
		}
		return statSync(wireFile).size > 0;
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
		assert.equal(await exchange(a, b, source, target, { expectTransfer: true }), true);
		for (const p of [a, b]) {
			const r = run(
				[
					"--import",
					"tsx",
					script("serving-proof-crash.ts"),
					p.dbPath,
					coordinator,
					fixture.groupId,
					generation,
				],
				p,
			);
			assert.equal(r.signal, "SIGKILL", r.stderr);
			assert.equal(
				p.db
					.prepare("SELECT count(*) FROM sqlite_master WHERE name='scope_serving_preparations'")
					.pluck()
					.get(),
				0,
			);
			assert.equal(
				p.db.prepare("SELECT count(*) FROM scope_membership_authorization_evidence").pluck().get(),
				4,
			);
		}
		// An interrupted preparation cannot acknowledge a transition. The old
		// state still works end to end until preparation succeeds on retry.
		assert.equal(await exchange(a, b, source, target, { expectTransfer: true }), true);
		fixture.transition(a, b, coordinator, generation);
		fixture.transition(b, a, coordinator, generation);
		const offlineBody = await exchange(a, b, source, target, { expectTransfer: false });
		for (const p of [a, b]) {
			checked([script("serving-proof-peer.mjs"), legacy, "refresh", coordinator], p);
			checked(
				[
					script("serving-proof-peer.mjs"),
					legacy,
					"inspect-cache",
					coordinator,
					"absent",
					...fixture.scopes,
				],
				p,
			);
		}
		const refreshedBody = await exchange(a, b, source, target, { expectTransfer: false });
		assert.deepEqual(
			{ offlineBody, refreshedBody },
			{ offlineBody: false, refreshedBody: false },
			"Synthetic body crossed the peer connection",
		);
	} finally {
		a.db.close();
		b.db.close();
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
