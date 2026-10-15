import * as fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { reviewOwnerProfile } from "./coordinator-owner-profile-adoption.js";
import { enrollOwnerProfile } from "./coordinator-owner-profile-client.js";
import {
	facts,
	fixture,
	insertMemory,
	now,
	registerOwnerProfileClientMockState,
} from "./coordinator-owner-profile-client-test-harness.js";
import { ownerFileSnapshot } from "./coordinator-owner-profile-files.js";
import {
	recordForeignMemoryRevision,
	recordLocalCreationSnapshot,
} from "./memory-creation-provenance.js";
import { allocateLocalMemorySource } from "./memory-source-identity.js";
import { fingerprintPublicKey, generateKeypair, loadPublicKey } from "./sync-identity.js";

const signing = vi.hoisted(() => ({ corrupt: false }));
const databaseOpens = vi.hoisted(() => [] as Array<{ readonly?: boolean }>);
const platformAccess = vi.hoisted(() => ({ tracking: false, files: [] as string[], databases: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const tracked = Object.fromEntries(
		[
			"existsSync",
			"lstatSync",
			"statSync",
			"readFileSync",
			"writeFileSync",
			"mkdirSync",
			"openSync",
			"closeSync",
			"fsyncSync",
			"linkSync",
			"unlinkSync",
			"renameSync",
			"chmodSync",
			"copyFileSync",
			"rmSync",
			"readdirSync",
			"realpathSync",
		].map((name) => [
			name,
			(...args: unknown[]) => {
				if (platformAccess.tracking) platformAccess.files.push(name);
				return Reflect.apply(
					actual[name as keyof typeof actual] as (...args: unknown[]) => unknown,
					actual,
					args,
				);
			},
		]),
	);
	return { ...actual, ...tracked };
});
vi.mock("better-sqlite3", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof import("better-sqlite3") }>();
	return {
		...actual,
		default: new Proxy(actual.default, {
			construct(target, args, newTarget) {
				databaseOpens.push((args[1] as { readonly?: boolean } | undefined) ?? {});
				if (platformAccess.tracking) platformAccess.databases += 1;
				return Reflect.construct(target, args, newTarget);
			},
		}),
	};
});
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		sign: (...args: unknown[]) =>
			signing.corrupt ? Buffer.alloc(64) : Reflect.apply(actual.sign, undefined, args),
	};
});
registerOwnerProfileClientMockState({ signing, databaseOpens });

it.each(["", " ", "\t", null])(
	"rejects ambiguous foreign actor before discovery (case %#)",
	async (actor) => {
		// Arrange: imported provenance cannot make an empty or non-string actor acceptable.
		fixture.db
			.prepare("UPDATE memory_items SET actor_id = ? WHERE actor_id = 'foreign'")
			.run(actor);
		const before = facts();
		const actors = fixture.db.prepare("SELECT * FROM actors").all();
		const schema = fixture.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
		const config = ownerFileSnapshot(fixture.options.configPath);
		const key = ownerFileSnapshot(join(fixture.options.keysDir, "device.key"));
		const publicFile = ownerFileSnapshot(join(fixture.options.keysDir, "device.key.pub"));
		const database = readFileSync(fixture.options.dbPath);
		const databaseInode = fs.lstatSync(fixture.options.dbPath).ino;
		// Act: reject before foreign counting can hide malformed historical authorship.
		expect(() =>
			reviewOwnerProfile({
				db: fixture.db,
				actorId: "local:local",
				expectedPublicKey: fixture.publicKey,
			}),
		).toThrow();
		await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
			code: "review_required",
		});
		// Assert: history, schema and physical profile files remain unchanged; no GET is issued.
		expect(fixture.calls).toEqual([]);
		expect(existsSync(fixture.options.stateDir)).toBe(false);
		expect(facts()).toEqual(before);
		expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
		expect(fixture.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(config);
		expect(readFileSync(fixture.options.dbPath).equals(database), "database bytes unchanged").toBe(
			true,
		);
		expect(fs.lstatSync(fixture.options.dbPath).ino).toBe(databaseInode);
		expect(ownerFileSnapshot(join(fixture.options.keysDir, "device.key"))).toEqual(key);
		expect(ownerFileSnapshot(join(fixture.options.keysDir, "device.key.pub"))).toEqual(publicFile);
	},
);

it("refuses ambiguous historical authorship without local creation evidence", async () => {
	// Arrange: historical authorship alone is not creation proof.
	insertMemory({ actorId: "local:local", entityId: "legacy-no-proof" });
	// Act: review must refuse the unproven row.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: no discovery or enrollment state is published.
	expect(fixture.calls).toEqual([]);
	expect(existsSync(fixture.options.stateDir)).toBe(false);
});

it("adopts matching signed creation snapshots without granting imported actors rights", async () => {
	// Arrange: a new signed creation follows the earlier unsigned local capture.
	fixture.db.transaction(() => {
		const source = allocateLocalMemorySource(fixture.db);
		insertMemory({ actorId: "local:local", entityId: source.entityId });
		const memoryId = Number(
			fixture.db
				.prepare("SELECT id FROM memory_items WHERE import_key = ?")
				.pluck()
				.get(source.entityId),
		);
		recordLocalCreationSnapshot(fixture.db, memoryId);
	})();
	const before = facts();
	// Act: both authored rows must match their immutable snapshots.
	const review = await enrollOwnerProfile(fixture.options);
	if (review.kind !== "prepared") throw new Error("expected review");
	fixture.options = {
		...fixture.options,
		mode: "resume",
		reviewedDigest: review.reviewDigest,
		capability: "explicit-admin-capability",
	};
	const result = await enrollOwnerProfile(fixture.options);
	// Assert: creation evidence permits local adoption, not imported-row ownership.
	expect(review.review.localMemoryCount).toBe(2);
	expect(review.review.retainedForeignMemoryCount).toBe(1);
	expect(result).toMatchObject({ kind: "adopted", identityId: "identity" });
	expect(facts()).toEqual(before);
	expect(
		fixture.db.prepare("SELECT * FROM identity_devices WHERE identity_id = 'foreign'").all(),
	).toEqual([]);
});

it.each([
	"missing snapshot",
	"content drift",
	"scope drift",
	"duplicate content drift",
	"duplicate scope drift",
	"signing key mismatch",
	"foreign revision",
])("rejects authored %s before discovery or any profile/schema mutation", async (conflict) => {
	// Arrange: each case retains source evidence but lacks matching immutable creation proof.
	const entityId = fixture.db
		.prepare("SELECT import_key FROM memory_items WHERE actor_id = 'local:local'")
		.pluck()
		.get() as string;
	if (conflict === "missing snapshot") {
		fixture.db.transaction(() => {
			const source = allocateLocalMemorySource(fixture.db);
			insertMemory({ actorId: "local:local", entityId: source.entityId });
		})();
	}
	if (conflict === "content drift")
		fixture.db
			.prepare("UPDATE memory_items SET body_text = 'Revised content' WHERE import_key = ?")
			.run(entityId);
	if (conflict === "scope drift")
		fixture.db
			.prepare("UPDATE memory_items SET scope_id = 'different-scope' WHERE import_key = ?")
			.run(entityId);
	if (conflict === "foreign revision")
		fixture.db.transaction(() =>
			recordForeignMemoryRevision(fixture.db, entityId, "replication"),
		)();
	if (conflict === "duplicate content drift" || conflict === "duplicate scope drift") {
		insertMemory({ actorId: "local:local", entityId });
		const duplicateId = fixture.db.prepare("SELECT MAX(id) FROM memory_items").pluck().get();
		if (conflict === "duplicate content drift")
			fixture.db
				.prepare("UPDATE memory_items SET body_text = 'Duplicate revised content' WHERE id = ?")
				.run(duplicateId);
		else
			fixture.db
				.prepare("UPDATE memory_items SET scope_id = 'duplicate-scope' WHERE id = ?")
				.run(duplicateId);
	}
	if (conflict === "signing key mismatch") {
		// Record an earlier signing tuple without changing the actual profile key files.
		generateKeypair(
			join(fixture.options.keysDir, "creation.key"),
			join(fixture.options.keysDir, "creation.key.pub"),
		);
		const creationKey = readFileSync(
			join(fixture.options.keysDir, "creation.key.pub"),
			"utf8",
		).trim();
		fixture.db.transaction(() => {
			fixture.db
				.prepare("UPDATE sync_device SET public_key = ?, fingerprint = ?")
				.run(creationKey, fingerprintPublicKey(creationKey));
			const source = allocateLocalMemorySource(fixture.db);
			insertMemory({ actorId: "local:local", entityId: source.entityId });
			const memoryId = Number(
				fixture.db
					.prepare("SELECT id FROM memory_items WHERE import_key = ?")
					.pluck()
					.get(source.entityId),
			);
			recordLocalCreationSnapshot(fixture.db, memoryId);
			fixture.db
				.prepare("UPDATE sync_device SET public_key = ?, fingerprint = ?")
				.run(fixture.publicKey, fingerprintPublicKey(fixture.publicKey));
		})();
		expect(loadPublicKey(fixture.options.keysDir)).toBe(fixture.publicKey);
		expect(fixture.db.prepare("SELECT public_key FROM sync_device").pluck().get()).toBe(
			fixture.publicKey,
		);
	}
	const before = facts();
	const schema = fixture.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
	const actors = fixture.db.prepare("SELECT * FROM actors").all();
	const devices = fixture.db.prepare("SELECT * FROM sync_device").all();
	const config = ownerFileSnapshot(fixture.options.configPath);
	const key = ownerFileSnapshot(join(fixture.options.keysDir, "device.key"));
	const publicFile = ownerFileSnapshot(join(fixture.options.keysDir, "device.key.pub"));
	const original = fixture.db
		.prepare("SELECT * FROM memory_items WHERE import_key = ? ORDER BY id LIMIT 1")
		.get(entityId);
	// Act: an authored row must pass the creation predicate before GET or adoption.
	expect(() =>
		reviewOwnerProfile({
			db: fixture.db,
			actorId: "local:local",
			expectedPublicKey: fixture.publicKey,
		}),
	).toThrow("Owner enrollment stopped for review.");
	await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
		name: "OwnerProfileEnrollmentError",
		code: "review_required",
	});
	// Assert: rejection grants no rights and changes neither schema nor profile files.
	expect(fixture.calls).toEqual([]);
	expect(existsSync(fixture.options.stateDir)).toBe(false);
	expect(facts()).toEqual(before);
	expect(
		fixture.db
			.prepare("SELECT * FROM memory_items WHERE import_key = ? ORDER BY id LIMIT 1")
			.get(entityId),
	).toEqual(original);
	expect(fixture.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
	expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
	expect(fixture.db.prepare("SELECT * FROM sync_device").all()).toEqual(devices);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	expect(
		fixture.db.prepare("SELECT COUNT(*) FROM memory_local_capture_adoption").pluck().get(),
	).toBe(0);
	expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(config);
	expect(ownerFileSnapshot(join(fixture.options.keysDir, "device.key"))).toEqual(key);
	expect(ownerFileSnapshot(join(fixture.options.keysDir, "device.key.pub"))).toEqual(publicFile);
});
it("rejects another local Identity and existing Team policy, never merges them", async () => {
	// Arrange: another local identity conflicts with adoption.
	fixture.db
		.prepare(
			"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES ('other', 'Other', 1, 'active', ?, ?)",
		)
		.run(now, now);
	// Act: refuse both a competing identity and existing team policy.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	fixture.db.prepare("UPDATE actors SET is_local = 0 WHERE actor_id = 'other'").run();
	fixture.db
		.prepare(
			"INSERT INTO policy_teams(team_id, display_name, status, provenance, revision, migration_state, idempotency_key, created_at, updated_at) VALUES ('team', 'Team', 'active', 'user', 'rev', 'user_managed', 'team', ?, ?)",
		)
		.run(now, now);
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: neither conflict reaches discovery.
	expect(fixture.calls).toEqual([]);
});
