import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BetterSqliteCoordinatorStore } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCoordinatorCommand } from "./coordinator.js";

const groupId = "fixture-team";
const deviceId = "fixture-device";
const publicKey =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea";
const exitCode = process.exitCode;
let directory: string;
let store: BetterSqliteCoordinatorStore;
let path: string;

beforeEach(async () => {
	process.exitCode = undefined;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
	directory = mkdtempSync(join(tmpdir(), "codemem-cli-enable-"));
	path = join(directory, "coordinator.sqlite");
	store = new BetterSqliteCoordinatorStore(path);
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, { deviceId, publicKey, fingerprint: "fixture" });
	await store.setDeviceEnabled(groupId, deviceId, false);
});

afterEach(async () => {
	try {
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		await store.close();
		rmSync(directory, { recursive: true, force: true });
		process.exitCode = exitCode;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

async function enable(id = deviceId) {
	await buildCoordinatorCommand().parseAsync(
		["device", "enable", groupId, id, "--db-path", path, "--json"],
		{ from: "user" },
	);
	return JSON.parse(String(vi.mocked(console.log).mock.lastCall?.[0]));
}

it("enables an existing disabled enrollment", async () => {
	expect(await store.getEnrollment(groupId, deviceId)).toBeNull();
	expect(await enable()).toEqual({ ok: true, group_id: groupId, device_id: deviceId });
	expect(await store.getEnrollment(groupId, deviceId)).toMatchObject({ enabled: 1 });
	expect(process.exitCode).toBeUndefined();
});

it("reports a removed device and leaves its tombstone in place", async () => {
	expect(await store.removeDevice(groupId, deviceId)).toBe(true);
	const before = await store.listDeviceRemovals();
	expect(await enable()).toMatchObject({ error: "device_removed" });
	expect(await store.getEnrollment(groupId, deviceId, true)).toBeNull();
	expect(await store.listDeviceRemovals()).toEqual(before);
	expect(process.exitCode).toBe(1);
});

it("reports a blocked device and leaves it disabled", async () => {
	const evidence = { groupId, deviceId, publicKey, fingerprint: "fixture", actorId: "operator" };
	expect(await store.createDeviceRevocation(evidence)).toMatchObject({ kind: "revoked" });
	const before = await store.listDeviceRevocations({ deviceId });
	// The store reports a blocked, still-enrolled device as `false`, like an unknown one.
	expect(await enable()).toMatchObject({ error: "device_not_enabled" });
	expect(await store.getEnrollment(groupId, deviceId, true)).toMatchObject({ enabled: 0 });
	expect(await store.listDeviceRevocations({ deviceId })).toEqual(before);
	expect(process.exitCode).toBe(1);
});

it("reports an unknown device without naming a removal", async () => {
	expect(await enable("missing")).toMatchObject({ error: "device_not_enabled" });
	expect(process.exitCode).toBe(1);
});
