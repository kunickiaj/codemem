import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The release this smoke upgrades from. Its packages are pinned exactly. */
export const UPGRADE_FROM_VERSION = "0.49.1";
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const PEER_NAME = "Upgrade peer";
const ALPHA = "upgrade-alpha";
const BETA = "upgrade-beta";
const MEMORIES = [
	{ title: "upgrade alpha shared", project: ALPHA, private: false },
	{ title: "upgrade alpha private", project: ALPHA, private: true },
	{ title: "upgrade beta shared", project: BETA, private: false },
];
const MAPPINGS = [
	{
		workspace_identity: `/work/acme/${ALPHA}`,
		project_pattern: `/work/acme/${ALPHA}`,
		scope_id: "local-default",
		priority: 700,
	},
	{ workspace_identity: null, project_pattern: "github.com/acme/upgrade-*", scope_id: "local-default", priority: 300 },
];
const PEER_COLUMNS = [
	"peer_device_id",
	"name",
	"pinned_fingerprint",
	"public_key",
	"addresses_json",
	"projects_include_json",
	"projects_exclude_json",
];
const MEMORY_COLUMNS = ["id", "kind", "title", "body_text", "project", "visibility", "scope_id", "active"];
const MAPPING_COLUMNS = ["id", "workspace_identity", "project_pattern", "scope_id", "priority", "source"];

function runChild(command, args, { cwd, env, label }) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += data;
		});
		child.stderr.on("data", (data) => {
			stderr += data;
		});
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, 90_000);
		child.once("error", reject);
		child.once("close", (status) => {
			clearTimeout(timeout);
			if (status !== 0) reject(new Error(`${label} failed (${status})\n${stdout}\n${stderr}`));
			else resolvePromise(stdout);
		});
	});
}

/**
 * Install the published release into its own prefix with an empty npm user
 * config, so no host registry credentials or settings are used.
 */
function installPublishedRelease(isolatedRoot) {
	const installDir = join(isolatedRoot, `upgrade-from-${UPGRADE_FROM_VERSION}`);
	mkdirSync(installDir, { recursive: true });
	const pinned = Object.fromEntries(
		["@codemem/core", "@codemem/mcp", "@codemem/server"].map((name) => [name, UPGRADE_FROM_VERSION]),
	);
	writeFileSync(join(installDir, "package.json"), JSON.stringify({ private: true, overrides: pinned }));
	const userConfig = join(isolatedRoot, "upgrade-npmrc");
	writeFileSync(userConfig, "");
	const result = spawnSync(
		"npm",
		[
			"install",
			"--omit=optional",
			"--no-audit",
			"--no-fund",
			"--registry",
			PUBLIC_REGISTRY,
			"--userconfig",
			userConfig,
			"--cache",
			join(isolatedRoot, "upgrade-npm-cache"),
			`codemem@${UPGRADE_FROM_VERSION}`,
		],
		{ cwd: installDir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: isolatedRoot } },
	);
	if (result.status !== 0) {
		throw new Error(
			`Installing codemem@${UPGRADE_FROM_VERSION} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
		);
	}
	return installDir;
}

function cliPath(installDir) {
	return join(installDir, "node_modules/codemem/dist/index.js");
}

function deviceEnv(runtimeEnv, isolatedRoot, name) {
	return {
		...runtimeEnv(join(isolatedRoot, `upgrade-${name}`)),
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_SYNC_KEY_STORE: "file",
	};
}

async function cli(installDir, env, args, label) {
	return runChild(process.execPath, [cliPath(installDir), ...args], { cwd: installDir, env, label });
}

async function fixture(installDir, env, step, label) {
	const stdout = await runChild(
		process.execPath,
		[fileURLToPath(import.meta.url), "--installed-fixture", installDir, step],
		{ cwd: installDir, env, label },
	);
	return JSON.parse(stdout);
}

/** Build a store with the published release: memories, Project mappings and one pairing. */
async function seedPublishedStore(oldInstall, deviceA, deviceB) {
	await cli(oldInstall, deviceB, ["sync", "enable", "--json"], "0.49.1 sync enable (peer)");
	const payload = (
		await cli(oldInstall, deviceB, ["sync", "pair", "--payload-only"], "0.49.1 pairing payload")
	).trim();
	await cli(oldInstall, deviceA, ["sync", "enable", "--json"], "0.49.1 sync enable");
	for (const memory of MEMORIES) {
		await cli(
			oldInstall,
			deviceA,
			[
				"memory",
				"remember",
				"-k",
				"decision",
				"-t",
				memory.title,
				"-b",
				`${memory.title} body`,
				"--project",
				memory.project,
			],
			`0.49.1 remember ${memory.title}`,
		);
	}
	await fixture(oldInstall, deviceA, "seed", "0.49.1 private memory and Project mappings");
	await cli(
		oldInstall,
		deviceA,
		// A fixed address keeps the stored pairing independent of the host's interfaces.
		["sync", "pair", "--accept", payload, "--name", PEER_NAME, "--include", ALPHA, "--address", "127.0.0.1:7337"],
		"0.49.1 accept pairing",
	);
}

/** Upgrade a store written by 0.49.1 and check its memories, mappings and pairing survive. */
export async function smokeUpgradeFromPublished(candidateInstall, isolatedRoot, { runtimeEnv }) {
	const oldInstall = installPublishedRelease(isolatedRoot);
	const deviceA = deviceEnv(runtimeEnv, isolatedRoot, "device-a");
	const deviceB = deviceEnv(runtimeEnv, isolatedRoot, "device-b");
	await seedPublishedStore(oldInstall, deviceA, deviceB);
	const before = await fixture(oldInstall, deviceA, "snapshot", "0.49.1 snapshot");
	assert.equal(before.memories.length, MEMORIES.length, "0.49.1 did not store every fixture memory");
	assert.equal(before.mappings.length, MAPPINGS.length, "0.49.1 did not store every Project mapping");
	assert.equal(before.peers.length, 1, "0.49.1 did not store the pairing");
	assert.deepEqual(JSON.parse(before.peers[0].projects_include_json), [ALPHA]);
	assert.ok(before.memories.some((memory) => memory.visibility === "private"), "0.49.1 private memory missing");

	// The first command the upgraded CLI runs migrates the store.
	const listed = JSON.parse(
		await cli(candidateInstall, deviceA, ["memory", "list", "--all-projects", "--limit", "50", "--json"], "candidate memory list"),
	);
	const peers = JSON.parse(await cli(candidateInstall, deviceA, ["sync", "peers", "--json"], "candidate sync peers"));
	const after = await fixture(candidateInstall, deviceA, "snapshot", "candidate snapshot");

	assert.ok(after.schemaVersion > before.schemaVersion, "candidate did not migrate the 0.49.1 schema");
	assert.equal(after.schemaVersion, after.candidateSchemaVersion, "candidate left the store below its schema");
	assert.deepEqual(after.memories, before.memories, "memories changed across the upgrade");
	assert.deepEqual(after.mappings, before.mappings, "Project mappings changed across the upgrade");
	assert.deepEqual(after.peers, before.peers, "pairing changed across the upgrade");
	const listedTitles = (Array.isArray(listed) ? listed : (listed.items ?? listed.memories ?? []))
		.map((memory) => memory.title)
		.toSorted();
	assert.deepEqual(
		listedTitles,
		MEMORIES.map((memory) => memory.title).toSorted(),
		"upgraded CLI does not list the 0.49.1 memories",
	);
	const listedPeers = Array.isArray(peers) ? peers : (peers.peers ?? []);
	assert.equal(listedPeers.length, 1, "upgraded CLI does not list the 0.49.1 pairing");
	assert.equal(listedPeers[0].peer_device_id ?? listedPeers[0].device_id, before.peers[0].peer_device_id);
	process.stdout.write(
		`Packed upgrade from ${UPGRADE_FROM_VERSION}: schema ${before.schemaVersion} -> ${after.schemaVersion}, memories, Project mappings and pairing retained\n`,
	);
}

function selectRows(db, table, columns, orderBy) {
	return db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`).all();
}

async function installedFixture(installDir, step) {
	const core = await import(pathToFileURL(join(installDir, "node_modules/@codemem/core/dist/index.js")).href);
	const store = new core.MemoryStore(process.env.CODEMEM_DB);
	try {
		if (step === "seed") {
			const ids = new Map(
				store.db.prepare("SELECT title, id FROM memory_items").all().map((row) => [row.title, row.id]),
			);
			for (const memory of MEMORIES) {
				const id = ids.get(memory.title);
				assert.ok(id, `0.49.1 memory missing: ${memory.title}`);
				if (memory.private) store.updateMemoryVisibility(id, "private");
			}
			for (const mapping of MAPPINGS) core.upsertProjectScopeSettingsMapping(store.db, mapping);
			process.stdout.write("{}");
			return;
		}
		assert.equal(step, "snapshot");
		process.stdout.write(
			JSON.stringify({
				schemaVersion: core.getSchemaVersion(store.db),
				candidateSchemaVersion: core.SCHEMA_VERSION,
				memories: selectRows(store.db, "memory_items", MEMORY_COLUMNS, "id"),
				mappings: selectRows(store.db, "project_scope_mappings", MAPPING_COLUMNS, "id"),
				peers: selectRows(store.db, "sync_peers", PEER_COLUMNS, "peer_device_id"),
			}),
		);
	} finally {
		store.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	assert.equal(process.argv[2], "--installed-fixture");
	await installedFixture(resolve(process.argv[3]), process.argv[4]);
}
