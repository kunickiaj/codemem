import { createHash } from "node:crypto";
import {
	chmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AccountOwnerProfile,
	captureAccountOwnerProfilePins,
	readAccountOwnerAssociation,
	retainAccountOwnerAssociation,
} from "./account-owner-association.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { ownerDatabaseFile } from "./coordinator-owner-profile-files.js";

// Inject faults at real POSIX calls, without replacing publication or sync with success stubs.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: vi.fn(actual.linkSync),
		fsyncSync: vi.fn(actual.fsyncSync),
		lstatSync: vi.fn(actual.lstatSync),
	};
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const review = {
	ownerIdentityId: "owner-a",
	attestationId: `controller-v1:${"a".repeat(64)}`,
	reviewDigest: "b".repeat(64),
};
let directory: string;
let profile: AccountOwnerProfile;

function legacyPath(p = profile): string {
	const scope = createHash("sha256")
		.update(JSON.stringify([new URL(p.coordinatorUrl).origin, p.coordinatorId, p.groupId]))
		.digest("hex")
		.slice(0, 32);
	return `${resolve(p.dbPath)}.account-owner-${scope}.json`;
}
function records(): string[] {
	return readdirSync(directory)
		.filter((name) => name.includes(".account-owner-") && name.endsWith(".json"))
		.map((name) => join(directory, name))
		.sort();
}
function snapshot(path: string) {
	const stat = lstatSync(path, { bigint: true });
	return { bytes: readFileSync(path), ino: stat.ino, dev: stat.dev, mtime: stat.mtimeNs };
}
function replaceDatabase(): void {
	// Keep the old inode alive: allocation cannot accidentally reuse it.
	renameSync(profile.dbPath, `${profile.dbPath}.original`);
	writeFileSync(profile.dbPath, "synthetic replacement database", { mode: 0o600 });
}
function alternateKey(): string {
	const wire = wireBytes();
	wire[wire.length - 1] ^= 1;
	return publicKeyFromWire(wire);
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "owner-generations-"));
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
	writeFileSync(profile.dbPath, "synthetic database; actor-c; original history", { mode: 0o600 });
	writeFileSync(join(directory, "device.key"), "synthetic private key", { mode: 0o600 });
	writeFileSync(join(directory, "config.json"), '{"actor_id":"actor-c","sharing":"unchanged"}');
	vi.mocked(linkSync).mockReset().mockImplementation(actualFs.linkSync);
	vi.mocked(fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
	vi.mocked(lstatSync).mockReset().mockImplementation(actualFs.lstatSync);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("unexpected network");
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

describe("captured owner profile metadata, not remote authority", () => {
	it("captures exactly eight semantic pins using real inode and canonical public key", () => {
		// Arrange
		const original = { ...profile };
		const files = readdirSync(directory);
		const before = files.map((name) => snapshot(join(directory, name)));
		// Act
		const pins = captureAccountOwnerProfilePins(profile);
		// Assert
		expect(pins).toEqual({
			databaseFile: ownerDatabaseFile(profile.dbPath),
			deviceId: profile.deviceId,
			keyId: EXPECTED_KEY_ID,
			fingerprint: profile.fingerprint,
			actorId: profile.actorId,
			coordinatorUrl: profile.coordinatorUrl,
			coordinatorId: profile.coordinatorId,
			groupId: profile.groupId,
		});
		expect(profile).toEqual(original);
		expect(readdirSync(directory)).toEqual(files);
		expect(files.map((name) => snapshot(join(directory, name)))).toEqual(before);
	});

	it("ignores unrelated properties and canonicalizes key comments and origin spelling", () => {
		// Arrange: extra runtime properties are not AccountOwnerProfile pins.
		const expectedProfilePins = captureAccountOwnerProfilePins(profile);
		const sameContext = {
			...profile,
			label: "new label",
			model: "new model",
			publicKey: `${CANONICAL_PUBLIC_KEY} new comment`,
			coordinatorUrl: `${profile.coordinatorUrl}/`,
		};
		// Act
		const pins = captureAccountOwnerProfilePins(sameContext);
		const retained = retainAccountOwnerAssociation(sameContext, review, { expectedProfilePins });
		// Assert
		expect(pins).toEqual(expectedProfilePins);
		expect(readAccountOwnerAssociation(profile, { expectedProfilePins })).toEqual(retained);
	});

	it("does not create a missing database or directory during capture or read", () => {
		// Arrange
		const expectedProfilePins = captureAccountOwnerProfilePins(profile);
		const missing = { ...profile, dbPath: join(directory, "missing", "profile.sqlite") };
		const before = readdirSync(directory);
		// Act / Assert
		expect(() => captureAccountOwnerProfilePins(missing)).toThrow();
		expect(() => readAccountOwnerAssociation(missing, { expectedProfilePins })).toThrow();
		expect(readdirSync(directory)).toEqual(before);
	});

	it.each(["getter", "inherited", "prototype", "extra", "missing", "symbol"])(
		"rejects %s expected-pin shapes without invoking accessors",
		(shape) => {
			// Arrange
			const pins = captureAccountOwnerProfilePins(profile);
			const getter = vi.fn(() => pins.actorId);
			let expectedProfilePins = { ...pins };
			if (shape === "getter")
				Object.defineProperty(expectedProfilePins, "actorId", { get: getter });
			if (shape === "inherited") expectedProfilePins = Object.create(pins);
			if (shape === "prototype")
				expectedProfilePins = Object.assign(Object.create({ extra: true }), pins);
			if (shape === "extra") Object.defineProperty(expectedProfilePins, "extra", { value: true });
			if (shape === "missing") Reflect.deleteProperty(expectedProfilePins, "actorId");
			if (shape === "symbol")
				Object.defineProperty(expectedProfilePins, Symbol("extra"), { value: true });
			const before = readdirSync(directory);
			// Act / Assert
			expect(() => readAccountOwnerAssociation(profile, { expectedProfilePins })).toThrow();
			expect(() =>
				retainAccountOwnerAssociation(profile, review, { expectedProfilePins }),
			).toThrow();
			expect(getter).not.toHaveBeenCalled();
			expect(readdirSync(directory)).toEqual(before);
		},
	);

	it.each([
		"databaseFile",
		"deviceId",
		"keyId",
		"fingerprint",
		"actorId",
		"coordinatorUrl",
		"coordinatorId",
		"groupId",
	] as const)("rejects changed %s against captured pins before publishing", (field) => {
		// Arrange
		const expectedProfilePins = captureAccountOwnerProfilePins(profile);
		if (field === "databaseFile") replaceDatabase();
		else if (field === "keyId") profile.publicKey = alternateKey();
		else if (field === "fingerprint") profile.fingerprint = "d".repeat(64);
		else if (field === "coordinatorUrl") profile.coordinatorUrl = "https://other.example";
		else profile[field] = `other-${field}`;
		const before = readdirSync(directory);
		// Act / Assert
		expect(() => readAccountOwnerAssociation(profile, { expectedProfilePins })).toThrow();
		expect(() => retainAccountOwnerAssociation(profile, review, { expectedProfilePins })).toThrow();
		expect(readdirSync(directory)).toEqual(before);
		expect(linkSync).not.toHaveBeenCalled();
	});

	it("does not let a caller-supplied key hash authorize a different current key", () => {
		// Arrange
		const pins = captureAccountOwnerProfilePins(profile);
		const expectedProfilePins = { ...pins, keyId: "d".repeat(64) };
		// Act / Assert
		expect(() => retainAccountOwnerAssociation(profile, review, { expectedProfilePins })).toThrow();
		expect(records()).toEqual([]);
	});
});

describe("explicit generations with unchanged legacy callers", () => {
	it("keeps the legacy filename and strict wrong-profile behavior without options", () => {
		// Arrange
		const retained = retainAccountOwnerAssociation(profile, review);
		const before = snapshot(legacyPath());
		const changed = { ...profile, actorId: "new-actor" };
		// Act / Assert
		expect(records()).toEqual([legacyPath()]);
		expect(readAccountOwnerAssociation(profile)).toEqual(retained);
		expect(() => readAccountOwnerAssociation(changed)).toThrow();
		expect(() => retainAccountOwnerAssociation(changed, review)).toThrow();
		expect(snapshot(legacyPath())).toEqual(before);
	});

	it("returns the matching legacy record as fallback without migrating or rewriting it", () => {
		// Arrange
		const retained = retainAccountOwnerAssociation(profile, review);
		const expectedProfilePins = captureAccountOwnerProfilePins(profile);
		const before = snapshot(legacyPath());
		// Act
		const found = readAccountOwnerAssociation(profile, { expectedProfilePins });
		// Assert
		expect(found).toEqual(retained);
		expect(records()).toEqual([legacyPath()]);
		expect(snapshot(legacyPath())).toEqual(before);
	});

	it("creates a private generation, not a legacy record, without changing any original file", () => {
		// Arrange
		const expectedProfilePins = captureAccountOwnerProfilePins(profile);
		const paths = readdirSync(directory).map((name) => join(directory, name));
		const before = paths.map(snapshot);
		const original = { ...profile };
		// Act
		const retained = retainAccountOwnerAssociation(profile, review, { expectedProfilePins });
		// Assert
		expect(records()).toHaveLength(1);
		expect(records()).not.toContain(legacyPath());
		expect(JSON.parse(readFileSync(records()[0], "utf8"))).toEqual({
			version: 1,
			...expectedProfilePins,
			...review,
		});
		expect(lstatSync(records()[0]).mode & 0o777).toBe(0o600);
		expect(readAccountOwnerAssociation(profile, { expectedProfilePins })).toEqual(retained);
		expect(readAccountOwnerAssociation(profile)).toBeNull();
		expect(paths.map(snapshot)).toEqual(before);
		expect(profile).toEqual(original);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["actor", "inode"])(
		"retains a new %s context alongside a byte-identical valid old legacy record",
		(change) => {
			// Arrange
			const old = retainAccountOwnerAssociation(profile, review);
			const before = snapshot(legacyPath());
			if (change === "actor") profile.actorId = "new-actor";
			else replaceDatabase();
			const expectedProfilePins = captureAccountOwnerProfilePins(profile);
			// Act
			const missing = readAccountOwnerAssociation(profile, { expectedProfilePins });
			const retained = retainAccountOwnerAssociation(profile, review, { expectedProfilePins });
			// Assert
			expect(missing).toBeNull();
			expect(retained.ownerIdentityId).toBe(old.ownerIdentityId);
			expect(retained).toMatchObject(expectedProfilePins);
			expect(readAccountOwnerAssociation(profile, { expectedProfilePins })).toEqual(retained);
			expect(records()).toHaveLength(2);
			expect(snapshot(legacyPath())).toEqual(before);
			expect(() => readAccountOwnerAssociation(profile)).toThrow();
		},
	);

	it("reads only the captured exact generation, never a latest record or automatic actor update", () => {
		// Arrange
		const firstProfile = { ...profile };
		const firstPins = captureAccountOwnerProfilePins(firstProfile);
		const first = retainAccountOwnerAssociation(firstProfile, review, {
			expectedProfilePins: firstPins,
		});
		profile.actorId = "new-actor";
		const nextPins = captureAccountOwnerProfilePins(profile);
		const next = retainAccountOwnerAssociation(
			profile,
			{ ...review, attestationId: `controller-v1:${"d".repeat(64)}` },
			{ expectedProfilePins: nextPins },
		);
		const unrelated = { ...profile, actorId: "third-actor" };
		// Act
		const oldRead = readAccountOwnerAssociation(firstProfile, { expectedProfilePins: firstPins });
		const nextRead = readAccountOwnerAssociation(profile, { expectedProfilePins: nextPins });
		const absent = readAccountOwnerAssociation(unrelated, {
			expectedProfilePins: captureAccountOwnerProfilePins(unrelated),
		});
		// Assert
		expect(oldRead).toEqual(first);
		expect(nextRead).toEqual(next);
		expect(absent).toBeNull();
		expect(records()).toHaveLength(2);
		expect(profile.actorId).toBe("new-actor");
	});

	it("prefers the exact generation over a separately valid matching legacy fallback", () => {
		// Arrange
		const expectedProfilePins = captureAccountOwnerProfilePins(profile);
		const generated = retainAccountOwnerAssociation(profile, review, { expectedProfilePins });
		retainAccountOwnerAssociation(profile, { ...review, reviewDigest: "d".repeat(64) });
		// Act
		const found = readAccountOwnerAssociation(profile, { expectedProfilePins });
		// Assert
		expect(found).toEqual(generated);
		expect(records()).toHaveLength(2);
	});
});

describe("strict validation of legacy evidence in generation mode", () => {
	it.each(["malformed", "permissions", "symlink", "foreign uid"])(
		"rejects %s legacy evidence even when the exact generation is valid",
		(fault) => {
			// Arrange
			const expectedProfilePins = captureAccountOwnerProfilePins(profile);
			retainAccountOwnerAssociation(profile, review, { expectedProfilePins });
			retainAccountOwnerAssociation(profile, review);
			if (fault === "malformed") writeFileSync(legacyPath(), "{");
			if (fault === "permissions") chmodSync(legacyPath(), 0o644);
			if (fault === "symlink") {
				renameSync(legacyPath(), `${legacyPath()}.original`);
				symlinkSync(`${legacyPath()}.original`, legacyPath());
			}
			if (fault === "foreign uid") {
				// Only legacy appears foreign; the generation and DB retain their real metadata.
				vi.mocked(lstatSync).mockImplementation(((path, options) => {
					const stat = actualFs.lstatSync(path, options);
					if (String(path) === legacyPath()) {
						const uid = typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1;
						Object.defineProperty(stat, "uid", { value: uid });
					}
					return stat;
				}) as typeof lstatSync);
			}
			const before = records().map(snapshot);
			// Act / Assert
			expect(() => readAccountOwnerAssociation(profile, { expectedProfilePins })).toThrow();
			expect(() =>
				retainAccountOwnerAssociation(profile, review, { expectedProfilePins }),
			).toThrow();
			expect(records().map(snapshot)).toEqual(before);
		},
	);

	it("does not classify malformed other-context legacy evidence as absent", () => {
		// Arrange
		const old = retainAccountOwnerAssociation(profile, review);
		writeFileSync(legacyPath(), JSON.stringify({ ...old, reviewDigest: "B".repeat(64) }));
		profile.actorId = "new-actor";
		const expectedProfilePins = captureAccountOwnerProfilePins(profile);
		const before = snapshot(legacyPath());
		// Act / Assert
		expect(() => readAccountOwnerAssociation(profile, { expectedProfilePins })).toThrow();
		expect(() => retainAccountOwnerAssociation(profile, review, { expectedProfilePins })).toThrow();
		expect(records()).toHaveLength(1);
		expect(snapshot(legacyPath())).toEqual(before);
	});

	it.each([
		{ ownerIdentityId: "other-owner" },
		{ attestationId: "other-controller" },
		{ reviewDigest: "d".repeat(64) },
	])("refuses conflicting evidence %j in the same context without replacement", (change) => {
		// Arrange
		const expectedProfilePins = captureAccountOwnerProfilePins(profile);
		retainAccountOwnerAssociation(profile, review, { expectedProfilePins });
		const before = records().map(snapshot);
		// Act / Assert
		expect(() =>
			retainAccountOwnerAssociation(profile, { ...review, ...change }, { expectedProfilePins }),
		).toThrow();
		expect(records().map(snapshot)).toEqual(before);
		expect(records()).toHaveLength(1);
	});
});

describe("ordinary retained controller identifier compatibility", () => {
	it.each(["legacy", "generation"])(
		"accepts original-controller in %s mode without implying remote proof",
		(mode) => {
			// Arrange
			const options =
				mode === "generation"
					? { expectedProfilePins: captureAccountOwnerProfilePins(profile) }
					: undefined;
			// Act
			const retained = retainAccountOwnerAssociation(
				profile,
				{ ...review, attestationId: "original-controller" },
				options,
			);
			// Assert
			expect(readAccountOwnerAssociation(profile, options)).toEqual(retained);
			expect(retained.attestationId).toBe("original-controller");
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["", "controller\ninvalid", "controller\u200binvalid", "x".repeat(257)])(
		"rejects malformed retained controller identifier %j in both modes",
		(attestationId) => {
			// Arrange
			const options = { expectedProfilePins: captureAccountOwnerProfilePins(profile) };
			// Act / Assert
			expect(() => retainAccountOwnerAssociation(profile, { ...review, attestationId })).toThrow();
			expect(() =>
				retainAccountOwnerAssociation(profile, { ...review, attestationId }, options),
			).toThrow();
			expect(records()).toEqual([]);
		},
	);

	it("preserves lowercase digest and strict version validation in generation mode", () => {
		// Arrange
		const options = { expectedProfilePins: captureAccountOwnerProfilePins(profile) };
		const record = retainAccountOwnerAssociation(profile, review, options);
		const path = records()[0];
		// Act / Assert
		expect(() =>
			retainAccountOwnerAssociation(profile, { ...review, reviewDigest: "B".repeat(64) }, options),
		).toThrow();
		writeFileSync(path, JSON.stringify({ ...record, version: 2 }));
		expect(() => readAccountOwnerAssociation(profile, options)).toThrow();
	});

	it.each(["legacy", "generation"])(
		"rejects malformed stored controller IDs in %s mode",
		(mode) => {
			// Arrange
			const options =
				mode === "generation"
					? { expectedProfilePins: captureAccountOwnerProfilePins(profile) }
					: undefined;
			const retained = retainAccountOwnerAssociation(profile, review, options);
			const path = records()[0];
			const invalidIds = ["", "controller\ninvalid", "controller\u200binvalid", "x".repeat(257)];
			// Act / Assert
			for (const attestationId of invalidIds) {
				writeFileSync(path, JSON.stringify({ ...retained, attestationId }));
				expect(() => readAccountOwnerAssociation(profile, options)).toThrow();
			}
		},
	);
});

describe("generation publication and retry durability", () => {
	it("syncs real staged bytes before exclusive publication and syncs the directory before returning", () => {
		// Arrange
		const options = { expectedProfilePins: captureAccountOwnerProfilePins(profile) };
		const events: string[] = [];
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			actualFs.fsyncSync(fd);
			events.push(fstatSync(fd).isDirectory() ? "directory synced" : "file synced");
		});
		vi.mocked(linkSync).mockImplementation((source, destination) => {
			actualFs.linkSync(source, destination);
			events.push("exclusive publication");
		});
		// Act
		retainAccountOwnerAssociation(profile, review, options);
		events.push("returned");
		// Assert
		expect(events[0]).toBe("file synced");
		expect(events.indexOf("exclusive publication")).toBeGreaterThan(events.indexOf("file synced"));
		expect(events.at(-2)).toBe("directory synced");
		expect(events.at(-1)).toBe("returned");
		expect(linkSync).toHaveBeenCalledTimes(1);
	});

	it.each(["exact retry", "concurrent EEXIST"])(
		"syncs a visible %s without rewriting the record",
		(mode) => {
			// Arrange
			const options = { expectedProfilePins: captureAccountOwnerProfilePins(profile) };
			if (mode === "exact retry") retainAccountOwnerAssociation(profile, review, options);
			else
				vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
					actualFs.linkSync(source, destination);
					throw Object.assign(new Error("other publisher won"), { code: "EEXIST" });
				});
			const before = records().map(snapshot);
			vi.mocked(fsyncSync).mockClear();
			const events: string[] = [];
			vi.mocked(fsyncSync).mockImplementation((fd) => {
				actualFs.fsyncSync(fd);
				if (fstatSync(fd).isDirectory()) events.push("directory synced");
			});
			// Act
			const retained = retainAccountOwnerAssociation(profile, review, options);
			events.push("returned");
			// Assert
			expect(readAccountOwnerAssociation(profile, options)).toEqual(retained);
			expect(events.at(-2)).toBe("directory synced");
			if (mode === "exact retry") expect(records().map(snapshot)).toEqual(before);
			expect(records()).toHaveLength(1);
		},
	);

	it.each(["exact retry", "concurrent EEXIST"])(
		"does not acknowledge %s when its directory fsync fails",
		(mode) => {
			// Arrange
			const options = { expectedProfilePins: captureAccountOwnerProfilePins(profile) };
			let published = mode === "exact retry";
			if (published) retainAccountOwnerAssociation(profile, review, options);
			else
				vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
					actualFs.linkSync(source, destination);
					published = true;
					throw Object.assign(new Error("other publisher won"), { code: "EEXIST" });
				});
			const before = records().map(snapshot);
			vi.mocked(fsyncSync).mockImplementation((fd) => {
				if (published && fstatSync(fd).isDirectory())
					throw Object.assign(new Error("synthetic fsync failure"), { code: "EIO" });
				actualFs.fsyncSync(fd);
			});
			// Act / Assert
			expect(() => retainAccountOwnerAssociation(profile, review, options)).toThrow();
			if (mode === "exact retry") expect(records().map(snapshot)).toEqual(before);
			expect(records()).toHaveLength(1);
			expect(JSON.parse(readFileSync(records()[0], "utf8"))).toEqual({
				version: 1,
				...options.expectedProfilePins,
				...review,
			});
		},
	);

	it("rejects conflicting concurrent EEXIST instead of acknowledging or overwriting it", () => {
		// Arrange
		const options = { expectedProfilePins: captureAccountOwnerProfilePins(profile) };
		vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
			const staged = JSON.parse(readFileSync(source, "utf8"));
			writeFileSync(destination, JSON.stringify({ ...staged, ownerIdentityId: "other-owner" }), {
				mode: 0o600,
				flag: "wx",
			});
			throw Object.assign(new Error("other publisher won"), { code: "EEXIST" });
		});
		// Act / Assert
		expect(() => retainAccountOwnerAssociation(profile, review, options)).toThrow();
		expect(JSON.parse(readFileSync(records()[0], "utf8")).ownerIdentityId).toBe("other-owner");
	});

	it.each(["inode", "actor", "selected path"])(
		"leaves captured-context evidence intact and reports %s changes at publication",
		(change) => {
			// Arrange: this is one injected swap, not a hostile replace-and-restore atomicity claim.
			const options = { expectedProfilePins: captureAccountOwnerProfilePins(profile) };
			const originalPath = profile.dbPath;
			const alternatePath = join(directory, "alternate.sqlite");
			if (change === "selected path")
				writeFileSync(alternatePath, "synthetic alternate database", { mode: 0o600 });
			vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
				actualFs.linkSync(source, destination);
				if (change === "inode") replaceDatabase();
				else if (change === "actor") profile.actorId = "new-actor";
				else profile.dbPath = alternatePath;
			});
			// Act / Assert
			expect(() => retainAccountOwnerAssociation(profile, review, options)).toThrow();
			expect(records()).toHaveLength(1);
			expect(records()[0].startsWith(`${originalPath}.`)).toBe(true);
			expect(JSON.parse(readFileSync(records()[0], "utf8"))).toEqual({
				version: 1,
				...options.expectedProfilePins,
				...review,
			});
			const nextOptions = { expectedProfilePins: captureAccountOwnerProfilePins(profile) };
			expect(nextOptions.expectedProfilePins).not.toEqual(options.expectedProfilePins);
			expect(readAccountOwnerAssociation(profile, nextOptions)).toBeNull();
		},
	);
});
