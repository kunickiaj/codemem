import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
	readCoordinatorSyncConfig,
	serializeRecipientPolicyPublicationMutation,
	syncOnce,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createSyncApp } from "./index.js";

const BINDINGS = "/api/sync/recipient-policy/v1/device-bindings";
const LEGACY = "/api/sync/peers/identity";
const NOW = "2026-11-27T12:00:00.000Z";
const ADMIN = {
	sync_coordinator_url: "http://127.0.0.1:9",
	sync_coordinator_groups: ["group-a"],
	sync_coordinator_admin_secret: "fixture-secret",
};
const MEMBER = { ...ADMIN, sync_coordinator_admin_secret: "" };

let directory: string;
let configPath: string;
const cleanups: (() => void | Promise<void>)[] = [];

/** Writes the config file the routes read, so authority comes from the real reader. */
function configure(value: Record<string, unknown>) {
	writeFileSync(configPath, JSON.stringify(value));
}

/** A store whose device identity exists before it opens, as on an installed device. */
function realStore(name: string) {
	const dbPath = join(directory, `${name}.sqlite`);
	const keysDir = join(directory, `${name}-keys`);
	const db = connect(dbPath);
	initTestSchema(db);
	const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
	db.close();
	const store = new MemoryStore(dbPath);
	cleanups.push(() => store.close());
	return { store, keysDir, deviceId, fingerprint, publicKey: loadPublicKey(keysDir) };
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "device-binding-access-"));
	configPath = join(directory, "config.json");
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	for (const name of ["URL", "GROUP", "GROUPS", "ADMIN_SECRET"]) {
		vi.stubEnv(`CODEMEM_SYNC_COORDINATOR_${name}`, undefined);
	}
	configure(ADMIN);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

/** A device with one pairing, its own person, and the Viewer's routes. */
function bindingFixture() {
	const { store, keysDir } = realStore("local");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	store.db
		.prepare(`INSERT OR IGNORE INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		VALUES (?, 'Local Identity', 1, 'active', ?, ?)`)
		.run(store.actorId, NOW, NOW);
	store.db
		.prepare(`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
		VALUES ('peer-a', 'peer-key', ?, ?)`)
		.run(fingerprintPublicKey("peer-key"), NOW);
	let beforeInventory = async () => {};
	const app = createApp({
		storeFactory: () => store,
		loadDeviceIdentityCoordinatorEvidence: async () => {
			await beforeInventory();
			return { availability: "available", safeErrorCode: null, enrollments: [] };
		},
	});
	return {
		store,
		app,
		setBeforeInventory: (hook: () => Promise<void>) => {
			beforeInventory = hook;
		},
	};
}

type Fixture = ReturnType<typeof bindingFixture>;

/** Everything a binding or a person assignment can change. */
function accessState(store: MemoryStore) {
	return [
		"actors",
		"sync_peers",
		"identity_devices",
		"scope_memberships",
		"project_recipients",
		"device_identity_binding_commits",
	].map((table) => store.db.prepare(`SELECT * FROM ${table}`).all());
}

function post(f: Fixture, path: string, body: unknown) {
	return f.app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** A reviewed request that would bind the paired device to this device's person. */
async function requestBody(f: Fixture, path: string) {
	if (path === LEGACY) return { peer_device_id: "peer-a", claimed_local_actor: true };
	const bindings = [{ deviceId: "peer-a", targetIdentityId: f.store.actorId, confirmed: true }];
	const preview = await post(f, `${BINDINGS}/preview`, { bindings });
	expect(preview.status).toBe(200);
	const { reviewedInventoryDigest } = (await preview.json()) as {
		reviewedInventoryDigest: string;
	};
	return { bindings, reviewedInventoryDigest };
}

async function expectRefused(f: Fixture, response: Response, before: unknown) {
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ error: "access_change_needs_admin_device" });
	expect(accessState(f.store)).toEqual(before);
}

describe.each([`${BINDINGS}/commit`, LEGACY])("assigning a device to a person at %s", (path) => {
	it.each([
		["a device without the admin secret", MEMBER],
		["a device with no coordinator", {}],
	])("refuses %s and changes nothing", async (_label, config) => {
		const f = bindingFixture();
		const body = await requestBody(f, path);
		configure(config);
		const before = accessState(f.store);

		await expectRefused(f, await post(f, path, body), before);
	});

	it("allows the admin device", async () => {
		const f = bindingFixture();
		const body = await requestBody(f, path);

		const response = await post(f, path, body);

		expect(response.status).toBe(200);
		expect(f.store.sameActorPeerIds()).toEqual(["peer-a"]);
	});

	it("checks authority again inside the write", async () => {
		const f = bindingFixture();
		const body = await requestBody(f, path);
		const before = accessState(f.store);
		// The entry check sees the admin secret; the write transaction does not.
		const app = createApp({
			storeFactory: () => f.store,
			readCoordinatorConfig: () =>
				readCoordinatorSyncConfig(f.store.db.inTransaction ? MEMBER : ADMIN),
			loadDeviceIdentityCoordinatorEvidence: async () => ({
				availability: "available",
				safeErrorCode: null,
				enrollments: [],
			}),
		});

		await expectRefused(f, await post({ ...f, app }, path, body), before);
	});
});

it("refuses a binding commit before reading coordinator devices", async () => {
	const f = bindingFixture();
	const body = await requestBody(f, `${BINDINGS}/commit`);
	configure({});
	let inventoryReads = 0;
	f.setBeforeInventory(async () => {
		inventoryReads += 1;
	});

	expect((await post(f, `${BINDINGS}/commit`, body)).status).toBe(403);
	expect(inventoryReads).toBe(0);
});

it("refuses the older route before creating this device's person", async () => {
	const f = bindingFixture();
	f.store.db.prepare("DELETE FROM actors").run();
	configure({});
	const before = accessState(f.store);

	await expectRefused(
		f,
		await post(f, LEGACY, { peer_device_id: "peer-a", claimed_local_actor: true }),
		before,
	);
});

it("refuses a binding commit when the admin secret is removed while it waits for publication", async () => {
	const f = bindingFixture();
	const body = await requestBody(f, `${BINDINGS}/commit`);
	const before = accessState(f.store);
	let release = () => {};
	let entered = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const publication = serializeRecipientPolicyPublicationMutation(f.store.db, async () => {
		entered();
		await held;
	});
	await started;
	// The request passes the entry check, then waits behind the publication.
	const pending = post(f, `${BINDINGS}/commit`, body);
	await new Promise((resolve) => setTimeout(resolve, 10));
	configure(MEMBER);
	release();
	await publication;

	await expectRefused(f, await pending, before);
});

it("refuses a binding commit when the admin secret is removed during the inventory read", async () => {
	const f = bindingFixture();
	const body = await requestBody(f, `${BINDINGS}/commit`);
	const before = accessState(f.store);
	f.setBeforeInventory(async () => configure(MEMBER));

	await expectRefused(f, await post(f, `${BINDINGS}/commit`, body), before);
});

describe.each([
	["adding a person", "/api/sync/actors", { display_name: "Teammate" }],
	[
		"renaming a person",
		"/api/sync/actors/rename",
		{ actor_id: "person-b", display_name: "Renamed" },
	],
])("%s", (_label, path, body) => {
	function peopleFixture() {
		const f = bindingFixture();
		f.store.db
			.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			VALUES ('person-b', 'Person B', 0, 'active', ?, ?)`)
			.run(NOW, NOW);
		return f;
	}

	it.each([
		["a device without the admin secret", MEMBER],
		["a device with no coordinator", {}],
	])("refuses %s and changes nothing", async (_device, config) => {
		const f = peopleFixture();
		configure(config);
		const before = accessState(f.store);

		await expectRefused(f, await post(f, path, body), before);
	});

	it("allows the admin device", async () => {
		const f = peopleFixture();

		const response = await post(f, path, body);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ display_name: body.display_name });
	});

	it("refuses before creating this device's person", async () => {
		const f = peopleFixture();
		f.store.db.prepare("DELETE FROM actors WHERE is_local = 1").run();
		configure({});
		const before = accessState(f.store);

		await expectRefused(f, await post(f, path, body), before);
	});

	it("checks authority again inside the write", async () => {
		const f = peopleFixture();
		const before = accessState(f.store);
		const app = createApp({
			storeFactory: () => f.store,
			readCoordinatorConfig: () =>
				readCoordinatorSyncConfig(f.store.db.inTransaction ? MEMBER : ADMIN),
		});

		await expectRefused(f, await post({ ...f, app }, path, body), before);
	});
});

describe("pairing and sync on a device with no coordinator", () => {
	it("completes a sync pass with a paired device that cannot be assigned to a person", async () => {
		configure({});
		const source = realStore("source");
		const receiver = realStore("receiver");
		// What `codemem sync pair --accept` stores on each side.
		const pair = (device: typeof source, peer: typeof source) =>
			device.store.db
				.prepare(`INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, public_key,
				 created_at) VALUES (?, 'Paired device', ?, ?, ?)`)
				.run(peer.deviceId, peer.fingerprint, peer.publicKey, NOW);
		pair(source, receiver);
		pair(receiver, source);
		const sourceId = source.deviceId;

		const receiverApp = createApp({ storeFactory: () => receiver.store });
		const assign = await receiverApp.request(LEGACY, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ peer_device_id: sourceId, claimed_local_actor: true }),
		});
		expect(assign.status).toBe(403);
		const addPerson = await receiverApp.request("/api/sync/actors", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ display_name: "Teammate" }),
		});
		expect(addPerson.status).toBe(403);

		vi.stubEnv("CODEMEM_KEYS_DIR", source.keysDir);
		const sourceApp = createSyncApp({ storeFactory: () => source.store });
		const url = await new Promise<string>((resolve) => {
			const server = serve({ fetch: sourceApp.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
				resolve(`http://127.0.0.1:${info.port}`),
			);
			cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
		});
		const result = await syncOnce(receiver.store.db, sourceId, [url], {
			keysDir: receiver.keysDir,
			scanner: receiver.store.scanner,
		});

		// The signed pull and push both completed with neither device assigned to a person.
		expect(result).toMatchObject({ ok: true, address: url });
		expect(
			receiver.store.db
				.prepare("SELECT last_sync_at IS NOT NULL AS synced, last_error FROM sync_peers")
				.get(),
		).toEqual({ synced: 1, last_error: null });
		expect(receiver.store.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(
			0,
		);
		expect(receiver.store.sameActorPeerIds()).toEqual([]);
	});
});
