import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, fingerprintPublicKey, initTestSchema, syncProjectAllowed } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { syncCommand } from "./sync.js";

const PEER = "peer-1";
// A loopback address nothing listens on, so no request can leave this machine.
const COORDINATOR = { sync_coordinator_url: "http://127.0.0.1:1", sync_coordinator_group: "g1" };
const WITHOUT_SECRET = COORDINATOR;
const ADMIN = { ...COORDINATOR, sync_coordinator_admin_secret: "fixture-secret" };
const PAYLOAD = JSON.stringify({
	device_id: PEER,
	fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
	public_key: CANONICAL_PUBLIC_KEY,
	addresses: ["127.0.0.1:1"],
});

const REFUSED =
	"These filters would send this pairing Projects it does not receive now. Only an administrator's device can do that. This device can send less. Nothing was changed.";

let dir: string;
let dbPath: string;
let db: ReturnType<typeof connect>;
let output: string[];
let previousExitCode: typeof process.exitCode;

function configure(config: Record<string, unknown>) {
	writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

/** An existing pairing, with its own filters or inheriting the shared ones. */
function pairedWith(filters: { include: string[]; exclude: string[] } | null) {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, public_key, addresses_json,
		 projects_include_json, projects_exclude_json, created_at)
		 VALUES (?, 'before', ?, ?, '["127.0.0.1:1"]', ?, ?, '2026-11-18T00:00:00.000Z')`,
	).run(
		PEER,
		fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
		CANONICAL_PUBLIC_KEY,
		filters ? JSON.stringify(filters.include) : null,
		filters ? JSON.stringify(filters.exclude) : null,
	);
}

/** Runs `codemem sync pair --accept` with the given flags and returns its JSON output. */
async function accept(...flags: string[]) {
	const pair = syncCommand.commands.find((command) => command.name() === "pair");
	if (!pair) throw new Error("sync pair command missing");
	// Commander keeps option values between runs of one command object.
	for (const option of pair.options) {
		pair.setOptionValueWithSource(option.attributeName(), undefined, "default");
	}
	await pair.parseAsync(
		["--accept", PAYLOAD, "--name", "after", "--db-path", dbPath, "--json", ...flags],
		{ from: "user" },
	);
	return JSON.parse(output.at(-1) ?? "{}") as Record<string, unknown>;
}

const sends = (project: string) => syncProjectAllowed(db, project, PEER);
const pairingName = () =>
	db.prepare("SELECT name FROM sync_peers WHERE peer_device_id = ?").pluck().get(PEER);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-sync-pair-filters-"));
	dbPath = join(dir, "mem.sqlite");
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	for (const name of [
		"CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_SYNC_COORDINATOR_GROUPS",
		"CODEMEM_SYNC_PROJECTS_INCLUDE",
		"CODEMEM_SYNC_PROJECTS_EXCLUDE",
	]) {
		vi.stubEnv(name, undefined);
	}
	db = connect(dbPath);
	initTestSchema(db);
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

describe("sync pair --accept on a device without the admin secret", () => {
	beforeEach(() => configure(WITHOUT_SECRET));

	it.each([
		["--all", ["--all"]],
		["an exclude list without the excluded Project", ["--exclude", "other"]],
		["--default", ["--default"]],
	])(
		"refuses %s for a pairing that holds a Project back, and changes nothing",
		async (_name, flags) => {
			pairedWith({ include: [], exclude: ["secret"] });

			const result = await accept(...flags);

			expect(result).toEqual({ error: "pairing_failed", message: REFUSED });
			expect(process.exitCode).toBe(1);
			expect(sends("secret")).toBe(false);
			expect(pairingName()).toBe("before");
		},
	);

	it("refuses --all for a new pairing when the shared filters hold a Project back, and pairs nothing", async () => {
		configure({ ...WITHOUT_SECRET, sync_projects_exclude: ["secret"] });

		const result = await accept("--all");

		expect(result).toEqual({ error: "pairing_failed", message: REFUSED });
		expect(pairingName()).toBeUndefined();
	});

	it("accepts an exclude list that holds back one more Project", async () => {
		pairedWith({ include: [], exclude: ["secret"] });

		const result = await accept("--exclude", "secret,other");

		expect(result).toEqual({ ok: true, peer_device_id: PEER });
		expect(sends("other")).toBe(false);
		expect(pairingName()).toBe("after");
	});

	it("pairs without touching the filters when no filter flag is given", async () => {
		pairedWith({ include: [], exclude: ["secret"] });

		const result = await accept();

		expect(result).toEqual({ ok: true, peer_device_id: PEER });
		expect(sends("secret")).toBe(false);
		expect(pairingName()).toBe("after");
	});
});

describe.each([
	["an administrator's device", ADMIN],
	["a device with no coordinator", {}],
])("sync pair --accept on %s", (_name, config) => {
	beforeEach(() => configure(config));

	it("lets --all send a Project the pairing held back", async () => {
		pairedWith({ include: [], exclude: ["secret"] });

		const result = await accept("--all");

		expect(result).toEqual({ ok: true, peer_device_id: PEER });
		expect(sends("secret")).toBe(true);
	});
});
