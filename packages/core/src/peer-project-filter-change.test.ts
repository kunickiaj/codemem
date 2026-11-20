import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deviceMayWidenPeerProjectFilters,
	newPairingFiltersNeedAdmin,
	peerProjectFiltersOnlyNarrow,
	setPeerProjectFilterChecked,
} from "./peer-project-filter-change.js";
import { syncProjectAllowed } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";

const PEER = "peer-1";
let dir: string;
let db: InstanceType<typeof Database>;

/** The filters every pairing inherits unless it has its own. */
function globalFilters(filters: { include?: string[]; exclude?: string[] }) {
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			sync_projects_include: filters.include ?? [],
			sync_projects_exclude: filters.exclude ?? [],
		}),
	);
}

/** The pairing's own filters, or none when it inherits. */
function pairingFilters(filters: { include: string[]; exclude: string[] } | null) {
	db.prepare(
		"UPDATE sync_peers SET projects_include_json = ?, projects_exclude_json = ? WHERE peer_device_id = ?",
	).run(
		filters ? JSON.stringify(filters.include) : null,
		filters ? JSON.stringify(filters.exclude) : null,
		PEER,
	);
}

function save(
	next: { include: string[] | null; exclude: string[] | null },
	access: { mayWiden: boolean } = { mayWiden: false },
) {
	return setPeerProjectFilterChecked(db, PEER, { ...next, ...access });
}

const sends = (project: string) => syncProjectAllowed(db, project, PEER);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-peer-filter-change-"));
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	vi.stubEnv("CODEMEM_SYNC_PROJECTS_INCLUDE", undefined);
	vi.stubEnv("CODEMEM_SYNC_PROJECTS_EXCLUDE", undefined);
	globalFilters({});
	db = new Database(":memory:");
	initTestSchema(db);
	db.prepare("INSERT INTO sync_peers(peer_device_id, created_at) VALUES (?, ?)").run(
		PEER,
		"2026-11-18T00:00:00.000Z",
	);
});

afterEach(() => {
	db.close();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("whether new filters send nothing the current ones hold back", () => {
	const filters = (include: string[], exclude: string[]) => ({ include, exclude });

	it.each([
		["the same filters", filters([], ["secret"]), filters([], ["secret"]), true],
		["one more excluded Project", filters([], ["secret"]), filters([], ["secret", "other"]), true],
		["an include list where there was none", filters([], []), filters(["work"], []), true],
		["a shorter include list", filters(["work", "play"], []), filters(["work"], []), true],
		["an excluded Project removed", filters([], ["secret"]), filters([], []), false],
		["an excluded Project swapped", filters([], ["secret"]), filters([], ["other"]), false],
		["an include list removed", filters(["work"], []), filters([], []), false],
		["an include list extended", filters(["work"], []), filters(["work", "play"], []), false],
		[
			"an excluded Project moved to the include list",
			filters([], ["secret"]),
			filters(["secret"], []),
			false,
		],
		[
			"an excluded path replaced by its folder name",
			filters([], ["/code/secret"]),
			filters([], ["secret"]),
			false,
		],
	])("%s: %o to %o only narrows: %s", (_name, current, next, expected) => {
		expect(peerProjectFiltersOnlyNarrow(current, next)).toBe(expected);
	});
});

describe("a device that may not widen what a pairing receives", () => {
	it("cannot make an excluded Project flow again", () => {
		pairingFilters({ include: [], exclude: ["secret"] });
		expect(sends("secret")).toBe(false);

		const result = save({ include: [], exclude: [] });

		expect(result).toBe("needs_admin_device");
		expect(sends("secret")).toBe(false);
	});

	it("cannot make an excluded Project flow again by sending no lists", () => {
		pairingFilters({ include: [], exclude: ["secret"] });

		expect(save({ include: null, exclude: [] })).toBe("needs_admin_device");
		expect(sends("secret")).toBe(false);
	});

	it("cannot drop the pairing's filters to inherit wider shared ones", () => {
		pairingFilters({ include: ["work"], exclude: [] });

		expect(save({ include: null, exclude: null })).toBe("needs_admin_device");
		expect(sends("play")).toBe(false);
	});

	it("cannot give a pairing that inherits an excluded Project its own wider filters", () => {
		globalFilters({ exclude: ["secret"] });
		pairingFilters(null);
		expect(sends("secret")).toBe(false);

		expect(save({ include: [], exclude: [] })).toBe("needs_admin_device");
		expect(sends("secret")).toBe(false);
	});

	it("can exclude one more Project", () => {
		pairingFilters({ include: [], exclude: ["secret"] });

		expect(save({ include: [], exclude: ["secret", "other"] })).toBe("saved");
		expect(sends("other")).toBe(false);
	});

	it("can stop sharing everything but one Project", () => {
		expect(save({ include: ["work"], exclude: [] })).toBe("saved");
		expect(sends("play")).toBe(false);
		expect(sends("work")).toBe(true);
	});

	it("can go back to the shared filters when they send no more than the pairing's own", () => {
		globalFilters({ include: ["work"], exclude: ["secret"] });
		pairingFilters({ include: ["work", "play"], exclude: ["secret"] });

		expect(save({ include: null, exclude: null })).toBe("saved");
		expect(sends("play")).toBe(false);
	});

	it("can give a pairing that inherits its own narrower filters", () => {
		globalFilters({ exclude: ["secret"] });

		expect(save({ include: [], exclude: ["secret", "other"] })).toBe("saved");
		expect(sends("other")).toBe(false);
	});
});

describe("a device that may widen what a pairing receives", () => {
	it("can make an excluded Project flow again", () => {
		pairingFilters({ include: [], exclude: ["secret"] });

		expect(save({ include: [], exclude: [] }, { mayWiden: true })).toBe("saved");
		expect(sends("secret")).toBe(true);
	});
});

describe("which device may widen what a pairing receives", () => {
	const coordinator = {
		syncCoordinatorUrl: "http://127.0.0.1:1",
		syncCoordinatorGroups: ["g1"],
		syncCoordinatorAdminSecret: "fixture-secret",
	};

	it.each([
		["a device set up with the coordinator's admin secret", coordinator, true],
		["a device with no coordinator", { ...coordinator, syncCoordinatorUrl: "" }, true],
		[
			"a device without the admin secret",
			{ ...coordinator, syncCoordinatorAdminSecret: "" },
			false,
		],
		["a device with the secret and no group", { ...coordinator, syncCoordinatorGroups: [] }, false],
	])("%s: %o may widen: %s", (_name, config, expected) => {
		expect(deviceMayWidenPeerProjectFilters(config)).toBe(expected);
	});
});

describe("filters a new pairing starts with", () => {
	const refused = (include: string[] | null, exclude: string[] | null, mayWiden = false) =>
		newPairingFiltersNeedAdmin(db, { include, exclude, mayWiden });

	beforeEach(() => globalFilters({ exclude: ["secret"] }));

	it("are never refused when the pairing inherits the shared filters", () => {
		expect(refused(null, null)).toBe(false);
	});

	it("are refused when they send a Project the shared filters hold back", () => {
		expect(refused([], [])).toBe(true);
		expect(refused(["work"], null)).toBe(true);
	});

	it("are accepted when they hold back at least what the shared filters do", () => {
		expect(refused(["work"], ["secret"])).toBe(false);
		expect(refused(null, ["secret", "other"])).toBe(false);
	});

	it("are accepted on a device that may widen", () => {
		expect(refused([], [], true)).toBe(false);
	});
});
