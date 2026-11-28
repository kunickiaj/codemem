import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	connect,
	fingerprintPublicKey,
	initTestSchema,
	MemoryStore,
	readPeerTransportPolicy,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	CANONICAL_PUBLIC_KEY,
	publicKeyFromWire,
	wireBytes,
} from "../../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { syncCommand } from "./sync.js";

const PEER = "peer-1";
const PAYLOAD = {
	device_id: PEER,
	fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
	public_key: CANONICAL_PUBLIC_KEY,
	addresses: ["127.0.0.1:1"],
	transports: ["noise1"],
};
// Another valid key, as a re-pin from another process would store.
const OTHER_KEY = publicKeyFromWire(
	wireBytes({ trailing: [] }).map((b, i) => (i === 50 ? b ^ 1 : b)),
);
const driver = createRequire(new URL("../../../core/package.json", import.meta.url)).resolve(
	"better-sqlite3",
);

let dir: string;
let dbPath: string;
let db: ReturnType<typeof connect>;
let output: string[];
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-sync-pair-atomic-"));
	dbPath = join(dir, "mem.sqlite");
	// A coordinator without the admin secret: this device may narrow filters but not widen them.
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ sync_coordinator_url: "http://127.0.0.1:1", sync_coordinator_group: "g1" }),
	);
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	for (const name of ["CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "CODEMEM_SYNC_COORDINATOR_URL"])
		vi.stubEnv(name, undefined);
	db = connect(dbPath);
	initTestSchema(db);
	// The first store open writes its compatibility markers. Do that now, so the
	// pair command's own open does not wait on the other process's lock.
	new MemoryStore(dbPath).close();
	output = [];
	vi.spyOn(console, "log").mockImplementation((line) => {
		output.push(String(line));
	});
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
});

afterEach(() => {
	db.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = previousExitCode;
	rmSync(dir, { recursive: true, force: true });
});

async function accept(...flags: string[]) {
	const pair = syncCommand.commands.find((command) => command.name() === "pair");
	if (!pair) throw new Error("sync pair command missing");
	for (const option of pair.options)
		pair.setOptionValueWithSource(option.attributeName(), undefined, "default");
	await pair.parseAsync(
		["--accept", JSON.stringify(PAYLOAD), "--db-path", dbPath, "--json", ...flags],
		{ from: "user" },
	);
	return JSON.parse(output.at(-1) ?? "{}") as Record<string, unknown>;
}

/**
 * Another process holds the write lock while it changes the pairing, and
 * commits shortly after the pair command starts. The command must either see
 * the change or wait for it, never act on what it read before.
 */
async function whileAnotherProcessWrites(
	statements: Array<[string, unknown[]]>,
	run: () => Promise<Record<string, unknown>>,
) {
	const worker = new Worker(
		`const { parentPort, workerData } = require("node:worker_threads");
		const Database = require(workerData.driver);
		const db = new Database(workerData.dbPath);
		db.pragma("busy_timeout = 5000");
		db.exec("BEGIN IMMEDIATE");
		for (const [sql, params] of workerData.statements) db.prepare(sql).run(...params);
		parentPort.postMessage("locked");
		setTimeout(() => { db.exec("COMMIT"); db.close(); parentPort.postMessage("committed"); }, 1500);`,
		{ eval: true, workerData: { driver, dbPath, statements } },
	);
	const message = (expected: string) =>
		new Promise<void>((resolve, reject) => {
			worker.on("message", (value) => value === expected && resolve());
			worker.once("error", reject);
		});
	const committed = message("committed");
	await message("locked");
	const result = await run();
	await committed;
	await worker.terminate();
	return result;
}

const pairing = () =>
	db
		.prepare(
			"SELECT public_key, addresses_json, projects_exclude_json FROM sync_peers WHERE peer_device_id = ?",
		)
		.get(PEER) as
		| { public_key: string; addresses_json: string; projects_exclude_json: string | null }
		| undefined;

it("refuses a payload whose device another process re-pins meanwhile, writing nothing", async () => {
	const result = await whileAnotherProcessWrites(
		[
			[
				`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, addresses_json, created_at)
				 VALUES (?, ?, ?, '["10.0.0.9:7337"]', '2026-11-27T00:00:00.000Z')`,
				[PEER, OTHER_KEY, fingerprintPublicKey(OTHER_KEY)],
			],
		],
		() => accept(),
	);

	expect(result).toMatchObject({ error: "peer_conflict" });
	expect(pairing()).toMatchObject({ public_key: OTHER_KEY, addresses_json: '["10.0.0.9:7337"]' });
	expect(readPeerTransportPolicy(db, PEER)).toBe("legacy_plaintext");
});

it("rolls back the pin and evidence when the filter write is refused after another process narrows it", async () => {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, addresses_json,
		 projects_include_json, projects_exclude_json, created_at)
		 VALUES (?, ?, ?, '["127.0.0.1:1"]', '[]', '["secret"]', '2026-11-27T00:00:00.000Z')`,
	).run(PEER, CANONICAL_PUBLIC_KEY, PAYLOAD.fingerprint);

	// Holding back secret and other narrows the current filters, but not the ones about to land.
	const result = await whileAnotherProcessWrites(
		[
			[
				`UPDATE sync_peers SET projects_exclude_json = '["secret","other","more"]' WHERE peer_device_id = ?`,
				[PEER],
			],
		],
		() => accept("--exclude", "secret,other", "--address", "10.0.0.5:7337"),
	);

	expect(result).toMatchObject({
		error: "pairing_failed",
		message: expect.stringContaining("Nothing was changed"),
	});
	expect(pairing()).toEqual({
		public_key: CANONICAL_PUBLIC_KEY,
		addresses_json: '["127.0.0.1:1"]',
		projects_exclude_json: '["secret","other","more"]',
	});
	expect(readPeerTransportPolicy(db, PEER)).toBe("legacy_plaintext");
});
