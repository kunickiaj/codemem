import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readCoordinatorOwnerReviewLocalEvidence as read } from "./coordinator-owner-review-local.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const publicKey = "ssh-ed25519 fixture-public-key";
const fingerprint = fingerprintPublicKey(publicKey);
let directory: string;
let dbPath: string;
function write(sql: string) {
	const db = new Database(dbPath);
	try {
		db.exec(sql);
	} finally {
		db.close();
	}
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "owner-review-test-"));
	dbPath = join(directory, "device.sqlite");
	const db = new Database(dbPath);
	db.exec(`CREATE TABLE sync_device(device_id TEXT, public_key TEXT, fingerprint TEXT);
	CREATE TABLE actors(actor_id TEXT, is_local INTEGER, status TEXT, merged_into_actor_id TEXT, display_name TEXT);
	CREATE TABLE identity_devices(device_id TEXT, identity_id TEXT, status TEXT, display_name TEXT);
	CREATE TABLE memory_items(actor_id TEXT, origin_device_id TEXT);
	CREATE TABLE policy_team_memberships(identity_id TEXT, status TEXT);
	CREATE TABLE project_recipients(recipient_kind TEXT, recipient_id TEXT, status TEXT);
	INSERT INTO actors VALUES ('actor-a', 1, 'active', NULL, 'Local owner');
	INSERT INTO identity_devices VALUES ('device-a', 'actor-a', 'active', 'This device'), ('peer', 'legacy-other', 'revoked', 'Peer');
	INSERT INTO memory_items VALUES ('actor-a', 'peer'), ('other', 'device-a'), (NULL, 'device-a'), ('  ', 'device-a');
	INSERT INTO policy_team_memberships VALUES ('actor-a', 'active'), ('actor-a', 'revoked'), ('other', 'active');
	INSERT INTO project_recipients VALUES ('identity', 'actor-a', 'active'), ('identity', 'actor-a', 'revoked'), ('team', 'actor-a', 'active');`);
	db.prepare("INSERT INTO sync_device VALUES (?, ?, ?)").run("device-a", publicKey, fingerprint);
	db.close();
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});
it("reads only this device and authorship, leaving bytes, schema, and peer assignments unchanged", () => {
	// Arrange
	const bytes = readFileSync(dbPath);
	const files = readdirSync(directory);
	// Act
	const evidence = read({ dbPath, actorId: "actor-a", identitySource: "env" });
	// Assert
	expect(evidence).toEqual({
		state: "ready",
		reasons: [],
		device: { deviceId: "device-a", publicKey, fingerprint, label: "This device" },
		identity: { identityId: "actor-a", label: "Local owner", source: "env" },
		memoryCounts: { current: 1, others: 1, unknown: 2 },
		teamCount: 1,
		projectCount: 1,
	});
	expect(readFileSync(dbPath)).toEqual(bytes);
	expect(readdirSync(directory)).toEqual(files);
});
it.each([
	[
		"UPDATE identity_devices SET identity_id = 'other' WHERE device_id = 'device-a'",
		"device_identity_conflict",
	],
	[
		"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-a'",
		"device_identity_conflict",
	],
	[
		"INSERT INTO actors VALUES ('other-local', 1, 'active', NULL, 'Other')",
		"local_actor_ambiguous",
	],
	["UPDATE actors SET is_local = 0", "current_actor_unavailable"],
	["UPDATE actors SET status = 'disabled'", "current_actor_unavailable"],
	["UPDATE actors SET merged_into_actor_id = 'other'", "current_actor_unavailable"],
	["UPDATE sync_device SET fingerprint = 'invalid'", "device_unavailable"],
	["INSERT INTO sync_device SELECT * FROM sync_device", "device_unavailable"],
])("stops for %s without repairing local state", (sql, reason) => {
	// Arrange
	write(sql);
	const bytes = readFileSync(dbPath);
	// Act
	const evidence = read({ dbPath, actorId: "actor-a" });
	// Assert
	expect(evidence.state).toBe("needs_review");
	expect(evidence.reasons).toContain(reason);
	expect(readFileSync(dbPath)).toEqual(bytes);
});

it.each([" device-a ", "different-device"])(
	"checks device override %s without writing local state",
	(deviceIdOverride) => {
		// Arrange
		const bytes = readFileSync(dbPath);
		// Act
		const evidence = read({ dbPath, actorId: "actor-a", deviceIdOverride });
		// Assert
		expect(evidence.state).toBe(deviceIdOverride.trim() === "device-a" ? "ready" : "needs_review");
		expect(evidence.reasons).toEqual(
			deviceIdOverride.trim() === "device-a" ? [] : ["device_override_mismatch"],
		);
		expect(evidence.device?.deviceId).toBe("device-a");
		expect(readFileSync(dbPath)).toEqual(bytes);
	},
);

it("allows absent current actor and absent assignment only when no other local actor is active", () => {
	// Arrange
	write("DELETE FROM actors; DELETE FROM identity_devices WHERE device_id = 'device-a'");
	// Act
	const fallback = read({ dbPath });
	write("INSERT INTO actors VALUES ('other', 1, 'active', NULL, 'Other')");
	const ambiguous = read({ dbPath });
	// Assert
	expect(fallback.state).toBe("ready");
	expect(fallback.identity).toMatchObject({
		identityId: "local:device-a",
		source: "device_fallback",
	});
	expect(ambiguous.state).toBe("needs_review");
	expect(ambiguous.reasons).toContain("local_actor_ambiguous");
});

it("reports missing evidence tables as unknown rather than zero and never creates them", () => {
	// Arrange
	write(
		"DROP TABLE memory_items; DROP TABLE policy_team_memberships; DROP TABLE project_recipients; DROP TABLE actors; DROP TABLE identity_devices",
	);
	const bytes = readFileSync(dbPath);
	// Act
	const evidence = read({ dbPath, actorId: "actor-a" });
	// Assert
	expect(evidence).toMatchObject({
		state: "needs_review",
		memoryCounts: { current: null, others: null, unknown: null },
		teamCount: null,
		projectCount: null,
		reasons: ["actor_evidence_unavailable", "device_assignment_unavailable"],
	});
	expect(readFileSync(dbPath)).toEqual(bytes);
});

it("refuses a missing file or in-memory default without creating a database", () => {
	// Arrange
	const files = readdirSync(directory);
	// Act / Assert
	expect(() => read({ dbPath: join(directory, "missing.sqlite") })).toThrow();
	expect(() => read({ dbPath: ":memory:" })).toThrow("owner_review_local_unavailable");
	expect(readdirSync(directory)).toEqual(files);
});
