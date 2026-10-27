import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalIdentitySupersededError } from "./local-identity-generation.js";
import {
	applyLocalIdentitySwitch,
	completeLocalIdentitySwitch,
	markLocalIdentitySwitchBound,
	recordLocalIdentitySwitch,
} from "./local-identity-switch.js";
import { MemoryStore } from "./store.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
import { insertTestSession } from "./test-utils.js";

// Keep device keys out of OS key stores; config writes still need file-metadata tools.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: vi.fn((command: string, ...rest: unknown[]) => {
			if (command === "security" || command === "secret-tool")
				throw new Error("external key stores forbidden");
			return Reflect.apply(actual.execFileSync, actual, [command, ...rest]);
		}),
	};
});

const OLD = "identity-old";
const TARGET = "identity-target";
const saved = { ...process.env };
const stores: MemoryStore[] = [];
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-identity-guard-"));
	process.env.CODEMEM_CONFIG = join(dir, "config.json");
	delete process.env.CODEMEM_ACTOR_ID;
	delete process.env.CODEMEM_DEVICE_ID;
	writeFileSync(
		process.env.CODEMEM_CONFIG,
		JSON.stringify({ actor_id: OLD, actor_display_name: "Old" }),
	);
});
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	process.env = { ...saved };
	rmSync(dir, { recursive: true, force: true });
});

function open(): MemoryStore {
	const store = new MemoryStore(join(dir, "local.sqlite"), { keysDir: join(dir, "keys") });
	stores.push(store);
	return store;
}

/** A store opened as OLD, with its device and local actor in place. */
function openBeforeSwitch(): MemoryStore {
	const first = open();
	const [deviceId] = ensureDeviceIdentity(first.db, { keysDir: join(dir, "keys") });
	first.db
		.prepare(
			"INSERT INTO actors (actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, 'Old', 1, 'active', 'now', 'now')",
		)
		.run(OLD);
	first.close();
	stores.splice(stores.indexOf(first), 1);
	const store = open();
	expect(store.deviceId).toBe(deviceId);
	expect(store.actorId).toBe(OLD);
	return store;
}

function write(store: MemoryStore) {
	return store.rememberForUser(insertTestSession(store.db), "discovery", "t", "body");
}

/** Records, binds and applies the switch; config is completed separately. */
function switchDatabase(store: MemoryStore) {
	const pending = {
		attemptId: "rebind-a",
		coordinatorOrigin: "https://coordinator.example.test",
		groupId: "group-a",
		deviceId: store.deviceId,
		previousIdentityId: OLD,
		targetIdentityId: TARGET,
		reviewDigest: "e".repeat(64),
		expiresAtMs: 1,
	};
	const context = { configPath: process.env.CODEMEM_CONFIG, env: {} };
	recordLocalIdentitySwitch(store.db, pending, context);
	markLocalIdentitySwitchBound(store.db, {
		attemptId: "rebind-a",
		bindingId: "binding-a",
		deviceId: store.deviceId,
		previousIdentityId: OLD,
		targetIdentityId: TARGET,
		enrollmentCount: 1,
		finalizedAtMs: 1,
	});
	applyLocalIdentitySwitch(
		store.db,
		{
			attemptId: "rebind-a",
			displayName: "Target",
			expectedPublicKey: loadPublicKey(join(dir, "keys")) ?? "",
		},
		context,
	);
}

const memoryCount = (store: MemoryStore) =>
	store.db.prepare("SELECT count(*) FROM memory_items").pluck().get();

describe("writer guard after a local Identity switch", () => {
	it("stops a process opened before the switch from writing under the old Identity", () => {
		// Arrange
		const stale = openBeforeSwitch();
		write(stale);
		const before = memoryCount(stale);
		// Act
		switchDatabase(stale);
		// Assert
		expect(() => write(stale)).toThrow(LocalIdentitySupersededError);
		expect(memoryCount(stale)).toBe(before);
	});

	it("refuses until config follows, then writes under the new Identity", () => {
		// Arrange
		const stale = openBeforeSwitch();
		switchDatabase(stale);
		// Act: a restart before config completes still reads the old Identity.
		const restarted = open();
		const refused = () => write(restarted);
		completeLocalIdentitySwitch(stale.db, {
			attemptId: "rebind-a",
			configPath: process.env.CODEMEM_CONFIG,
		});
		const current = open();
		const id = write(current);
		// Assert
		expect(refused).toThrow(LocalIdentitySupersededError);
		expect(current.actorId).toBe(TARGET);
		expect(
			current.db.prepare("SELECT actor_id FROM memory_items WHERE id = ?").pluck().get(id),
		).toBe(TARGET);
	});
});
