import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

let dir: string;
let store: MemoryStore;
let previousConfig: string | undefined;
let previousFetch: typeof fetch;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-device-rename-test-"));
	const dbPath = join(dir, "store.sqlite");
	const db = new Database(dbPath);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(dbPath);
	const now = "2026-09-25T00:00:00.000Z";
	store.db
		.prepare(
			`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES ('device-one', 'identity-one', 'device-one', 'active', 'test',
		 '1', 'user_managed', 'rename-one', ?, ?)`,
		)
		.run(now, now);
	previousConfig = process.env.CODEMEM_CONFIG;
	previousFetch = globalThis.fetch;
	process.env.CODEMEM_CONFIG = join(dir, "config.json");
	writeFileSync(process.env.CODEMEM_CONFIG, "{}");
});

afterEach(() => {
	store.close();
	if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
	else process.env.CODEMEM_CONFIG = previousConfig;
	globalThis.fetch = previousFetch;
	rmSync(dir, { recursive: true, force: true });
});

function requestName(app: ReturnType<typeof createApp>, name: string) {
	return app.request("/api/sync/recipient-policy/v1/devices/device-one/rename", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ display_name: name }),
	});
}

function savedName(): string {
	return store.db
		.prepare("SELECT display_name FROM identity_devices WHERE device_id = 'device-one'")
		.pluck()
		.get() as string;
}

it("renames an active local Identity device and its paired-peer label without changing ownership", async () => {
	store.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES ('device-one', 'Old peer', ?)",
		)
		.run("2026-09-25T00:00:00.000Z");
	const app = createApp({ storeFactory: () => store });
	expect((await requestName(app, "123e4567-e89b-12d3-a456-426614174000")).status).toBe(400);
	expect(savedName()).toBe("device-one");
	expect((await requestName(app, "Desk laptop")).status).toBe(200);
	expect(savedName()).toBe("Desk laptop");
	expect(
		store.db
			.prepare("SELECT name FROM sync_peers WHERE peer_device_id = 'device-one'")
			.pluck()
			.get(),
	).toBe("Desk laptop");
	expect(
		store.db
			.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'device-one'")
			.pluck()
			.get(),
	).toBe("identity-one");
});

it("does not rename revoked or unknown Identity devices", async () => {
	const app = createApp({ storeFactory: () => store });
	store.db
		.prepare("UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-one'")
		.run();
	expect((await requestName(app, "Desk laptop")).status).toBe(404);
	expect(savedName()).toBe("device-one");
});

it("does not replace an enrolled name locally without coordinator evidence", async () => {
	const app = createApp({ storeFactory: () => store });
	store.db
		.prepare(
			"UPDATE identity_devices SET provenance = 'coordinator_enrollment' WHERE device_id = 'device-one'",
		)
		.run();
	const res = await requestName(app, "Desk laptop");
	expect(res.status).toBe(503);
	expect(savedName()).toBe("device-one");
});

it("renames every enrolled coordinator group and leaves the local label unchanged on a partial failure", async () => {
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_groups: ["group-a"],
			sync_coordinator_admin_secret: "test-secret",
		}),
	);
	store.db
		.prepare(
			"UPDATE identity_devices SET provenance = 'coordinator_enrollment' WHERE device_id = 'device-one'",
		)
		.run();
	let failSecond = true;
	const renamedGroups: string[] = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/v1/admin/groups")) {
			return new Response(
				JSON.stringify({ items: [{ group_id: "group-a" }, { group_id: "group-b" }] }),
				{ status: 200 },
			);
		}
		if (url.includes("/v1/admin/devices?")) {
			const groupId = new URL(url).searchParams.get("group_id") ?? "";
			return new Response(
				JSON.stringify({
					items: [
						{
							group_id: groupId,
							device_id: "device-one",
							display_name: "device-one",
							public_key: "key",
							fingerprint: "fingerprint",
							identity_id: "identity-one",
							enabled: 1,
							created_at: "2026-09-25T00:00:00.000Z",
						},
					],
				}),
				{ status: 200 },
			);
		}
		if (url.includes("/v1/admin/devices/rename")) {
			const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBufferView)) as {
				group_id: string;
			};
			if (failSecond && body.group_id === "group-b")
				return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
			renamedGroups.push(body.group_id);
			return new Response(
				JSON.stringify({
					device: { group_id: body.group_id, device_id: "device-one", display_name: "Desk laptop" },
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
	}) as typeof fetch;
	const app = createApp({ storeFactory: () => store });
	const partial = await requestName(app, "Desk laptop");
	expect(partial.status).toBe(503);
	expect(await partial.json()).toMatchObject({
		error: "coordinator_device_rename_incomplete",
		renamedGroupCount: 1,
	});
	expect(savedName()).toBe("device-one");
	failSecond = false;
	expect((await requestName(app, "Desk laptop")).status).toBe(200);
	expect(renamedGroups).toEqual(["group-a", "group-a", "group-b"]);
	expect(savedName()).toBe("Desk laptop");
});

it("serializes renames of the same device while coordinator work is pending", async () => {
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_groups: ["group-a"],
			sync_coordinator_admin_secret: "test-secret",
		}),
	);
	let releaseGroups!: (response: Response) => void;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/v1/admin/groups")) {
			return new Promise<Response>((resolve) => (releaseGroups = resolve));
		}
		if (url.includes("/v1/admin/devices?"))
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
	}) as typeof fetch;
	const app = createApp({ storeFactory: () => store });
	const first = requestName(app, "Desk laptop");
	await vi.waitFor(() => expect(releaseGroups).toEqual(expect.any(Function)));
	const concurrent = await requestName(app, "Other name");
	expect(concurrent.status).toBe(409);
	expect(await concurrent.json()).toMatchObject({ error: "device_rename_busy" });
	releaseGroups(
		new Response(JSON.stringify({ items: [{ group_id: "group-a" }] }), { status: 200 }),
	);
	expect((await first).status).toBe(200);
	expect(savedName()).toBe("Desk laptop");
});

it("refuses to rename different keys that reuse a device ID in separate groups", async () => {
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_groups: ["group-a"],
			sync_coordinator_admin_secret: "test-secret",
		}),
	);
	store.db
		.prepare(
			"UPDATE identity_devices SET provenance = 'coordinator_enrollment' WHERE device_id = 'device-one'",
		)
		.run();
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/v1/admin/groups")) {
			return new Response(
				JSON.stringify({ items: [{ group_id: "group-a" }, { group_id: "group-b" }] }),
				{ status: 200 },
			);
		}
		if (url.includes("/v1/admin/devices?")) {
			const groupId = new URL(url).searchParams.get("group_id") ?? "";
			return new Response(
				JSON.stringify({
					items: [
						{
							group_id: groupId,
							device_id: "device-one",
							public_key: groupId,
							fingerprint: groupId,
							identity_id: "identity-one",
							display_name: "Old name",
							enabled: 1,
							created_at: "2026-09-25T00:00:00.000Z",
						},
					],
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
	});
	globalThis.fetch = fetchMock as typeof fetch;
	const app = createApp({ storeFactory: () => store });
	const response = await requestName(app, "Desk laptop");
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ error: "device_enrollment_conflict" });
	expect(
		fetchMock.mock.calls.every(([input]) => !String(input).includes("/v1/admin/devices/rename")),
	).toBe(true);
	expect(savedName()).toBe("device-one");
});
