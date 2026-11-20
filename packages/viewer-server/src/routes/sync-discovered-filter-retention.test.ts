import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCoordinatorReciprocalApproval,
	fingerprintPublicKey,
	initTestSchema,
	lookupCoordinatorPeers,
	MemoryStore,
	syncProjectAllowed,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	lookupCoordinatorPeers: vi.fn(),
	createCoordinatorReciprocalApproval: vi.fn(),
}));

const PEER = "discovered-peer";
const KEY = "ssh-ed25519 fixture-discovery-key";
const COORDINATOR = "http://127.0.0.1:1";
const NOW = "2026-11-18T00:00:00Z";
const APPROVAL = {
	request_id: "approval-1",
	group_id: "g1",
	requesting_device_id: "local",
	requested_device_id: PEER,
	status: "pending",
	created_at: NOW,
	resolved_at: null,
};
let dir: string;
let store: MemoryStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-discovered-filter-"));
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	for (const name of [
		"CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_SYNC_COORDINATOR_GROUPS",
		"CODEMEM_SYNC_PROJECTS_INCLUDE",
		"CODEMEM_SYNC_PROJECTS_EXCLUDE",
		"CODEMEM_SYNC_ENABLED",
	])
		vi.stubEnv(name, undefined);
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			sync_enabled: true,
			sync_coordinator_url: COORDINATOR,
			sync_coordinator_group: "g1",
		}),
	);
	const path = join(dir, "memory.sqlite");
	const db = new Database(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
	store.db
		.prepare(
			`INSERT INTO peer_project_filter_retention(peer_device_id, projects_include_json)
		 VALUES (?, '["work"]')`,
		)
		.run(PEER);
	vi.mocked(lookupCoordinatorPeers).mockResolvedValue([
		{
			device_id: PEER,
			public_key: KEY,
			fingerprint: fingerprintPublicKey(KEY),
			addresses: ["127.0.0.1:1"],
			groups: ["g1"],
			fresh_groups: ["g1"],
			stale: false,
		},
	]);
	vi.mocked(createCoordinatorReciprocalApproval).mockResolvedValue(APPROVAL);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function template(project: string) {
	store.db
		.prepare(
			`INSERT INTO coordinator_group_preferences(coordinator_id, group_id,
		 projects_include_json, auto_seed_scope, updated_at) VALUES (?, 'g1', ?, 1, ?)`,
		)
		.run(COORDINATOR, JSON.stringify([project]), NOW);
}

function accept() {
	return createApp({ storeFactory: () => store }).request("/api/sync/peers/accept-discovered", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ peer_device_id: PEER, fingerprint: fingerprintPublicKey(KEY) }),
	});
}

it("refuses a wider seed before contacting the coordinator for approval", async () => {
	template("play");

	const response = await accept();

	expect(response.status).toBe(403);
	expect(createCoordinatorReciprocalApproval).not.toHaveBeenCalled();
});

it("restores retained restrictions when discovery supplies no replacement filters", async () => {
	const response = await accept();

	expect(response.status).toBe(200);
	expect(syncProjectAllowed(store.db, "play", PEER)).toBe(false);
	expect(syncProjectAllowed(store.db, "work", PEER)).toBe(true);
});

it("rechecks retained restrictions if they change during the approval request", async () => {
	template("work");
	vi.mocked(createCoordinatorReciprocalApproval).mockImplementationOnce(async () => {
		store.db
			.prepare(
				`UPDATE peer_project_filter_retention SET projects_include_json = '["restricted"]'
			 WHERE peer_device_id = ?`,
			)
			.run(PEER);
		return APPROVAL;
	});

	const response = await accept();

	expect(response.status).toBe(403);
	expect(
		store.db.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?").get(PEER),
	).toBeUndefined();
});
