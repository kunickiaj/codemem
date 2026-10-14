import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import * as enrollmentReceiver from "./coordinator-account-link-receiver.js";
import { enrollOwnerProfile } from "./coordinator-owner-profile-client.js";
import {
	browser,
	facts,
	fakeFetch,
	fixture,
	interruptedPrepare,
	pin,
	prepared,
	read,
	received,
	registerOwnerProfileClientMockState,
	rotateKey,
} from "./coordinator-owner-profile-client-test-harness.js";
import { ownerFileSnapshot } from "./coordinator-owner-profile-files.js";
import * as configWriter from "./observer-config.js";

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

it.each(["success", "finalize failure"])(
	"keeps relative profile paths anchored after browser cwd changes: %s",
	async (outcome) => {
		// Arrange: only process.cwd is simulated; the receiver and its callback stay real.
		await prepared();
		const original = fixture.options;
		const alternate = join(fixture.directory, "alternate");
		fs.mkdirSync(alternate);
		let cwd = fixture.directory;
		vi.spyOn(process, "cwd").mockImplementation(() => cwd);
		const before = facts();
		const config = readFileSync(original.configPath, "utf8");
		const keys = ["device.key", "device.key.pub"].map((name) =>
			ownerFileSnapshot(join(original.keysDir, name)),
		);
		const databaseInode = fs.lstatSync(original.dbPath).ino;
		const options = {
			...original,
			dbPath: relative(cwd, original.dbPath),
			configPath: relative(cwd, original.configPath),
			keysDir: relative(cwd, original.keysDir),
			stateDir: relative(cwd, original.stateDir),
			onBrowserStart: async () => {
				cwd = alternate;
				await browser();
			},
		};
		fixture.failFinal = outcome === "finalize failure";
		// Act: browser delivery must not redirect any subsequent path or failure inspection.
		if (outcome === "finalize failure") {
			await expect(enrollOwnerProfile(options)).rejects.toMatchObject({
				code: "retained_request_incomplete",
			});
			// Assert: retain the original final without adoption or artifacts in the new cwd.
			expect(readFileSync(original.configPath, "utf8")).toBe(config);
			expect(facts()).toEqual(before);
			expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
			expect(existsSync(join(original.stateDir, "receipt.json"))).toBe(false);
			expect(fs.readdirSync(alternate)).toEqual([]);
			const final = ownerFileSnapshot(join(original.stateDir, "final.json"));
			fixture.failFinal = false;
			fixture.calls = [];
			// Act: an absolute-path resume from the changed cwd retries the exact retained body.
			expect(
				await enrollOwnerProfile({ ...original, capability: undefined, onBrowserStart: undefined }),
			).toMatchObject({ kind: "adopted" });
			expect(fixture.finalBodies).toEqual([fixture.finalBodies[0], fixture.finalBodies[0]]);
			expect(fixture.calls.map((call) => call.path)).toEqual([
				"/v1/auth/owner-config",
				"/v1/auth/owner-attempts/finalize",
			]);
			expect(ownerFileSnapshot(join(original.stateDir, "final.json"))).toEqual(final);
		} else expect(await enrollOwnerProfile(options)).toMatchObject({ kind: "adopted" });
		// Assert: only the original profile receives enrollment state and intended adoption.
		expect(cwd).toBe(alternate);
		expect(fs.readdirSync(alternate)).toEqual([]);
		expect(fs.readdirSync(original.stateDir).sort()).toEqual([
			"capability-request.json",
			"final.json",
			"prepared.json",
			"receipt.json",
			"start-attempted.json",
		]);
		expect(read("prepared.json").paths).toEqual({
			dbPath: original.dbPath,
			configPath: original.configPath,
			keysDir: original.keysDir,
			stateDir: original.stateDir,
		});
		expect(facts()).toEqual(before);
		expect(fs.lstatSync(original.dbPath).ino).toBe(databaseInode);
		expect(
			["device.key", "device.key.pub"].map((name) =>
				ownerFileSnapshot(join(original.keysDir, name)),
			),
		).toEqual(keys);
		expect(JSON.parse(readFileSync(original.configPath, "utf8"))).toEqual({
			...JSON.parse(config),
			actor_id: "identity",
			sync_coordinator_url: pin.origin,
			sync_coordinator_group: "group",
		});
	},
);

it("config CAS refuses an intervening config writer after metadata commits", async () => {
	// Arrange: another writer changes config between metadata commit and config replacement.
	await prepared();
	vi.spyOn(configWriter, "atomicReplaceConfigFile").mockImplementationOnce(
		(_path, _text, _mode, _uid, verify) => {
			writeFileSync(
				fixture.options.configPath,
				JSON.stringify({ actor_id: "someone-else", unrelated: "new" }),
			);
			verify?.();
		},
	);
	// Act: refuse to overwrite the intervening writer.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: committed metadata remains truthful and conflicting config cannot resume.
	expect(fixture.db.prepare("SELECT identity_id FROM identity_devices").pluck().get()).toBe(
		"identity",
	);
	expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8"))).toEqual({
		actor_id: "someone-else",
		unrelated: "new",
	});
	fixture.options.capability = undefined;
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
});

it("retains the exact signed final before an ambiguous failure and retries unchanged", async () => {
	// Arrange: a finalized request may have committed despite a lost response.
	await prepared();
	const request = readFileSync(join(fixture.options.stateDir, "capability-request.json"));
	fixture.failFinal = true;
	// Act: retain the final even when transport cannot confirm the result.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow(
		/retry --resume.*exact finalization/,
	);
	// Assert: ambiguity instructs an exact retry, not a replacement ceremony.
	expect(fixture.finalBodies).toHaveLength(1);
	expect(existsSync(join(fixture.options.stateDir, "receipt.json"))).toBe(false);
	const final = readFileSync(join(fixture.options.stateDir, "final.json"));
	fixture.failFinal = false;
	fixture.options.capability = undefined;
	fixture.options.onBrowserStart = undefined;
	fixture.calls = [];
	await enrollOwnerProfile(fixture.options);
	expect(fixture.finalBodies).toEqual([fixture.finalBodies[0], fixture.finalBodies[0]]);
	expect(fixture.calls.map((call) => call.path)).not.toContain("/v1/auth/owner-attempts");
	expect(readFileSync(join(fixture.options.stateDir, "final.json"))).toEqual(final);
	expect(readFileSync(join(fixture.options.stateDir, "capability-request.json"))).toEqual(request);
});
it("config failure retains truthful committed metadata and resumes config alone", async () => {
	// Arrange: config publication fails after metadata commit.
	await prepared();
	const beforeConfig = readFileSync(fixture.options.configPath, "utf8");
	const writer = vi.spyOn(configWriter, "atomicReplaceConfigFile").mockImplementationOnce(() => {
		throw new Error("config write failed");
	});
	// Act: retain the committed assignment, then resume after an unrelated config edit.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	expect(readFileSync(fixture.options.configPath, "utf8")).toBe(beforeConfig);
	const assignment = fixture.db.prepare("SELECT * FROM identity_devices").all();
	expect(assignment).toHaveLength(1);
	const actors = fixture.db.prepare("SELECT * FROM actors").all();
	writer.mockRestore();
	fixture.calls = [];
	fixture.options.capability = undefined;
	const edited = JSON.parse(beforeConfig);
	edited.unrelated.nested.push("new unrelated value");
	writeFileSync(fixture.options.configPath, JSON.stringify(edited));
	await enrollOwnerProfile(fixture.options);
	// Assert: offline config-only recovery preserves metadata and the unrelated edit.
	expect(fixture.calls).toEqual([]);
	expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
	expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual(assignment);
	expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8")).unrelated.nested.at(-1)).toBe(
		"new unrelated value",
	);
});
it.each(["history", "actor-alias"])(
	"config-only resume refuses changed %s without mutating metadata",
	async (change) => {
		// Arrange: retain a receipt and metadata while config publication fails.
		await prepared();
		const writer = vi.spyOn(configWriter, "atomicReplaceConfigFile").mockImplementationOnce(() => {
			throw new Error("config failed");
		});
		await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
		writer.mockRestore();
		fixture.calls = [];
		if (change === "history")
			fixture.db
				.prepare(
					"UPDATE memory_items SET body_text = 'competing writer' WHERE actor_id = 'foreign'",
				)
				.run();
		if (change === "actor-alias")
			fixture.db
				.prepare(
					"UPDATE actors SET merged_into_actor_id = 'identity' WHERE actor_id = 'local:local'",
				)
				.run();
		const config = readFileSync(fixture.options.configPath, "utf8");
		const assignment = fixture.db.prepare("SELECT * FROM identity_devices").all();
		// Act: changed history or aliases invalidate config-only recovery.
		await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
		// Assert: refusal leaves the assignment and config untouched without requests.
		expect(fixture.calls).toEqual([]);
		expect(readFileSync(fixture.options.configPath, "utf8")).toBe(config);
		expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual(assignment);
	},
);
it("refuses a replaced database file even when its device, key and review facts were copied", async () => {
	// Arrange: a byte-identical copy has a different inode from the reviewed database.
	await prepared();
	fixture.calls = [];
	const original = `${fixture.options.dbPath}.original`;
	renameSync(fixture.options.dbPath, original);
	copyFileSync(original, fixture.options.dbPath);
	// Act: reject the substituted file.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: no request or identity assignment occurs.
	expect(fixture.calls).toEqual([]);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
});

it("deferred commit failure rolls back actors/capture/assignment before config changes", async () => {
	// Arrange: adoption succeeds statement-by-statement but fails at COMMIT.
	// A deferred FK failure happens on COMMIT, after all adoption statements have run.
	fixture.db.exec(
		"CREATE TABLE commit_failure(value TEXT REFERENCES actors(actor_id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_owner_commit AFTER INSERT ON identity_devices BEGIN INSERT INTO commit_failure VALUES ('missing'); END;",
	);
	await prepared();
	const config = readFileSync(fixture.options.configPath, "utf8");
	const actors = fixture.db.prepare("SELECT * FROM actors").all();
	// Act: the remote receipt is saved before local adoption is attempted.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: rollback preserves the profile, and the saved receipt permits offline recovery.
	expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
	expect(
		fixture.db.prepare("SELECT COUNT(*) FROM memory_local_capture_adoption").pluck().get(),
	).toBe(0);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	expect(readFileSync(fixture.options.configPath, "utf8")).toBe(config);
	const receipt = readFileSync(join(fixture.options.stateDir, "receipt.json"));
	const final = readFileSync(join(fixture.options.stateDir, "final.json"));
	fixture.db.exec("DROP TRIGGER fail_owner_commit");
	fixture.calls = [];
	fixture.options.capability = undefined;
	fixture.options.onBrowserStart = undefined;
	fixture.options.fetch = vi
		.fn()
		.mockRejectedValue(new Error("receipt resume must not use network"));
	expect(await enrollOwnerProfile(fixture.options)).toMatchObject({
		kind: "adopted",
		identityId: "identity",
	});
	expect(fixture.options.fetch).not.toHaveBeenCalled();
	expect(fixture.calls).toEqual([]);
	expect(readFileSync(join(fixture.options.stateDir, "receipt.json"))).toEqual(receipt);
	expect(readFileSync(join(fixture.options.stateDir, "final.json"))).toEqual(final);
	expect(
		fixture.db.prepare("SELECT COUNT(*) FROM memory_local_capture_adoption").pluck().get(),
	).toBe(1);
	expect(fixture.db.prepare("SELECT identity_id FROM identity_devices").pluck().get()).toBe(
		"identity",
	);
	expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8")).actor_id).toBe("identity");
});

it.each(["succeeds", "fails"])(
	"syncs a new state directory's parent before opening any retained artifact when parent sync %s",
	async (outcome) => {
		// Arrange: the new state-directory entry must be durable before any enrollment file.
		const parent = fs.lstatSync(fixture.directory);
		const before = facts();
		const config = ownerFileSnapshot(fixture.options.configPath);
		const key = readFileSync(join(fixture.options.keysDir, "device.key"));
		const receiver = vi
			.spyOn(enrollmentReceiver, "createCoordinatorOwnerEnrollmentReceiver")
			.mockResolvedValue({
				destination: "http://127.0.0.1:43127/owner/callback",
				completion: Promise.resolve({ completionSecret: "unused", confirmationHash: "unused" }),
				close: vi.fn().mockResolvedValue(undefined),
			});
		const realSync = fs.fsyncSync;
		const realOpen = fs.openSync;
		let parentSynced = false;
		let parentSyncAttempted = false;
		const artifacts: string[] = [];
		const sync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			const node = fs.fstatSync(fd);
			if (node.isDirectory() && node.dev === parent.dev && node.ino === parent.ino) {
				parentSyncAttempted = true;
				expect(fs.readdirSync(fixture.options.stateDir)).toEqual([]);
				if (outcome === "fails") throw new Error("new state-directory parent sync failed");
				realSync(fd);
				parentSynced = true;
				return;
			}
			realSync(fd);
		});
		const open = vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
			if (flags === "wx" && String(path).startsWith(`${fixture.options.stateDir}/`)) {
				artifacts.push(String(path));
				expect(parentSynced).toBe(true);
			}
			return realOpen(path, flags, mode);
		});
		try {
			// Act: parent sync either permits private state publication or stops it completely.
			if (outcome === "succeeds")
				expect(await enrollOwnerProfile(fixture.options)).toMatchObject({ kind: "prepared" });
			else await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
			// Assert: failed parent durability cannot publish or even stage a saved review.
			expect(parentSyncAttempted).toBe(true);
			if (outcome === "succeeds") {
				expect(artifacts).toHaveLength(2);
				expect(read("capability-request.json")).toEqual({ start: read("prepared.json").start });
			} else {
				expect(artifacts).toEqual([]);
				expect(fs.readdirSync(fixture.options.stateDir)).toEqual([]);
			}
			expect(facts()).toEqual(before);
			expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(config);
			expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
		} finally {
			open.mockRestore();
			sync.mockRestore();
			receiver.mockRestore();
		}
	},
);

it("retries partial prepare using the exact saved attempt, signature, loopback, key and review", async () => {
	// Arrange: only prepared.json survived; the operator request never published.
	const before = facts();
	const actors = fixture.db.prepare("SELECT * FROM actors").all();
	const config = ownerFileSnapshot(fixture.options.configPath);
	const key = readFileSync(join(fixture.options.keysDir, "device.key"));
	const publicFile = readFileSync(join(fixture.options.keysDir, "device.key.pub"));
	const databaseInode = fs.lstatSync(fixture.options.dbPath).ino;
	const receiver = await interruptedPrepare();
	const savedFile = join(fixture.options.stateDir, "prepared.json");
	const saved = ownerFileSnapshot(savedFile);
	const state = read("prepared.json");
	fixture.options.fetch = vi.fn(fakeFetch);
	fixture.options.onBrowserStart = vi
		.fn()
		.mockRejectedValue(new Error("prepare must not start browser"));
	// Act: repeat --prepare, rather than creating a replacement enrollment ceremony.
	const result = await enrollOwnerProfile(fixture.options);
	// Assert: the exact reviewed/signed start survives and only its private request publishes.
	expect(result).toEqual({
		kind: "prepared",
		review: { ...state.review, publicKey: state.start.publicKey },
		reviewDigest: state.reviewDigest,
		requestFile: join(fixture.options.stateDir, "capability-request.json"),
	});
	expect(ownerFileSnapshot(savedFile)).toEqual(saved);
	expect(read("capability-request.json")).toEqual({ start: state.start });
	expect(fs.lstatSync(join(fixture.options.stateDir, "capability-request.json")).mode & 0o777).toBe(
		0o600,
	);
	expect(receiver).not.toHaveBeenCalled();
	expect(fixture.options.onBrowserStart).not.toHaveBeenCalled();
	expect(fixture.calls.map((call) => call.path)).toEqual(["/v1/auth/owner-config"]);
	expect(databaseOpens).toHaveLength(1);
	expect(databaseOpens[0]).toMatchObject({ readonly: true });
	expect(facts()).toEqual(before);
	expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
	expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(config);
	expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
	expect(readFileSync(join(fixture.options.keysDir, "device.key.pub"))).toEqual(publicFile);
	expect(fs.lstatSync(fixture.options.dbPath).ino).toBe(databaseInode);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	expect(fixture.finalBodies).toEqual([]);
});

it.each([
	"request changed",
	"Actor drift",
	"config drift",
	"key drift",
	"database inode drift",
	"review facts drift",
	"starter present",
	"final present",
	"receipt present",
])("refuses partial prepare retry after %s without replacing saved evidence", async (conflict) => {
	// Arrange: a saved review is reusable only before start consumption and with exact profile facts.
	const receiver = await interruptedPrepare();
	const state = read("prepared.json");
	if (conflict === "request changed")
		writeFileSync(
			join(fixture.options.stateDir, "capability-request.json"),
			JSON.stringify({
				start: { ...state.start, attemptId: "another-attempt" },
			}),
			{ mode: 0o600 },
		);
	if (conflict === "Actor drift")
		fixture.db
			.prepare("UPDATE actors SET display_name = 'Competing Actor' WHERE actor_id = 'local:local'")
			.run();
	if (conflict === "config drift")
		writeFileSync(
			fixture.options.configPath,
			JSON.stringify({ actor_id: "local:local", unrelated: "changed" }),
		);
	if (conflict === "key drift") rotateKey();
	if (conflict === "database inode drift") {
		const original = `${fixture.options.dbPath}.original`;
		renameSync(fixture.options.dbPath, original);
		copyFileSync(original, fixture.options.dbPath);
	}
	if (conflict === "review facts drift")
		fixture.db
			.prepare("UPDATE memory_items SET body_text = 'Changed history' WHERE actor_id = 'foreign'")
			.run();
	const marker = {
		"starter present": "start-attempted.json",
		"final present": "final.json",
		"receipt present": "receipt.json",
	}[conflict];
	if (marker)
		writeFileSync(
			join(fixture.options.stateDir, marker),
			JSON.stringify({ evidence: "retained" }),
			{
				mode: 0o600,
			},
		);
	const saved = ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"));
	const requestPath = join(fixture.options.stateDir, "capability-request.json");
	const request = existsSync(requestPath) ? ownerFileSnapshot(requestPath) : undefined;
	const before = facts();
	const actors = fixture.db.prepare("SELECT * FROM actors").all();
	const config = ownerFileSnapshot(fixture.options.configPath);
	const key = readFileSync(join(fixture.options.keysDir, "device.key"));
	fixture.options.fetch = vi.fn(fakeFetch);
	fixture.options.onBrowserStart = vi.fn();
	// Act: repeating --prepare cannot repair drift by silently replacing the saved attempt.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: no request, server, signing key, profile facts or saved evidence changes.
	expect(receiver).not.toHaveBeenCalled();
	expect(fixture.calls.every((call) => call.path === "/v1/auth/owner-config")).toBe(true);
	expect(fixture.calls.length).toBeLessThanOrEqual(1);
	if (conflict !== "request changed") expect(fixture.calls).toEqual([]);
	expect(fixture.options.onBrowserStart).not.toHaveBeenCalled();
	expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(saved);
	if (request) expect(ownerFileSnapshot(requestPath)).toEqual(request);
	else expect(existsSync(requestPath)).toBe(false);
	if (marker) expect(read(marker)).toEqual({ evidence: "retained" });
	expect(facts()).toEqual(before);
	expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
	expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(config);
	expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	expect(fixture.finalBodies).toEqual([]);
});

it("repeats prepare with an existing exact private capability request without rewriting either file", async () => {
	// Arrange: recover the interrupted prepare once, keeping the saved signed start.
	const receiver = await interruptedPrepare();
	await enrollOwnerProfile(fixture.options);
	const saved = ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"));
	const request = ownerFileSnapshot(join(fixture.options.stateDir, "capability-request.json"));
	const before = facts();
	fixture.calls = [];
	// Act: an additional --prepare is an exact retry, not another signature ceremony.
	const result = await enrollOwnerProfile(fixture.options);
	// Assert: neither retained inode nor reviewed facts are replaced.
	expect(result).toMatchObject({
		kind: "prepared",
		reviewDigest: read("prepared.json").reviewDigest,
	});
	expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(saved);
	expect(ownerFileSnapshot(join(fixture.options.stateDir, "capability-request.json"))).toEqual(
		request,
	);
	expect(receiver).not.toHaveBeenCalled();
	expect(fixture.calls.map((call) => call.path)).toEqual(["/v1/auth/owner-config"]);
	expect(facts()).toEqual(before);
});

it("refuses temp-only prepare evidence without promoting or deleting unknown artifacts", async () => {
	// Arrange: no canonical prepared.json exists, even though a complete private temp remains.
	const receiver = await interruptedPrepare();
	const artifact = join(fixture.options.stateDir, "prepared.json.tmp-interrupted");
	renameSync(join(fixture.options.stateDir, "prepared.json"), artifact);
	const before = Object.fromEntries(
		fs
			.readdirSync(fixture.options.stateDir)
			.map((name) => [name, ownerFileSnapshot(join(fixture.options.stateDir, name))]),
	);
	const profile = facts();
	fixture.options.fetch = vi.fn(fakeFetch);
	// Act: a temp filename is not authority to reconstruct canonical enrollment state.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: preserve every unknown artifact and fail before discovery or server startup.
	expect(
		Object.fromEntries(
			fs
				.readdirSync(fixture.options.stateDir)
				.map((name) => [name, ownerFileSnapshot(join(fixture.options.stateDir, name))]),
		),
	).toEqual(before);
	expect(existsSync(join(fixture.options.stateDir, "prepared.json"))).toBe(false);
	expect(existsSync(join(fixture.options.stateDir, "capability-request.json"))).toBe(false);
	expect(fixture.options.fetch).not.toHaveBeenCalled();
	expect(receiver).not.toHaveBeenCalled();
	expect(facts()).toEqual(profile);
});

it.each(["rejected", "malformed expiry", "server-expired admission", "browser interrupted"])(
	"requires fresh prepare in a new state directory after a nonfinal %s attempt",
	async (failure) => {
		// Arrange: these failures cannot be recovered by replaying the consumed start.
		await prepared();
		const saved = readFileSync(join(fixture.options.stateDir, "capability-request.json"));
		const preparedState = ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"));
		const config = ownerFileSnapshot(fixture.options.configPath);
		const key = readFileSync(join(fixture.options.keysDir, "device.key"));
		const before = facts();
		fixture.options.fetch = async (input, init) => {
			if (new URL(String(input)).pathname !== "/v1/auth/owner-attempts")
				return fakeFetch(input, init);
			if (failure === "rejected") return Response.json({ kind: "denied" }, { status: 403 });
			// Production admission deliberately hides expiry behind enrollment_unavailable.
			if (failure === "server-expired admission")
				return Response.json({ error: "enrollment_unavailable" }, { status: 403 });
			if (failure === "malformed expiry")
				return Response.json({
					kind: "started",
					attemptId: read("prepared.json").start.attemptId,
					expiresAtMs: 0,
				});
			return fakeFetch(input, init);
		};
		if (failure === "browser interrupted")
			fixture.options.onBrowserStart = () => {
				throw new Error("private-browser-code");
			};

		// Act: fail before retaining a signed final.
		const error = await enrollOwnerProfile(fixture.options).catch((error: Error) => error);

		// Assert: preserve evidence, but do not tell the user to replay the dead attempt.
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ code: "fresh_prepare_required" });
		expect(String(error)).toMatch(/(?:fresh|new).*prepare|prepare.*(?:fresh|new)/i);
		expect(String(error)).toContain("--state-dir");
		expect(String(error)).not.toContain("private-browser-code");
		expect(String(error)).not.toMatch(/resume.*unchanged/i);
		expect(readFileSync(join(fixture.options.stateDir, "capability-request.json"))).toEqual(saved);
		expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(
			preparedState,
		);
		expect(read("start-attempted.json")).toEqual({
			attemptId: read("prepared.json").start.attemptId,
		});
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(config);
		expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
		expect(existsSync(join(fixture.options.stateDir, "final.json"))).toBe(false);
		expect(fixture.finalBodies).toEqual([]);
		expect(facts()).toEqual(before);
		const originalStateDir = fixture.options.stateDir;
		const originalAttemptId = read("prepared.json").start.attemptId;
		fixture.options.fetch = vi.fn(fakeFetch);
		await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow(/NEW --state-dir/);
		expect(fixture.options.fetch).not.toHaveBeenCalled();
		fixture.options = {
			...fixture.options,
			mode: "prepare",
			stateDir: join(fixture.directory, "fresh-enrollment"),
			capability: undefined,
			reviewedDigest: undefined,
		};
		const replacement = await enrollOwnerProfile(fixture.options);
		expect(replacement.kind).toBe("prepared");
		expect(read("prepared.json").start.attemptId).not.toBe(originalAttemptId);
		expect(readFileSync(join(originalStateDir, "capability-request.json"))).toEqual(saved);
	},
);

it("prepares and resumes when the platform has no process UID function", async () => {
	// Arrange: model the missing API, not native Windows permissions or ACL behavior.
	const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
	const before = facts();
	Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
	try {
		// Act: the state-directory checks must not invoke an unavailable UID API.
		await prepared();
		const result = await enrollOwnerProfile(fixture.options);
		// Assert: only enrollment metadata and intended config change.
		expect(result).toMatchObject({ kind: "adopted", identityId: "identity" });
		expect(facts()).toEqual(before);
		expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8")).actor_id).toBe("identity");
	} finally {
		if (descriptor) Object.defineProperty(process, "getuid", descriptor);
	}
});

it("rejects Windows with fixed guidance before accessing any profile file or database", async () => {
	// Arrange: the profile exists, but native ACL privacy has not been verified.
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!descriptor) throw new Error("missing platform descriptor");
	const before = facts();
	const config = readFileSync(fixture.options.configPath);
	const key = readFileSync(join(fixture.options.keysDir, "device.key"));
	const publicFile = readFileSync(join(fixture.options.keysDir, "device.key.pub"));
	const actors = fixture.db.prepare("SELECT * FROM actors").all();
	fixture.options.fetch = vi.fn().mockRejectedValue(new Error("network must not run"));
	platformAccess.files = [];
	platformAccess.databases = 0;
	Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
	platformAccess.tracking = true;
	let error: unknown;
	try {
		// Act: unsupported-platform refusal must precede even error-state inspection.
		error = await enrollOwnerProfile(fixture.options).catch((failure: unknown) => failure);
	} finally {
		platformAccess.tracking = false;
		Object.defineProperty(process, "platform", descriptor);
	}
	// Assert: sanitized refusal never reads keys, opens SQLite, or publishes state.
	expect(error).toBeInstanceOf(Error);
	expect(error).toMatchObject({
		name: "OwnerProfileEnrollmentError",
		code: "unsupported_platform",
		message:
			"Existing-profile owner enrollment is not available on Windows until private-file ACL verification is implemented. Keep this profile unchanged; do not copy signing keys to work around this limitation.",
	});
	expect(platformAccess.files).toEqual([]);
	expect(platformAccess.databases).toBe(0);
	expect(fixture.options.fetch).not.toHaveBeenCalled();
	expect(fixture.calls).toEqual([]);
	expect(existsSync(fixture.options.stateDir)).toBe(false);
	expect(facts()).toEqual(before);
	expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	expect(readFileSync(fixture.options.configPath)).toEqual(config);
	expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
	expect(readFileSync(join(fixture.options.keysDir, "device.key.pub"))).toEqual(publicFile);
});

it("rejects a state-directory UID mismatch before network or database mutation", async () => {
	// Arrange: a valid saved request now belongs to another process UID.
	await prepared();
	const before = facts();
	const actors = fixture.db.prepare("SELECT * FROM actors").all();
	const key = readFileSync(join(fixture.options.keysDir, "device.key"));
	const config = readFileSync(fixture.options.configPath);
	const request = readFileSync(join(fixture.options.stateDir, "prepared.json"));
	fixture.calls = [];
	vi.spyOn(process, "getuid").mockReturnValue((process.getuid as () => number)() + 1);
	// Act: resume must fail at the ownership check.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: an available UID API remains enforced and no coordinator is contacted.
	expect(fixture.calls).toEqual([]);
	expect(facts()).toEqual(before);
	expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	expect(readFileSync(fixture.options.configPath)).toEqual(config);
	expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
	expect(readFileSync(join(fixture.options.stateDir, "prepared.json"))).toEqual(request);
});

it.each(["published", "renamed"])(
	"resumes the identical retained receipt after its config writer is killed at %s",
	async (boundary) => {
		// Arrange: retain the real signed final, receipt and committed metadata first.
		await prepared();
		const before = facts();
		const key = readFileSync(join(fixture.options.keysDir, "device.key"));
		const config = readFileSync(fixture.options.configPath, "utf8");
		const writer = vi.spyOn(configWriter, "atomicReplaceConfigFile").mockImplementationOnce(() => {
			throw new Error("stop before config publication");
		});
		await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
		writer.mockRestore();
		const preparedState = read("prepared.json");
		const receipt = readFileSync(join(fixture.options.stateDir, "receipt.json"));
		const final = readFileSync(join(fixture.options.stateDir, "final.json"));
		const assignment = fixture.db.prepare("SELECT * FROM identity_devices").all();
		const actors = fixture.db.prepare("SELECT * FROM actors").all();
		const data = {
			paths: preparedState.paths,
			snapshot: ownerFileSnapshot(fixture.options.configPath),
			identityId: received.identityId,
			coordinatorOrigin: pin.origin,
			groupId: fixture.options.groupId,
			lockAuthentication: {
				reviewDigest: preparedState.reviewDigest,
				databaseFile: preparedState.databaseFile,
				keyId: preparedState.keyId,
				deviceId: preparedState.review.deviceId,
				bindingId: received.bindingId,
			},
		};
		const script = `
			import fs from 'node:fs';
			import { syncBuiltinESMExports } from 'node:module';
			const data = JSON.parse(process.argv[1]);
			const lock = data.paths.configPath + '.lock';
			const fsync = fs.fsyncSync;
			fs.fsyncSync = (fd) => {
				fsync(fd);
				if (process.argv[2] === 'published' && fs.existsSync(lock)) {
					const record = JSON.parse(fs.readFileSync(lock, 'utf8'));
					if (record.purpose === 'owner-profile-config-v1' && record.mac && record.pid === process.pid) process.kill(process.pid, 'SIGKILL');
				}
			};
			const rename = fs.renameSync;
			fs.renameSync = (from, to) => { rename(from, to); if (process.argv[2] === 'renamed' && to === data.paths.configPath) process.kill(process.pid, 'SIGKILL'); };
			syncBuiltinESMExports();
			const { applyOwnerProfileConfig } = await import(process.argv[3]);
			data.lockAuthentication.privateKey = fs.readFileSync(data.paths.keysDir + '/device.key');
			applyOwnerProfileConfig({ ...data, assertRuntime() {} });
		`;
		// Act: crash the actual authenticated writer, then resume offline using saved evidence.
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				script,
				JSON.stringify(data),
				boundary,
				new URL("./coordinator-owner-profile-files.ts", import.meta.url).href,
			],
			{ timeout: 10000, encoding: "utf8" },
		);
		expect(child.error).toBeUndefined();
		expect(child.signal, child.stderr).toBe("SIGKILL");
		const lockPath = `${fixture.options.configPath}.lock`;
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		expect(lock.pid).toBe(child.pid);
		expect(lock.mac).toMatch(/^[a-f0-9]{64}$/);
		if (boundary === "published")
			expect(readFileSync(fixture.options.configPath, "utf8")).toBe(config);
		else
			expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8")).actor_id).toBe(
				"identity",
			);
		fixture.calls = [];
		fixture.options.capability = undefined;
		fixture.options.onBrowserStart = undefined;
		fixture.options.fetch = vi
			.fn()
			.mockRejectedValue(new Error("receipt resume must stay offline"));
		const result = await enrollOwnerProfile(fixture.options);
		// Assert: recovery never replaces the receipt, key, history or committed authorship.
		expect(result).toMatchObject({ kind: "adopted", identityId: "identity" });
		expect(fixture.options.fetch).not.toHaveBeenCalled();
		expect(fixture.calls).toEqual([]);
		expect(facts()).toEqual(before);
		expect(fixture.db.prepare("SELECT * FROM identity_devices").all()).toEqual(assignment);
		expect(fixture.db.prepare("SELECT * FROM actors").all()).toEqual(actors);
		expect(readFileSync(join(fixture.options.stateDir, "receipt.json"))).toEqual(receipt);
		expect(readFileSync(join(fixture.options.stateDir, "final.json"))).toEqual(final);
		expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
		expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8"))).toMatchObject({
			actor_id: "identity",
			unrelated: { nested: [1, { keep: true }] },
		});
		expect(existsSync(lockPath)).toBe(false);
	},
);
