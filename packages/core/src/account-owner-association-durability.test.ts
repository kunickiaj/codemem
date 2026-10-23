import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AccountOwnerAssociation,
	type AccountOwnerProfile,
	retainAccountOwnerAssociation,
} from "./account-owner-association.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	ownerDatabaseFile,
	retainOwnerState,
	syncOwnerProfileDirectory,
} from "./coordinator-owner-profile-files.js";

// Isolate the publication boundary, not validation or real file reads. A visible
// record alone must not let a second publisher acknowledge an unsynced entry.
vi.mock("./coordinator-owner-profile-files.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./coordinator-owner-profile-files.js")>();
	return {
		...actual,
		retainOwnerState: vi.fn(),
		syncOwnerProfileDirectory: vi.fn(),
	};
});

const review = {
	ownerIdentityId: "owner-a",
	attestationId: `controller-v1:${"a".repeat(64)}`,
	reviewDigest: "b".repeat(64),
};
let directory: string;
let profile: AccountOwnerProfile;
let record: AccountOwnerAssociation;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "account-owner-durability-"));
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
	writeFileSync(profile.dbPath, "synthetic database bytes", { mode: 0o600 });
	record = {
		version: 1,
		databaseFile: ownerDatabaseFile(profile.dbPath),
		deviceId: profile.deviceId,
		keyId: EXPECTED_KEY_ID,
		fingerprint: profile.fingerprint,
		actorId: profile.actorId,
		coordinatorUrl: profile.coordinatorUrl,
		coordinatorId: profile.coordinatorId,
		groupId: profile.groupId,
		...review,
	};
	vi.mocked(retainOwnerState).mockReset();
	vi.mocked(syncOwnerProfileDirectory).mockReset();
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function arrangeVisiblePublication(mode: "exact retry" | "concurrent EEXIST"): void {
	if (mode === "exact retry") {
		// Capture the actual scoped filename without copying its hashing algorithm.
		vi.mocked(retainOwnerState).mockImplementationOnce((path, value) => {
			writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
		});
		retainAccountOwnerAssociation(profile, review);
		vi.mocked(retainOwnerState).mockClear();
		vi.mocked(syncOwnerProfileDirectory).mockClear();
		return;
	}
	vi.mocked(retainOwnerState).mockImplementationOnce((path, value) => {
		// Publisher A made its complete record visible but has not synced the
		// directory; publisher B loses exclusive publication to that same record.
		writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
		throw Object.assign(new Error("concurrent publication"), { code: "EEXIST" });
	});
}

describe.each(["exact retry", "concurrent EEXIST"] as const)(
	"association durability: %s",
	(mode) => {
		it("syncs the containing directory before acknowledging the visible record", () => {
			// Arrange
			arrangeVisiblePublication(mode);
			const events: string[] = [];
			vi.mocked(syncOwnerProfileDirectory).mockImplementation((path) => {
				expect(path).toBe(dirname(profile.dbPath));
				events.push("directory synced");
			});
			// Act
			const retained = retainAccountOwnerAssociation(profile, review);
			events.push("success returned");
			// Assert
			expect(retained).toEqual(record);
			expect(events).toEqual(["directory synced", "success returned"]);
			expect(syncOwnerProfileDirectory).toHaveBeenCalledExactlyOnceWith(directory);
			expect(retainOwnerState).toHaveBeenCalledTimes(mode === "exact retry" ? 0 : 1);
		});

		it("propagates directory sync failure instead of acknowledging an unsynced record", () => {
			// Arrange
			arrangeVisiblePublication(mode);
			const failure = Object.assign(new Error("synthetic directory sync failure"), { code: "EIO" });
			vi.mocked(syncOwnerProfileDirectory).mockImplementation(() => {
				throw failure;
			});
			// Act / Assert
			expect(() => retainAccountOwnerAssociation(profile, review)).toThrow(failure);
			expect(syncOwnerProfileDirectory).toHaveBeenCalledExactlyOnceWith(directory);
			const files = readdirSync(directory).filter((name) => name.includes(".account-owner-"));
			expect(files).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(directory, files[0]), "utf8"))).toEqual(record);
			expect(readFileSync(profile.dbPath, "utf8")).toBe("synthetic database bytes");
		});
	},
);
