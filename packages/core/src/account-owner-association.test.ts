import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AccountOwnerProfile,
	readAccountOwnerAssociation,
	retainAccountOwnerAssociation,
} from "./account-owner-association.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";

const review = {
	ownerIdentityId: "owner-a",
	attestationId: `controller-v1:${"a".repeat(64)}`,
	reviewDigest: "b".repeat(64),
};
let directory: string;
let profile: AccountOwnerProfile;

function associationPath(p = profile): string {
	const scope = createHash("sha256")
		.update(JSON.stringify([new URL(p.coordinatorUrl).origin, p.coordinatorId, p.groupId]))
		.digest("hex")
		.slice(0, 32);
	return `${p.dbPath}.account-owner-${scope}.json`;
}
function snapshot(path: string) {
	const stat = lstatSync(path, { bigint: true });
	return { bytes: readFileSync(path), ino: stat.ino, dev: stat.dev, mtime: stat.mtimeNs };
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "account-owner-association-"));
	profile = {
		dbPath: join(directory, "profile.sqlite"),
		deviceId: "device-c",
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "c".repeat(64),
		actorId: "actor-c",
		coordinatorUrl: "https://coordinator.example",
		coordinatorId: "coordinator-one",
		groupId: "group-one",
	};
	writeFileSync(profile.dbPath, "synthetic database bytes; actor-c; sharing unchanged", {
		mode: 0o600,
	});
	writeFileSync(join(directory, "device.key"), "synthetic key bytes", { mode: 0o600 });
	writeFileSync(join(directory, "config.json"), '{"actor_id":"actor-c","sharing":"unchanged"}');
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("unexpected network call");
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

describe("proposed account owner context (not remote authority)", () => {
	it("reads missing state without creating files or initializing a missing database", () => {
		// Arrange
		const files = readdirSync(directory);
		const before = files.map((file) => snapshot(join(directory, file)));
		// Act
		const missing = readAccountOwnerAssociation(profile);
		const absentDb = readAccountOwnerAssociation({
			...profile,
			dbPath: join(directory, "absent.sqlite"),
		});
		// Assert
		expect([missing, absentDb]).toEqual([null, null]);
		expect(readdirSync(directory)).toEqual(files);
		expect(files.map((file) => snapshot(join(directory, file)))).toEqual(before);
	});

	it("publishes a private regular file with exact database and canonical key pins, without mutating the profile", () => {
		// Arrange
		const files = readdirSync(directory);
		const before = files.map((file) => snapshot(join(directory, file)));
		const originalProfile = { ...profile };
		const db = lstatSync(profile.dbPath, { bigint: true });
		// Act
		const retained = retainAccountOwnerAssociation(profile, review);
		const read = readAccountOwnerAssociation({
			...profile,
			publicKey: `${CANONICAL_PUBLIC_KEY} comment`,
		});
		// Assert
		expect(retained).toEqual({
			version: 1,
			databaseFile: `${db.dev}:${db.ino}`,
			deviceId: profile.deviceId,
			keyId: EXPECTED_KEY_ID,
			fingerprint: profile.fingerprint,
			actorId: "actor-c",
			coordinatorUrl: profile.coordinatorUrl,
			coordinatorId: profile.coordinatorId,
			groupId: profile.groupId,
			...review,
		});
		expect(read).toEqual(retained);
		expect(JSON.parse(readFileSync(associationPath(), "utf8"))).toEqual(retained);
		const stat = lstatSync(associationPath());
		expect(stat.isFile()).toBe(true);
		expect(stat.isSymbolicLink()).toBe(false);
		expect(stat.mode & 0o777).toBe(0o600);
		if (process.getuid) expect(stat.uid).toBe(process.getuid());
		expect(readdirSync(directory).sort()).toEqual(
			[...files, associationPath().split("/").at(-1)].sort(),
		);
		expect(files.map((file) => snapshot(join(directory, file)))).toEqual(before);
		expect(profile).toEqual(originalProfile);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns an exact retry without rewriting bytes, inode, or modification time", () => {
		// Arrange
		const first = retainAccountOwnerAssociation(profile, review);
		const before = snapshot(associationPath());
		const files = readdirSync(directory);
		// Act
		const retry = retainAccountOwnerAssociation(profile, review);
		// Assert
		expect(retry).toEqual(first);
		expect(snapshot(associationPath())).toEqual(before);
		expect(readdirSync(directory)).toEqual(files);
	});

	it.each([
		{ ownerIdentityId: "owner-b" },
		{ attestationId: `controller-v1:${"d".repeat(64)}` },
		{ reviewDigest: "e".repeat(64) },
	])("refuses conflicting review evidence %j without overwriting", (change) => {
		// Arrange
		retainAccountOwnerAssociation(profile, review);
		const before = snapshot(associationPath());
		// Act / Assert
		expect(() => retainAccountOwnerAssociation(profile, { ...review, ...change })).toThrow(
			"account_owner_association_invalid",
		);
		expect(snapshot(associationPath())).toEqual(before);
	});
});

describe("account owner association validation", () => {
	it.each([
		{ ownerIdentityId: "" },
		{ attestationId: "unsigned-review" },
		{ reviewDigest: "B".repeat(64) },
		{ reviewDigest: "short" },
	])("rejects invalid review input %j before creating state", (change) => {
		// Arrange
		const files = readdirSync(directory);
		// Act / Assert
		expect(() => retainAccountOwnerAssociation(profile, { ...review, ...change })).toThrow(
			"account_owner_association_invalid",
		);
		expect(readdirSync(directory)).toEqual(files);
	});

	it.each([
		{ version: 2 },
		{ unexpected: true },
		{ actorId: "actor-other" },
		{ deviceId: "device-other" },
		{ keyId: "d".repeat(64) },
		{ fingerprint: "d".repeat(64) },
		{ databaseFile: "0:0" },
		{ coordinatorUrl: "https://coordinator.example/" },
		{ coordinatorUrl: "https://other.example" },
		{ coordinatorId: "other-coordinator" },
		{ groupId: "other-group" },
		{ ownerIdentityId: "" },
		{ attestationId: "controller-v1:invalid" },
		{ reviewDigest: "invalid" },
	])("rejects malformed or mismatched retained fields %j", (change) => {
		// Arrange
		const record = retainAccountOwnerAssociation(profile, review);
		writeFileSync(associationPath(), JSON.stringify({ ...record, ...change }));
		const before = snapshot(associationPath());
		// Act / Assert
		expect(() => readAccountOwnerAssociation(profile)).toThrow("account_owner_association_invalid");
		expect(() => retainAccountOwnerAssociation(profile, review)).toThrow(
			"account_owner_association_invalid",
		);
		expect(snapshot(associationPath())).toEqual(before);
	});

	it.each(["{", "null", "[]", "{}"])(
		"rejects malformed state %s rather than treating it as absent",
		(text) => {
			// Arrange
			writeFileSync(associationPath(), text, { mode: 0o600 });
			// Act / Assert
			expect(() => readAccountOwnerAssociation(profile)).toThrow(
				"account_owner_association_invalid",
			);
		},
	);

	it.each([
		"version",
		"databaseFile",
		"deviceId",
		"keyId",
		"fingerprint",
		"actorId",
		"coordinatorUrl",
		"coordinatorId",
		"groupId",
		"ownerIdentityId",
		"attestationId",
		"reviewDigest",
	])("rejects a retained record missing %s", (field) => {
		// Arrange
		const record: Record<string, unknown> = { ...retainAccountOwnerAssociation(profile, review) };
		delete record[field];
		writeFileSync(associationPath(), JSON.stringify(record));
		// Act / Assert
		expect(() => readAccountOwnerAssociation(profile)).toThrow("account_owner_association_invalid");
	});
});

describe("account owner profile binding", () => {
	it.each(["actorId", "deviceId", "fingerprint", "publicKey"] as const)(
		"rejects a different current profile %s",
		(field) => {
			// Arrange
			retainAccountOwnerAssociation(profile, review);
			const alternateKey = wireBytes();
			alternateKey[alternateKey.length - 1] ^= 1;
			const values = {
				actorId: "other-actor",
				deviceId: "other-device",
				fingerprint: "f".repeat(64),
				publicKey: publicKeyFromWire(alternateKey),
			};
			// Act / Assert
			expect(() => readAccountOwnerAssociation({ ...profile, [field]: values[field] })).toThrow(
				"account_owner_association_invalid",
			);
		},
	);

	it.each([
		{ coordinatorUrl: "https://other.example" },
		{ coordinatorId: "other-coordinator" },
		{ groupId: "other-group" },
	])("separates scope %j and rejects a copied record with the wrong pins", (scope) => {
		// Arrange
		retainAccountOwnerAssociation(profile, review);
		const other = { ...profile, ...scope };
		// Act
		const absent = readAccountOwnerAssociation(other);
		writeFileSync(associationPath(other), readFileSync(associationPath()), { mode: 0o600 });
		// Assert
		expect(absent).toBeNull();
		expect(() => readAccountOwnerAssociation(other)).toThrow("account_owner_association_invalid");
	});

	it.each(["permissions", "symlink", "missing-db", "replaced-db", "symlink-db"])(
		"rejects unsafe retained state: %s",
		(fault) => {
			// Arrange
			retainAccountOwnerAssociation(profile, review);
			const path = associationPath();
			if (fault === "permissions") chmodSync(path, 0o644);
			if (fault === "symlink") {
				renameSync(path, `${path}.original`);
				symlinkSync(`${path}.original`, path);
			}
			if (fault === "missing-db") unlinkSync(profile.dbPath);
			if (fault === "replaced-db" || fault === "symlink-db") {
				renameSync(profile.dbPath, `${profile.dbPath}.original`);
				if (fault === "replaced-db") writeFileSync(profile.dbPath, "replacement database");
				else symlinkSync(`${profile.dbPath}.original`, profile.dbPath);
			}
			// Act / Assert
			expect(() => readAccountOwnerAssociation(profile)).toThrow(
				"account_owner_association_invalid",
			);
			expect(() => retainAccountOwnerAssociation(profile, review)).toThrow();
		},
	);

	it("treats an edited local owner as proposed context only, without changing actor or contacting authority", () => {
		// Arrange: local JSON is editable, not signed remote evidence.
		const record = retainAccountOwnerAssociation(profile, review);
		const paths = [profile.dbPath, join(directory, "device.key"), join(directory, "config.json")];
		const before = paths.map(snapshot);
		writeFileSync(associationPath(), JSON.stringify({ ...record, ownerIdentityId: "owner-b" }));
		// Act
		const proposed = readAccountOwnerAssociation(profile);
		// Assert: a consumer must separately recheck signed remote authority.
		expect(proposed?.ownerIdentityId).toBe("owner-b");
		expect(proposed?.actorId).toBe("actor-c");
		expect(paths.map(snapshot)).toEqual(before);
		expect(fetch).not.toHaveBeenCalled();
	});
});
