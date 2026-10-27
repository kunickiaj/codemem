import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DeviceRebindPending,
	ensureDeviceIdentity,
	MemoryStore,
	markLocalIdentitySwitchBound,
	readOpenLocalIdentitySwitch,
	recordLocalIdentitySwitch,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext } from "./context.js";
import { createAccountRebindRunner, resumeAccountRebind } from "./rebind.js";

const core = vi.hoisted(() => ({ run: vi.fn(), resume: vi.fn() }));
vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	return {
		...actual,
		runDeviceRebind: (...args: unknown[]) => core.run(...args),
		resumeDeviceRebind: (...args: unknown[]) => core.resume(...args),
	};
});

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
let dir: string;
let store: MemoryStore | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-viewer-rebind-"));
	process.env.CODEMEM_CONFIG = join(dir, "config.json");
	delete process.env.CODEMEM_ACTOR_ID;
	delete process.env.CODEMEM_DEVICE_ID;
	writeFileSync(
		process.env.CODEMEM_CONFIG,
		JSON.stringify({ actor_id: OLD, actor_display_name: "Same Person" }),
	);
});
afterEach(() => {
	store?.close();
	process.env = { ...saved };
	rmSync(dir, { recursive: true, force: true });
});

/** A store running as OLD, with its device and local actor in place. */
function storeAsOld() {
	const keysDir = join(dir, "keys");
	const first = new MemoryStore(join(dir, "local.sqlite"), { keysDir });
	const [deviceId] = ensureDeviceIdentity(first.db, { keysDir });
	first.db
		.prepare(
			"INSERT INTO actors (actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, 'Same Person', 1, 'active', 'now', 'now')",
		)
		.run(OLD);
	first.close();
	store = new MemoryStore(join(dir, "local.sqlite"), { keysDir });
	const configPath = process.env.CODEMEM_CONFIG as string;
	return { store, deviceId, keysDir, configPath };
}

const pendingFor = (deviceId: string, attemptId = "rebind-a"): DeviceRebindPending => ({
	attemptId,
	coordinatorOrigin: "https://coordinator.example.test",
	groupId: "group-a",
	deviceId,
	previousIdentityId: OLD,
	targetIdentityId: TARGET,
	reviewDigest: "e".repeat(64),
	expiresAtMs: 1,
});

/** A store running as OLD whose coordinator already committed the rebind. */
function boundSwitch() {
	const { store, deviceId, keysDir, configPath } = storeAsOld();
	recordLocalIdentitySwitch(store.db, pendingFor(deviceId), { configPath, env: {} });
	markLocalIdentitySwitchBound(store.db, {
		attemptId: "rebind-a",
		bindingId: "binding-a",
		deviceId,
		previousIdentityId: OLD,
		targetIdentityId: TARGET,
		enrollmentCount: 1,
		finalizedAtMs: 1,
	});
	return { store, keysDir, configPath };
}

describe("resuming a device sign-in", () => {
	it("finishes a switch the coordinator already committed", async () => {
		// Arrange
		const { store, keysDir, configPath } = boundSwitch();
		// Act
		const result = await resumeAccountRebind(store, { keysDir, configPath });
		// Assert: no coordinator call is needed, and this process now runs as the target.
		expect(result).toEqual({ kind: "switched", targetIdentityId: TARGET });
		expect(store.actorId).toBe(TARGET);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
			actor_id: TARGET,
			actor_display_name: "Same Person",
		});
		expect(await resumeAccountRebind(store, { keysDir, configPath })).toBeNull();
	});
});

function contextFor(store: MemoryStore, keysDir: string, configPath: string): AccountContext {
	return {
		contextId: "context-a",
		groupId: "group-a",
		coordinatorUrl: "https://coordinator.example.test",
		dbPath: store.dbPath,
		keysDir,
		configPath,
		deviceId: store.deviceId,
		fingerprint: "f".repeat(64),
		identityId: OLD,
		fileIdentity: { dev: "1", ino: "2" },
	};
}

describe("signing in again after an attempt did not finish", () => {
	beforeEach(() => {
		core.run.mockReset();
		core.resume.mockReset();
	});

	it("closes its own record after a refusal, so the next sign-in can start", async () => {
		// Arrange: the coordinator refuses finalize after the record was written.
		const { store, deviceId, keysDir, configPath } = storeAsOld();
		const runner = createAccountRebindRunner(store);
		const input = {
			context: contextFor(store, keysDir, configPath),
			signal: new AbortController().signal,
			onBrowserStart: () => {},
		};
		core.run.mockImplementation(
			async (options: { reviewDigest: string; recordPending(p: DeviceRebindPending): void }) => {
				options.recordPending({
					...pendingFor(deviceId, `rebind-${core.run.mock.calls.length}`),
					reviewDigest: options.reviewDigest,
				});
				return { kind: "refused", reason: "daily_limit" };
			},
		);
		// Act
		const first = await runner(input);
		const second = await runner(input);
		// Assert
		expect(first).toEqual({ kind: "refused", reason: "daily_limit" });
		expect(second).toEqual({ kind: "refused", reason: "daily_limit" });
		expect(core.run).toHaveBeenCalledTimes(2);
		expect(readOpenLocalIdentitySwitch(store.db)).toBeNull();
	});

	it("records nothing when the reviewed local facts changed during sign-in", async () => {
		// Arrange: another route binds this device while Google sign-in is open.
		const { store, deviceId, keysDir, configPath } = storeAsOld();
		core.run.mockImplementation(
			async (options: { reviewDigest: string; recordPending(p: DeviceRebindPending): void }) => {
				store.db
					.prepare(
						`INSERT INTO identity_devices (device_id, identity_id, display_name, status, provenance,
						 revision, migration_state, idempotency_key, created_at, updated_at)
						 VALUES (?, 'identity-peer', 'Laptop', 'active', 'p', 'r', 'm', 'k', 'now', 'now')`,
					)
					.run(deviceId);
				try {
					options.recordPending({ ...pendingFor(deviceId), reviewDigest: options.reviewDigest });
				} catch {
					return { kind: "failed", error: "request_failed" };
				}
				return { kind: "unknown", pending: pendingFor(deviceId) };
			},
		);
		// Act
		const result = await createAccountRebindRunner(store)({
			context: contextFor(store, keysDir, configPath),
			signal: new AbortController().signal,
			onBrowserStart: () => {},
		});
		// Assert
		expect(result).toEqual({ kind: "failed" });
		expect(readOpenLocalIdentitySwitch(store.db)).toBeNull();
	});

	it("records nothing when the account context changed during sign-in", async () => {
		// Arrange
		const { store, deviceId, keysDir, configPath } = storeAsOld();
		core.run.mockImplementation(
			async (options: { reviewDigest: string; recordPending(p: DeviceRebindPending): void }) => {
				try {
					options.recordPending({ ...pendingFor(deviceId), reviewDigest: options.reviewDigest });
				} catch {
					return { kind: "failed", error: "request_failed" };
				}
				return { kind: "unknown", pending: pendingFor(deviceId) };
			},
		);
		// Act
		const result = await createAccountRebindRunner(store)({
			context: contextFor(store, keysDir, configPath),
			signal: new AbortController().signal,
			onBrowserStart: () => {},
			isCurrent: () => false,
		});
		// Assert
		expect(result).toEqual({ kind: "failed" });
		expect(readOpenLocalIdentitySwitch(store.db)).toBeNull();
	});

	it("reports a pending switch without a new Google trip while an earlier one is unresolved", async () => {
		// Arrange
		const { store, deviceId, keysDir, configPath } = storeAsOld();
		recordLocalIdentitySwitch(store.db, pendingFor(deviceId), { configPath, env: {} });
		core.resume.mockResolvedValue({ kind: "unknown" });
		// Act
		const result = await createAccountRebindRunner(store)({
			context: contextFor(store, keysDir, configPath),
			signal: new AbortController().signal,
			onBrowserStart: () => {},
		});
		// Assert
		expect(result).toEqual({ kind: "pending" });
		expect(core.run).not.toHaveBeenCalled();
	});
});
