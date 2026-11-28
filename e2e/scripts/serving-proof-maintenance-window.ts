import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { releases: { type: "string" } } });
assert.ok(values.releases, "--releases must name the directory of compiled release tags");
const root = mkdtempSync(join(tmpdir(), "serving-proof-window-"));
for (const name of Object.keys(process.env))
	if (name.startsWith("CODEMEM_") || name.startsWith("XDG_")) delete process.env[name];
Object.assign(process.env, {
	HOME: root,
	CODEMEM_SYNC_KEY_STORE: "file",
	CODEMEM_EMBEDDING_DISABLED: "1",
});
const { connect, connectReadOnly } = await import("../../packages/core/src/db.js");
const { prepareOfflineScopeServingStore } = await import(
	"../../packages/core/src/offline-serving-preparation.js"
);
const entry = fileURLToPath(new URL("./serving-proof-peer.mjs", import.meta.url));

async function verifyWindow(release: string, version: string) {
	const home = join(root, version);
	mkdirSync(home);
	const path = join(home, "device.sqlite");
	connect(path).close();
	const env = {
		HOME: home,
		PATH: process.env.PATH,
		CODEMEM_DB: path,
		CODEMEM_CONFIG: join(home, "config.json"),
		CODEMEM_KEYS_DIR: join(home, "keys"),
		CODEMEM_SYNC_KEY_STORE: "file",
		CODEMEM_EMBEDDING_DISABLED: "1",
	};
	const cli = spawnSync(
		process.execPath,
		[join(release, "packages/cli/dist/index.js"), "--version"],
		{ env, encoding: "utf8", timeout: 15000 },
	);
	assert.equal(cli.status, 0, cli.stderr);
	assert.equal(cli.stdout.trim(), version);
	const prep = { coordinatorId: "fixture", groupId: "team", generation: randomUUID() };
	const child = fork(entry, [release, "serve"], {
		env,
		execArgv: [],
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	const exit = once(child, "exit");
	try {
		const [msg] = await Promise.race([
			once(child, "message", { signal: AbortSignal.timeout(20000) }),
			exit.then(() => {
				throw new Error("Release peer failed to start");
			}),
		]);
		assert.ok(Number.isInteger(msg.port));
		assert.throws(() => prepareOfflineScopeServingStore(path, prep, []), /store is in use/);
		const check = connectReadOnly(path);
		try {
			assert.equal(
				check
					.prepare(
						"SELECT count(*) FROM sqlite_master WHERE name IN ('scope_serving_preparations','scope_serving_proofs_v2')",
					)
					.pluck()
					.get(),
				0,
			);
		} finally {
			check.close();
		}
	} finally {
		child.kill();
		await exit;
	}
	prepareOfflineScopeServingStore(path, prep, []);
	const check = connectReadOnly(path);
	try {
		assert.deepEqual(
			check.prepare("SELECT generation FROM scope_serving_preparations").pluck().all(),
			[prep.generation],
		);
	} finally {
		check.close();
	}
	process.stdout.write(
		`${version}: refused while the released peer held the store; committed after exit\n`,
	);
}

try {
	for (const version of ["0.49.1", "0.50.0-beta.2", "0.50.0-beta.3", "0.50.0-beta.4"])
		await verifyWindow(resolve(values.releases, `v${version}`), version);
} finally {
	rmSync(root, { recursive: true, force: true });
}
