import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fingerprintPublicKey,
	initTestSchema,
	MemoryStore,
	syncProjectAllowed,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

const PEER = "peer-1";
// A loopback address nothing listens on, so no request can leave this machine.
const COORDINATOR = { sync_coordinator_url: "http://127.0.0.1:1", sync_coordinator_group: "g1" };
const DEVICES = {
	"a device without the admin secret": COORDINATOR,
	"an administrator's device": { ...COORDINATOR, sync_coordinator_admin_secret: "fixture-secret" },
	"a device with no coordinator": {},
} as const;

let dir: string;
let store: MemoryStore;

function configure(config: Record<string, unknown>) {
	writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

function pairingFilters(filters: { include: string[]; exclude: string[] } | null) {
	store.db
		.prepare(
			"UPDATE sync_peers SET projects_include_json = ?, projects_exclude_json = ? WHERE peer_device_id = ?",
		)
		.run(
			filters ? JSON.stringify(filters.include) : null,
			filters ? JSON.stringify(filters.exclude) : null,
			PEER,
		);
}

function saveScope(body: Record<string, unknown>) {
	return createApp({ storeFactory: () => store }).request("/api/sync/peers/scope", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ peer_device_id: PEER, ...body }),
	});
}

const sends = (project: string) => syncProjectAllowed(store.db, project, PEER);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-peer-scope-gate-"));
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
	const dbPath = join(dir, "store.sqlite");
	const db = new Database(dbPath);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(dbPath);
	store.db
		.prepare("INSERT INTO sync_peers(peer_device_id, created_at) VALUES (?, ?)")
		.run(PEER, "2026-11-18T00:00:00.000Z");
});

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/sync/peers/scope on a device without the admin secret", () => {
	beforeEach(() => configure(DEVICES["a device without the admin secret"]));

	it.each([
		[
			{ include: ["work"], exclude: [] },
			{ include: ["/repos/work"], exclude: [] },
		],
		[
			{ include: [], exclude: ["/repos/secret"] },
			{ include: [], exclude: ["secret"] },
		],
		[
			{ include: ["work", "play"], exclude: ["secret"] },
			{ include: ["work"], exclude: [] },
		],
	])("allows a narrowing change from %o to %o", async (current, next) => {
		pairingFilters(current);

		const response = await saveScope(next);

		expect(response.status).toBe(200);
	});

	it.each([
		["clearing the exclude list", { include: [], exclude: [] }],
		["leaving the exclude list out", { include: [] }],
		["swapping the excluded Project", { include: [], exclude: ["other"] }],
		["inheriting the shared filters", { inherit_global: true }],
	])("refuses %s, and the excluded Project stays held back", async (_name, body) => {
		pairingFilters({ include: [], exclude: ["secret"] });
		expect(sends("secret")).toBe(false);

		const response = await saveScope(body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "access_change_needs_admin_device" });
		expect(sends("secret")).toBe(false);
	});

	it("refuses own filters that send a Project the shared filters hold back", async () => {
		configure({ ...COORDINATOR, sync_projects_exclude: ["secret"] });

		const response = await saveScope({ include: [], exclude: [] });

		expect(response.status).toBe(403);
		expect(sends("secret")).toBe(false);
	});

	it("saves one more excluded Project", async () => {
		pairingFilters({ include: [], exclude: ["secret"] });

		const response = await saveScope({ include: [], exclude: ["secret", "other"] });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			project_scope: { exclude: ["secret", "other"] },
		});
		expect(sends("other")).toBe(false);
	});

	it("saves an include list where everything was sent", async () => {
		const response = await saveScope({ include: ["work"], exclude: [] });

		expect(response.status).toBe(200);
		expect(sends("play")).toBe(false);
	});
});

describe.each(["an administrator's device", "a device with no coordinator"] as const)(
	"POST /api/sync/peers/scope on %s",
	(device) => {
		beforeEach(() => configure(DEVICES[device]));

		it("lets an excluded Project flow again", async () => {
			pairingFilters({ include: [], exclude: ["secret"] });

			const response = await saveScope({ include: [], exclude: [] });

			expect(response.status).toBe(200);
			expect(sends("secret")).toBe(true);
		});
	},
);

describe("configuring a coordinator on a device that had none", () => {
	it.each([
		["with a group and no admin secret", COORDINATOR],
		["with only its address", { sync_coordinator_url: COORDINATOR.sync_coordinator_url }],
	])("turns widening off %s", async (_name, config) => {
		pairingFilters({ include: [], exclude: ["secret", "other"] });
		configure({});
		const before = await saveScope({ include: [], exclude: ["secret"] });
		expect(before.status).toBe(200);
		expect(sends("other")).toBe(true);

		configure(config);
		const after = await saveScope({ include: [], exclude: [] });

		expect(after.status).toBe(403);
		expect(await after.json()).toEqual({ error: "access_change_needs_admin_device" });
		expect(sends("secret")).toBe(false);
	});
});

describe("Project filter writes when configuration cannot be read", () => {
	it("does not freeze the damaged-reader fallback as wider filters of its own", async () => {
		configure({ ...COORDINATOR, sync_projects_exclude: ["secret"] });
		pairingFilters(null);
		writeFileSync(join(dir, "config.json"), "{");

		const response = await saveScope({ include: [], exclude: [] });
		configure({ ...COORDINATOR, sync_projects_exclude: ["secret"] });

		expect(response.status).toBe(403);
		expect(sends("secret")).toBe(false);
	});

	it.each(["{", "", "[]"])("refuses widening with invalid configuration %j", async (text) => {
		pairingFilters({ include: [], exclude: ["secret"] });
		writeFileSync(join(dir, "config.json"), text);

		const response = await saveScope({ include: [], exclude: [] });

		expect(response.status).toBe(403);
		expect(sends("secret")).toBe(false);
	});

	it("refuses widening when the configuration path is unreadable", async () => {
		pairingFilters({ include: [], exclude: ["secret"] });
		const path = join(dir, "unreadable-config");
		mkdirSync(path);
		vi.stubEnv("CODEMEM_CONFIG", path);

		const response = await saveScope({ include: [], exclude: [] });

		expect(response.status).toBe(403);
		expect(sends("secret")).toBe(false);
	});
});

describe("POST /api/sync/peers/scope", () => {
	it("still answers 404 for a pairing that does not exist", async () => {
		configure(DEVICES["a device without the admin secret"]);

		const response = await createApp({ storeFactory: () => store }).request(
			"/api/sync/peers/scope",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ peer_device_id: "nobody", include: [], exclude: [] }),
			},
		);

		expect(response.status).toBe(404);
	});
});

const NEW_PEER = "peer-new";
// The route only fingerprints the key text, so any stable string serves here.
const KEY = "ssh-ed25519 fixture-key-for-a-manual-pairing";

function enroll(filters: Record<string, unknown>) {
	return createApp({ storeFactory: () => store }).request(
		"/api/coordinator/admin/groups/g1/enroll-peer",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: "manual",
				peer_device_id: NEW_PEER,
				peer_public_key: KEY,
				fingerprint: fingerprintPublicKey(KEY),
				peer_addresses: ["127.0.0.1:1"],
				...filters,
			}),
		},
	);
}
const paired = () =>
	store.db.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?").get(NEW_PEER) !== undefined;

describe("a new manual pairing with filters of its own", () => {
	it("is refused without the admin secret when it sends a Project the shared filters hold back", async () => {
		configure({ ...COORDINATOR, sync_projects_exclude: ["secret"] });

		const response = await enroll({ projects_include: ["secret"] });

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "access_change_needs_admin_device" });
		expect(paired()).toBe(false);
	});

	it("is saved without the admin secret when it holds back more", async () => {
		configure({ ...COORDINATOR, sync_projects_exclude: ["secret"] });

		const response = await enroll({ projects_exclude: ["secret", "other"] });

		expect(response.status).toBe(200);
		expect(syncProjectAllowed(store.db, "other", NEW_PEER)).toBe(false);
	});

	it("is saved without the admin secret when it has no filters of its own", async () => {
		configure({ ...COORDINATOR, sync_projects_exclude: ["secret"] });

		const response = await enroll({});

		expect(response.status).toBe(200);
		expect(syncProjectAllowed(store.db, "secret", NEW_PEER)).toBe(false);
	});

	it("is saved on an administrator's device", async () => {
		configure({ ...DEVICES["an administrator's device"], sync_projects_exclude: ["secret"] });

		const response = await enroll({ projects_include: ["secret"] });

		expect(response.status).toBe(200);
		expect(paired()).toBe(true);
	});
});

describe("recreating a pairing with retained restrictions", () => {
	it("refuses explicit widening after the same pairing was removed", async () => {
		configure(COORDINATOR);
		store.db
			.prepare(
				`INSERT INTO sync_peers(peer_device_id, projects_include_json, created_at)
				 VALUES (?, '["work"]', '2026-11-18T00:00:00Z')`,
			)
			.run(NEW_PEER);
		store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(NEW_PEER);

		const response = await enroll({ projects_include: ["play"] });

		expect(response.status).toBe(403);
		expect(paired()).toBe(false);
	});

	it("checks retained restrictions inside the creation transaction", async () => {
		configure(COORDINATOR);
		store.db
			.prepare(
				`INSERT INTO peer_project_filter_retention(peer_device_id, projects_include_json)
				 VALUES (?, '["work"]')`,
			)
			.run(NEW_PEER);
		const prepare = store.db.prepare.bind(store.db);
		let checked = false;
		const spy = vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
			if (sql.includes("FROM peer_project_filter_retention")) {
				checked = true;
				expect(store.db.inTransaction).toBe(true);
			}
			return prepare(sql);
		});
		try {
			const response = await enroll({ projects_include: ["play"] });

			expect(response.status).toBe(403);
			expect(checked).toBe(true);
			expect(paired()).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("restores a removed pairing's restriction when its payload is imported", async () => {
		configure(COORDINATOR);
		store.db
			.prepare(
				`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint,
				 projects_include_json, created_at) VALUES (?, ?, ?, '["work"]', '2026-11-18T00:00:00Z')`,
			)
			.run(NEW_PEER, KEY, fingerprintPublicKey(KEY));
		store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(NEW_PEER);

		const response = await createApp({ storeFactory: () => store }).request(
			"/api/sync/invites/import",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					invite: JSON.stringify({
						device_id: NEW_PEER,
						public_key: KEY,
						fingerprint: fingerprintPublicKey(KEY),
						addresses: ["127.0.0.1:1"],
					}),
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(syncProjectAllowed(store.db, "play", NEW_PEER)).toBe(false);
		expect(syncProjectAllowed(store.db, "work", NEW_PEER)).toBe(true);
	});
});
