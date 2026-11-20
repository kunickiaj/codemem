import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	newPairingFiltersNeedAdmin,
	peerProjectFiltersOnlyNarrow,
	readPeerProjectFilterAuthority,
	setPeerProjectFilterChecked,
} from "./peer-project-filter-change.js";
import { syncProjectAllowed, syncProjectAllowedByFilters } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";

const PEER = "peer-1";
const COORDINATOR = { sync_coordinator_url: "http://127.0.0.1:1", sync_coordinator_group: "g1" };
const ADMIN = { ...COORDINATOR, sync_coordinator_admin_secret: "fixture-secret" };
let dir: string;
let db: InstanceType<typeof Database>;

function configure(config: Record<string, unknown>) {
	writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

/** The filters every pairing inherits unless it has its own. */
function globalFilters(filters: { include?: string[]; exclude?: string[] }) {
	configure({
		...COORDINATOR,
		sync_projects_include: filters.include ?? [],
		sync_projects_exclude: filters.exclude ?? [],
	});
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

function save(next: { include: string[] | null; exclude: string[] | null }) {
	return setPeerProjectFilterChecked(db, PEER, next);
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
			true,
		],
		[
			"an included basename restricted to one path",
			filters(["work"], []),
			filters(["/repos/work"], []),
			true,
		],
		[
			"a redundant exclusion removed while the include list shrinks",
			filters(["work", "play"], ["secret"]),
			filters(["work"], []),
			true,
		],
		[
			"one included path expanded to every matching basename",
			filters(["/repos/work"], []),
			filters(["work"], []),
			false,
		],
		[
			"an exclusion narrowed from every basename to one path",
			filters([], ["secret"]),
			filters([], ["/repos/secret"]),
			false,
		],
	])("%s: %o to %o only narrows: %s", (_name, current, next, expected) => {
		expect(peerProjectFiltersOnlyNarrow(current, next)).toBe(expected);
	});
});

it("agrees with delivery across literal, basename, slash and backslash cases", () => {
	const lists = [[], ["work"], ["/repos/work"], ["work", "play"], ["secret"], ["work/"]];
	const values = [
		"",
		"work",
		"work/",
		"work\\",
		"/repos/work",
		"/else/work",
		"\\else\\work",
		"play",
		"/else/play",
		"secret",
		"/else/secret",
		"unknown",
		"/else/unknown",
	];
	const filters = lists.flatMap((include) => lists.map((exclude) => ({ include, exclude })));
	for (const current of filters) {
		for (const next of filters) {
			const widens = values.some(
				(value) =>
					syncProjectAllowedByFilters(value, next) && !syncProjectAllowedByFilters(value, current),
			);
			expect(peerProjectFiltersOnlyNarrow(current, next)).toBe(!widens);
		}
	}
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

	it("compares the trimmed lists that delivery will read after storage", () => {
		pairingFilters({ include: ["work"], exclude: [] });

		expect(save({ include: [" play ", ""], exclude: [] })).toBe("needs_admin_device");
		expect(sends("play")).toBe(false);
		expect(save({ include: [" /repos/work ", ""], exclude: [] })).toBe("saved");
		expect(sends("/repos/work")).toBe(true);
		expect(sends("/else/work")).toBe(false);
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
		configure(ADMIN);
		pairingFilters({ include: [], exclude: ["secret"] });

		expect(save({ include: [], exclude: [] })).toBe("saved");
		expect(sends("secret")).toBe(true);
	});
});

describe("which device may widen what a pairing receives", () => {
	it.each([
		["a device set up with the coordinator's admin secret", ADMIN, true],
		["a device with no coordinator", {}, true],
		["a device without the admin secret", COORDINATOR, false],
		["a device with the secret and no group", { ...ADMIN, sync_coordinator_group: "" }, false],
		[
			"a device with only the coordinator's address",
			{ sync_coordinator_url: COORDINATOR.sync_coordinator_url },
			false,
		],
	])("%s: %o may widen: %s", (_name, config, expected) => {
		configure(config);
		expect(readPeerProjectFilterAuthority(db)).toBe(expected);
	});

	it("refuses widening if store management history cannot be read", () => {
		configure({});
		db.exec("DROP TABLE peer_project_filter_management");
		pairingFilters({ include: [], exclude: ["secret"] });

		expect(save({ include: [], exclude: [] })).toBe("needs_admin_device");
		expect(sends("secret")).toBe(false);
	});
});

describe("filters a new pairing starts with", () => {
	const refused = (include: string[] | null, exclude: string[] | null) =>
		newPairingFiltersNeedAdmin(db, { peerDeviceId: PEER, include, exclude });

	beforeEach(() => globalFilters({ exclude: ["secret"] }));

	it("are never refused when the pairing inherits the shared filters", () => {
		expect(refused(null, null)).toBe(false);
	});

	it("are refused when they send a Project the shared filters hold back", () => {
		expect(refused([], [])).toBe(true);
		expect(refused(["secret"], null)).toBe(true);
	});

	it("are accepted when they hold back at least what the shared filters do", () => {
		expect(refused(["work"], ["secret"])).toBe(false);
		expect(refused(["work"], null)).toBe(false);
		expect(refused(null, ["secret", "other"])).toBe(false);
	});

	it("are accepted on a device that may widen", () => {
		configure({ ...ADMIN, sync_projects_exclude: ["secret"] });
		expect(refused([], [])).toBe(false);
	});
});

describe("replacement lists for a removed pairing", () => {
	beforeEach(() => {
		pairingFilters({ include: ["work"], exclude: ["secret"] });
		db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(PEER);
	});

	it("keeps the retained filter as the baseline before recreation", () => {
		expect(sends("secret")).toBe(false);
		expect(sends("play")).toBe(false);
		expect(sends("work")).toBe(true);
	});

	it("refuses explicit replacements that exceed the removed pairing's restrictions", () => {
		expect(
			newPairingFiltersNeedAdmin(db, {
				peerDeviceId: PEER,
				include: [],
				exclude: [],
			}),
		).toBe(true);
	});
});
