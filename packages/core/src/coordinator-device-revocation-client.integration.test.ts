import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { coordinatorRevokeDeviceAction as revoke } from "./coordinator-device-revocation-client.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";

// In-process mounted SQLite API, real admin authentication/digest/atomic stores; no sockets.
const secret = "fixture-integration-secret";
const request = {
	remoteUrl: "https://coordinator.example.test",
	adminSecret: secret,
	groupId: "group-a",
	deviceId: "device-a",
};
const otherWire = wireBytes();
otherWire[otherWire.length - 1] ^= 1;
const otherKey = publicKeyFromWire(otherWire);
let directory: string, dbPath: string;
let mounted: ReturnType<typeof createBetterSqliteCoordinatorApp>;
function inspect() {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		return {
			groups: db.prepare("SELECT * FROM groups ORDER BY group_id").all(),
			enrollments: db.prepare("SELECT * FROM enrolled_devices ORDER BY group_id, device_id").all(),
			revocations: db
				.prepare(
					"SELECT subject_kind, subject_value, revocation_id, created_at FROM coordinator_device_revocations ORDER BY subject_kind",
				)
				.all(),
		};
	} finally {
		db.close();
	}
}
async function transport(input: string | URL | Request, init?: RequestInit) {
	return mounted.fetch(new Request(input, init));
}
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "codemem-revocation-client-api-"));
	dbPath = join(directory, "coordinator.sqlite");
	const store = new BetterSqliteCoordinatorStore(dbPath);
	try {
		for (const groupId of ["group-a", "group-b"]) await store.createGroup(groupId);
		for (const [groupId, deviceId, publicKey] of [
			["group-a", "device-a", CANONICAL_PUBLIC_KEY],
			["group-b", "device-a", otherKey],
			["group-b", "alias-device", CANONICAL_PUBLIC_KEY],
			["group-b", "distinct-device", otherKey],
		])
			await store.enrollDevice(groupId, { deviceId, publicKey, fingerprint: "a".repeat(64) });
	} finally {
		await store.close();
	}
	mounted = createBetterSqliteCoordinatorApp({
		dbPath,
		deviceRevocation: { coordinatorId: "coordinator-a" },
		runtime: { adminSecret: () => secret, now: () => "2026-10-20T00:00:00Z" },
	});
	vi.stubGlobal("fetch", vi.fn(transport));
});
afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

it("previews read-only, commits exactly both global subjects, and retains references on explicit replay", async () => {
	// Arrange: seed connection is closed; mounted requests must open the existing database only.
	const before = inspect(),
		bytes = readFileSync(dbPath);
	// Act
	const preview = await revoke(request);
	const afterPreview = inspect(),
		previewBytes = readFileSync(dbPath);
	if (preview.state !== "ready") throw new Error("Expected preview");
	const commit = {
		...request,
		expectedDigest: preview.expected_digest,
		expectedContext: { coordinatorId: preview.coordinator_id, keyId: preview.key_id },
	};
	const receipt = await revoke(commit),
		first = inspect();
	const replay = await revoke(commit);
	// Assert
	expect(preview).toMatchObject({
		state: "ready",
		coordinator_id: "coordinator-a",
		group_id: "group-a",
		device_id: "device-a",
		key_id: EXPECTED_KEY_ID,
	});
	expect(afterPreview).toEqual(before);
	expect(previewBytes).toEqual(bytes);
	if (receipt.state !== "revoked") throw new Error("Expected commit");
	expect(
		receipt.revocations.map(({ subject_kind, subject_value }) => [subject_kind, subject_value]),
	).toEqual([
		["device_id", "device-a"],
		["ed25519_key", EXPECTED_KEY_ID],
	]);
	expect(first).toEqual({ ...before, revocations: receipt.revocations });
	expect(replay).toEqual(receipt);
	expect(inspect()).toEqual(first);
	expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
		`${request.remoteUrl}/v1/admin/devices/revoke-preview`,
		`${request.remoteUrl}/v1/admin/devices/revoke`,
		`${request.remoteUrl}/v1/admin/devices/revoke`,
	]);
});

it("reports a lost actual commit reply as unknown while retaining both subjects for explicit replay", async () => {
	// Arrange
	const before = inspect(),
		preview = await revoke(request);
	if (preview.state !== "ready") throw new Error("Expected preview");
	const commit = { ...request, expectedDigest: preview.expected_digest };
	vi.mocked(fetch).mockImplementationOnce(async (input, init) => {
		const response = await transport(input, init);
		expect(response.status).toBe(200);
		await response.arrayBuffer();
		throw new Error(`${secret}: lost reply`, { cause: new Error("private transport cause") });
	});
	// Act
	const error = await revoke(commit).catch((error: Error) => error);
	const afterLostReply = inspect();
	const receipt = await revoke(commit);
	// Assert
	expect(error).toEqual(new Error("revocation_outcome_unknown"));
	expect(error).not.toHaveProperty("cause");
	expect(String(error)).not.toContain(secret);
	expect(afterLostReply.revocations).toHaveLength(2);
	if (receipt.state !== "revoked") throw new Error("Expected replay receipt");
	expect(afterLostReply).toEqual({ ...before, revocations: receipt.revocations });
	expect(inspect()).toEqual(afterLostReply);
	expect(fetch).toHaveBeenCalledTimes(3);
});

it("rejects real enrollment key drift after preview with 409 stale and no tombstones", async () => {
	// Arrange
	const preview = await revoke(request);
	if (preview.state !== "ready") throw new Error("Expected preview");
	const store = new BetterSqliteCoordinatorStore(dbPath, { existingOnly: true });
	try {
		await store.enrollDevice("group-a", {
			deviceId: "device-a",
			publicKey: otherKey,
			fingerprint: "b".repeat(64),
		});
	} finally {
		await store.close();
	}
	const before = inspect();
	// Act
	const result = revoke({ ...request, expectedDigest: preview.expected_digest });
	// Assert
	await expect(result).rejects.toMatchObject({ status: 409, code: "revocation_preview_stale" });
	expect(inspect()).toEqual(before);
	expect(before.revocations).toEqual([]);
	expect(fetch).toHaveBeenCalledTimes(2);
});
