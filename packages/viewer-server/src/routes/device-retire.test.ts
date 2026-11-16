import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fingerprintPublicKey,
	initTestSchema,
	listDeviceIdentityInventory,
	MemoryStore,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

const COORDINATOR = "https://coordinator.example.test";
const DIGEST = "a".repeat(64);
const NOW = "2026-11-16T00:00:00.000Z";

/** A well-formed SSH Ed25519 key whose 32 key bytes all equal `byte`. */
function sshWire(byte: number): Buffer {
	const type = Buffer.from("ssh-ed25519");
	const length = (value: number) => Buffer.from([0, 0, 0, value]);
	return Buffer.concat([length(type.length), type, length(32), Buffer.alloc(32, byte)]);
}
const sshKey = (byte: number) => `ssh-ed25519 ${sshWire(byte).toString("base64")}`;
/** The coordinator's canonical key ID: SHA-256 of the canonical SSH blob. */
const keyIdOf = (byte: number) => createHash("sha256").update(sshWire(byte)).digest("hex");

const OLD_KEY = sshKey(1);
const LOCAL_KEY = sshKey(2);
const BOB_KEY = sshKey(3);
const KEY_IDS = new Map([OLD_KEY, LOCAL_KEY, BOB_KEY].map((key, i) => [key, keyIdOf(i + 1)]));
/** Same canonical key as `key`, different text, so a different text fingerprint. */
const commented = (key: string) => `${key} spare`;

let dir: string;
let store: MemoryStore;
let previousConfig: string | undefined;
let previousFetch: typeof fetch;
let enrollments: Array<Record<string, unknown>>;
let commits: Array<Record<string, unknown>>;
let previews: Array<Record<string, unknown>>;
let groupRequests: string[];

function enrollment(deviceId: string, publicKey = OLD_KEY, groupId = "group-a") {
	return {
		group_id: groupId,
		device_id: deviceId,
		display_name: "Old laptop",
		public_key: publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		identity_id: null,
		enabled: 1,
		created_at: NOW,
	};
}

function pair(deviceId: string, publicKey = OLD_KEY) {
	store.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, public_key, created_at) VALUES (?, 'Old laptop', ?, ?, ?)",
		)
		.run(deviceId, fingerprintPublicKey(publicKey), publicKey, NOW);
}

function bind(deviceId: string) {
	store.db
		.prepare(
			`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
			 revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES (?, 'identity-a', 'Old laptop', 'active', 'test', '1', 'user_managed', ?, ?, ?)`,
		)
		.run(deviceId, `bind-${deviceId}`, NOW, NOW);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-device-retire-test-"));
	const dbPath = join(dir, "store.sqlite");
	const db = new Database(dbPath);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(dbPath);
	store.db
		.prepare(
			"INSERT OR REPLACE INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(store.deviceId, LOCAL_KEY, fingerprintPublicKey(LOCAL_KEY), NOW);
	// Environment overrides outrank the config file, so a developer's real coordinator settings can't leak in.
	for (const key of Object.keys(process.env))
		if (key.startsWith("CODEMEM_SYNC_COORDINATOR_")) vi.stubEnv(key, "");
	previousConfig = process.env.CODEMEM_CONFIG;
	previousFetch = globalThis.fetch;
	process.env.CODEMEM_CONFIG = join(dir, "config.json");
	writeFileSync(
		process.env.CODEMEM_CONFIG,
		JSON.stringify({
			sync_coordinator_url: COORDINATOR,
			sync_coordinator_groups: ["group-a"],
			sync_coordinator_admin_secret: "test-secret",
		}),
	);
	enrollments = [];
	commits = [];
	previews = [];
	groupRequests = [];
	globalThis.fetch = vi.fn(coordinatorFetch) as typeof fetch;
});

afterEach(() => {
	vi.unstubAllEnvs();
	store.close();
	if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
	else process.env.CODEMEM_CONFIG = previousConfig;
	globalThis.fetch = previousFetch;
	rmSync(dir, { recursive: true, force: true });
});

function subjects(deviceId: string, groupId: string) {
	const row = enrollments.find((item) => item.device_id === deviceId && item.group_id === groupId);
	const key = String(row?.public_key ?? "").replace(/ spare$/, "");
	return {
		version: 1,
		coordinator_id: COORDINATOR,
		group_id: groupId,
		device_id: deviceId,
		key_id: KEY_IDS.get(key) ?? "c".repeat(64),
		scope: "whole_database_device_id_any_key_and_canonical_key_any_device_all_groups",
	};
}

function requestBody(init?: RequestInit): Record<string, unknown> {
	const raw = init?.body;
	const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBufferView);
	return JSON.parse(text || "{}") as Record<string, unknown>;
}

async function coordinatorFetch(input: RequestInfo | URL, init?: RequestInit) {
	const url = String(input);
	if (/\/v1\/admin\/groups(\?|$)/.test(url)) {
		groupRequests.push(url);
		const groups = [...new Set(enrollments.map((row) => String(row.group_id)))];
		return Response.json({
			items: (groups.length ? groups : ["group-a"]).map((group_id) => ({ group_id })),
		});
	}
	if (url.includes("/v1/admin/devices?")) {
		const groupId = new URL(url).searchParams.get("group_id");
		return Response.json({ items: enrollments.filter((row) => row.group_id === groupId) });
	}
	const body = requestBody(init);
	const deviceId = String(body.device_id);
	const groupId = String(body.group_id);
	if (url.endsWith("/v1/admin/devices/revoke-preview")) {
		previews.push(body);
		return Response.json({
			state: "ready",
			...subjects(deviceId, groupId),
			expected_digest: DIGEST,
		});
	}
	if (url.endsWith("/v1/admin/devices/revoke")) {
		commits.push(body);
		const revocation = (kind: string, value: string) => ({
			subject_kind: kind,
			subject_value: value,
			revocation_id: "revocation-1",
			created_at: NOW,
		});
		return Response.json({
			state: "revoked",
			...subjects(deviceId, groupId),
			revocations: [
				revocation("device_id", deviceId),
				revocation("ed25519_key", subjects(deviceId, groupId).key_id),
			],
		});
	}
	return Response.json({ error: "not_found" }, { status: 404 });
}

function post(path: string, body?: unknown) {
	return createApp({ storeFactory: () => store }).request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function retire(deviceId: string) {
	const preview = await post(`/api/sync/devices/${deviceId}/retire/preview`);
	if (preview.status !== 200) return { preview, committed: null };
	const body = await preview.json();
	return { preview: body, committed: await post(`/api/sync/devices/${deviceId}/retire`, body) };
}

function pairedIds(): string[] {
	return store.db
		.prepare("SELECT peer_device_id FROM sync_peers ORDER BY 1")
		.pluck()
		.all() as string[];
}

function inventoryAfterRetirement(availability: "available" | "unavailable") {
	return listDeviceIdentityInventory(store.db, {
		localDeviceId: store.deviceId,
		coordinator: {
			availability,
			safeErrorCode: availability === "available" ? null : "coordinator_unavailable",
			enrollments:
				availability === "available"
					? (enrollments.map((row) => ({ ...row, revoked: true })) as never)
					: [],
		},
	}).items.filter((item) => !item.isLocal);
}

describe("device retirement across aliases", () => {
	it.each([
		{
			name: "one ID everywhere",
			peers: ["old-laptop"],
			enrolled: ["old-laptop"],
			bound: [],
			pick: "old-laptop",
			revoked: "old-laptop",
		},
		{
			name: "pairing and enrollment under different IDs",
			peers: ["old-laptop"],
			enrolled: ["coord-alias"],
			bound: [],
			pick: "old-laptop",
			revoked: "coord-alias",
		},
		{
			name: "binding and enrollment share an ID, pairing differs",
			peers: ["old-laptop"],
			enrolled: ["coord-alias"],
			bound: ["coord-alias"],
			pick: "coord-alias",
			revoked: "coord-alias",
		},
		{
			name: "two pairings with the same key",
			peers: ["old-laptop", "old-laptop-2"],
			enrolled: ["old-laptop"],
			bound: [],
			pick: "old-laptop-2",
			revoked: "old-laptop",
		},
		{
			name: "unpaired enrollment only",
			peers: [],
			enrolled: ["old-tablet"],
			bound: [],
			pick: "old-tablet",
			revoked: "old-tablet",
		},
	])("$name: revokes the enrollment, unpairs every alias, and stays retired", async (row) => {
		for (const id of row.peers) pair(id);
		for (const id of row.bound) bind(id);
		enrollments = row.enrolled.map((id) => enrollment(id));

		const { committed } = await retire(row.pick);

		expect(committed?.status).toBe(200);
		expect(commits.map((body) => body.device_id)).toEqual([row.revoked]);
		// Revocation covers archived groups, so they count as evidence too.
		expect(groupRequests).not.toEqual([]);
		expect(groupRequests.every((url) => url.endsWith("?include_archived=1"))).toBe(true);
		expect(pairedIds()).toEqual([]);
		for (const availability of ["available", "unavailable"] as const) {
			const items = inventoryAfterRetirement(availability);
			expect(items.map((item) => item.state)).toEqual(items.length ? ["retired"] : []);
		}
	});
});

describe("device retirement refuses keys it can't safely revoke", () => {
	it("refuses an enrollment alias that shares this device's key", async () => {
		enrollments = [enrollment("coord-alias", LOCAL_KEY)];

		const { preview } = await retire("coord-alias");

		expect(preview.status).toBe(400);
		expect(await preview.json()).toEqual({ error: "cannot_retire_this_device" });
		expect(previews).toEqual([]);
	});

	it("refuses an enrollment whose key text differs but whose canonical key is this device's", async () => {
		enrollments = [enrollment("spare", commented(LOCAL_KEY))];

		const { preview } = await retire("spare");

		expect(preview.status).toBe(400);
		expect(await preview.json()).toEqual({ error: "cannot_retire_this_device" });
		expect(previews).toEqual([]);
	});

	it.each([
		{ name: "a pairing", setup: () => pair("bob", BOB_KEY) },
		{ name: "another enrollment", setup: () => enrollments.push(enrollment("bob", BOB_KEY)) },
	])(
		"refuses a device whose canonical key also belongs to $name outside its group",
		async (row) => {
			enrollments = [enrollment("spare", commented(BOB_KEY))];
			row.setup();

			const { preview } = await retire("spare");

			expect(preview.status).toBe(409);
			expect(await preview.json()).toEqual({ error: "device_enrollment_conflict" });
			expect(previews).toEqual([]);
		},
	);

	it.each([
		{
			name: "its stored fingerprint doesn't match its key",
			setup: () => store.db.prepare("UPDATE sync_device SET fingerprint = 'wrong'").run(),
		},
		{
			name: "a second identity row exists",
			setup: () =>
				store.db
					.prepare(
						"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('other', ?, ?, ?)",
					)
					.run(OLD_KEY, fingerprintPublicKey(OLD_KEY), NOW),
		},
	])("refuses to retire anything when this device's identity is unverified: $name", async (row) => {
		pair("old-laptop");
		enrollments = [enrollment("old-laptop")];
		row.setup();

		const { preview } = await retire("old-laptop");

		expect(preview.status).toBe(409);
		expect(await preview.json()).toEqual({ error: "local_identity_unverified" });
		expect(previews).toEqual([]);
	});

	it("refuses when the coordinator would revoke a different key than the one checked", async () => {
		pair("old-laptop");
		enrollments = [enrollment("old-laptop")];
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const res = await coordinatorFetch(input, init);
			if (!String(input).endsWith("/revoke-preview")) return res;
			return Response.json({ ...(await res.json()), key_id: keyIdOf(2) });
		}) as typeof fetch;

		const { preview } = await retire("old-laptop");

		expect(preview.status).toBe(409);
		expect(await preview.json()).toEqual({ error: "device_enrollment_conflict" });
		expect(commits).toEqual([]);
	});
});

describe("device retirement refusals by ID", () => {
	it("refuses this device by its own ID", async () => {
		const { preview } = await retire(store.deviceId);

		expect(preview.status).toBe(400);
		expect(previews).toEqual([]);
	});

	it("refuses a device whose ID carries two keys", async () => {
		pair("old-laptop");
		enrollments = [enrollment("old-laptop"), enrollment("old-laptop", BOB_KEY, "group-b")];

		const { preview } = await retire("old-laptop");

		expect(preview.status).toBe(409);
		expect(await preview.json()).toEqual({ error: "device_enrollment_conflict" });
		expect(previews).toEqual([]);
	});

	it("reports a device the coordinator doesn't enroll", async () => {
		pair("old-laptop");

		const { preview } = await retire("old-laptop");

		expect(preview.status).toBe(404);
		expect(await preview.json()).toEqual({ error: "device_not_enrolled" });
	});

	it("reports a device that's already retired", async () => {
		pair("old-laptop");
		enrollments = [enrollment("old-laptop")];
		await retire("old-laptop");

		const { preview } = await retire("old-laptop");

		expect(preview.status).toBe(409);
		expect(await preview.json()).toEqual({ error: "device_already_retired" });
	});
});

describe("device retirement commit safety", () => {
	beforeEach(() => {
		pair("old-laptop");
		enrollments = [enrollment("old-laptop")];
	});

	it("refuses a commit whose enrollment differs from the server's", async () => {
		const preview = await (await post("/api/sync/devices/old-laptop/retire/preview")).json();

		const res = await post("/api/sync/devices/old-laptop/retire", {
			...preview,
			enrollment_device_id: "someone-else",
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "retire_preview_stale" });
		expect(commits).toEqual([]);
		expect(pairedIds()).toEqual(["old-laptop"]);
	});

	it("refuses to commit without a confirmed preview", async () => {
		const res = await post("/api/sync/devices/old-laptop/retire", { group_id: "group-a" });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "retire_preview_required" });
		expect(commits).toEqual([]);
	});

	it("keeps the pairing when the coordinator commit fails", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
			String(input).endsWith("/v1/admin/devices/revoke")
				? Response.json({ error: "unavailable" }, { status: 503 })
				: coordinatorFetch(input, init),
		) as typeof fetch;

		const { committed } = await retire("old-laptop");

		expect(committed?.status).toBe(502);
		expect(await committed?.json()).toEqual({ error: "retire_outcome_unknown" });
		expect(pairedIds()).toEqual(["old-laptop"]);
		expect(inventoryAfterRetirement("unavailable").map((item) => item.state)).not.toContain(
			"retired",
		);
	});

	it("reports an oversized coordinator instead of a missing revocation feature", async () => {
		enrollments = Array.from({ length: 26 }, (_, i) =>
			enrollment(`device-${i}`, `pk-${i}`, `group-${i}`),
		);

		const { preview } = await retire("old-laptop");

		expect(preview.status).toBe(503);
		expect(await preview.json()).toEqual({ error: "coordinator_evidence_too_large" });
	});

	it("explains that retirement needs coordinator admin access", async () => {
		writeFileSync(join(dir, "config.json"), JSON.stringify({ sync_coordinator_url: COORDINATOR }));

		const { preview } = await retire("old-laptop");

		expect(preview.status).toBe(409);
		expect(await preview.json()).toEqual({ error: "coordinator_admin_required" });
	});
});
