import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	applyOwnerProfileConfig,
	ownerDatabaseFile,
	ownerFileSnapshot,
	retainOwnerState,
} from "./coordinator-owner-profile-files.js";
import * as configWriter from "./observer-config.js";
import { generateKeypair, loadPublicKey } from "./sync-identity.js";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		unlinkSync: vi.fn(fs.unlinkSync),
		openSync: vi.fn(fs.openSync),
		writeFileSync: vi.fn(fs.writeFileSync),
		fsyncSync: vi.fn(fs.fsyncSync),
		linkSync: vi.fn(fs.linkSync),
		closeSync: vi.fn(fs.closeSync),
	};
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const realUnlink = actualFs.unlinkSync;

let directory: string;
let input: Parameters<typeof applyOwnerProfileConfig>[0];
const lockPath = () => `${input.paths.configPath}.lock`;
const configText = () => readFileSync(input.paths.configPath, "utf8");
const lockArtifacts = () =>
	readdirSync(directory).filter((name) => name.startsWith("config.json.lock.tmp-"));

beforeEach(async () => {
	vi.mocked(unlinkSync).mockImplementation(realUnlink);
	vi.mocked(openSync).mockImplementation(actualFs.openSync);
	vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync);
	vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync);
	vi.mocked(linkSync).mockImplementation(actualFs.linkSync);
	vi.mocked(closeSync).mockImplementation(actualFs.closeSync);
	directory = mkdtempSync(join(tmpdir(), "owner-lock-test-"));
	const paths = {
		dbPath: join(directory, "memory.sqlite"),
		configPath: join(directory, "config.json"),
		keysDir: join(directory, "keys"),
		stateDir: join(directory, "enrollment"),
	};
	mkdirSync(paths.keysDir, { mode: 0o700 });
	mkdirSync(paths.stateDir, { mode: 0o700 });
	generateKeypair(join(paths.keysDir, "device.key"), join(paths.keysDir, "device.key.pub"));
	writeFileSync(paths.dbPath, "retained database inode");
	writeFileSync(
		paths.configPath,
		JSON.stringify({ actor_id: "local:local", unrelated: { keep: [1, 2] } }),
		{ mode: 0o600 },
	);
	input = {
		paths,
		snapshot: ownerFileSnapshot(paths.configPath),
		identityId: "identity",
		coordinatorOrigin: "https://coordinator.example",
		groupId: "group",
		assertRuntime: vi.fn(),
		lockAuthentication: {
			privateKey: readFileSync(join(paths.keysDir, "device.key")),
			reviewDigest: "b".repeat(64),
			databaseFile: ownerDatabaseFile(paths.dbPath),
			keyId: (await ed25519KeyId(loadPublicKey(paths.keysDir) ?? "")) ?? "",
			deviceId: "device",
			bindingId: "binding",
		},
	};
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

function authenticatedLock(pid: number): Record<string, unknown> {
	const auth = input.lockAuthentication;
	if (!auth) throw new Error("missing fixture authentication");
	const operation = createHash("sha256")
		.update(
			JSON.stringify([
				"owner-profile-config-operation-v1",
				resolve(input.paths.configPath),
				resolve(input.paths.dbPath),
				resolve(input.paths.keysDir),
				resolve(input.paths.stateDir),
				auth.reviewDigest,
				auth.databaseFile,
				auth.keyId,
				auth.deviceId,
				auth.bindingId,
				input.identityId,
				input.coordinatorOrigin,
				input.groupId,
			]),
		)
		.digest("hex");
	const record = { purpose: "owner-profile-config-v1", token: randomUUID(), pid, operation };
	const mac = createHmac("sha256", auth.privateKey)
		.update(
			JSON.stringify([
				"owner-profile-config-lock-v1",
				record.purpose,
				record.token,
				record.pid,
				record.operation,
			]),
		)
		.digest("hex");
	return { ...record, mac };
}
function deadCheck() {
	return vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("dead writer"), { code: "ESRCH" });
	});
}

it.each(["published", "renamed"])(
	"recovers the real authenticated writer killed after config lock %s",
	(boundary) => {
		// Arrange: kill at the actual writer boundary, never at an empty initializer lock.
		const beforeKey = readFileSync(join(input.paths.keysDir, "device.key"));
		const beforeConfig = configText();
		const script = `
		import fs from 'node:fs';
		import { syncBuiltinESMExports } from 'node:module';
		const data = JSON.parse(process.argv[1]);
		const boundary = process.argv[2];
		const lock = data.paths.configPath + '.lock';
		const fsync = fs.fsyncSync;
		fs.fsyncSync = (fd) => {
			fsync(fd);
			if (boundary === 'published' && fs.existsSync(lock)) {
				const record = JSON.parse(fs.readFileSync(lock, 'utf8'));
				if (record.purpose === 'owner-profile-config-v1' && record.mac && record.pid === process.pid) process.kill(process.pid, 'SIGKILL');
			}
		};
		const rename = fs.renameSync;
		fs.renameSync = (from, to) => { rename(from, to); if (boundary === 'renamed' && to === data.paths.configPath) process.kill(process.pid, 'SIGKILL'); };
		syncBuiltinESMExports();
		const { applyOwnerProfileConfig } = await import(process.argv[3]);
		data.lockAuthentication.privateKey = fs.readFileSync(data.paths.keysDir + '/device.key');
		applyOwnerProfileConfig({ ...data, assertRuntime() {} });
	`;
		const data = {
			...input,
			lockAuthentication: { ...input.lockAuthentication, privateKey: undefined },
		};
		// Act: the process exits without running writer cleanup, then the same operation resumes.
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
		const record = JSON.parse(readFileSync(lockPath(), "utf8"));
		expect(record.pid).toBe(child.pid);
		expect(record.mac).toMatch(/^[a-f0-9]{64}$/);
		expect(() => process.kill(record.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		if (boundary === "published") expect(configText()).toBe(beforeConfig);
		else expect(JSON.parse(configText()).actor_id).toBe("identity");
		applyOwnerProfileConfig({ ...input, snapshot: ownerFileSnapshot(input.paths.configPath) });
		// Assert: config changes only as intended and private key bytes survive both crashes.
		expect(JSON.parse(configText())).toEqual({
			actor_id: "identity",
			unrelated: { keep: [1, 2] },
			sync_coordinator_url: input.coordinatorOrigin,
			sync_coordinator_group: "group",
		});
		expect(readFileSync(join(input.paths.keysDir, "device.key"))).toEqual(beforeKey);
		expect(existsSync(lockPath())).toBe(false);
	},
);

it.each(["empty", "generic", "foreign", "unverifiable", "live", "reused PID", "inaccessible PID"])(
	"preserves a %s lock and refuses config recovery",
	(kind) => {
		// Arrange: even a dead PID is insufficient without exact authenticated ownership.
		const record = authenticatedLock(process.pid);
		let text = JSON.stringify(record);
		if (kind === "empty") text = "";
		if (kind === "generic") text = JSON.stringify({ pid: process.pid });
		if (kind === "foreign") text = JSON.stringify({ ...record, operation: "a".repeat(64) });
		if (kind === "unverifiable") text = JSON.stringify({ ...record, mac: "0".repeat(64) });
		writeFileSync(lockPath(), text, { mode: 0o600 });
		const before = configText();
		const abandoned = `${lockPath()}.tmp-abandoned`;
		writeFileSync(abandoned, "crashed writer", { mode: 0o600 });
		const abandonedSnapshot = ownerFileSnapshot(abandoned);
		const check = vi.spyOn(process, "kill");
		if (kind === "inaccessible PID")
			check.mockImplementation(() => {
				throw Object.assign(new Error("unverifiable"), { code: "EPERM" });
			});
		else check.mockReturnValue(true);
		// Act: a competing writer must fail rather than taking someone else's lock.
		expect(() => applyOwnerProfileConfig(input)).toThrow();
		// Assert: neither config nor lock was removed or rewritten.
		expect(configText()).toBe(before);
		expect(readFileSync(lockPath(), "utf8")).toBe(text);
		expect(lockArtifacts()).toEqual(["config.json.lock.tmp-abandoned"]);
		expect(ownerFileSnapshot(abandoned)).toEqual(abandonedSnapshot);
		if (["empty", "generic", "foreign", "unverifiable"].includes(kind))
			expect(check).not.toHaveBeenCalled();
	},
);

it("refuses an authenticated dead lock for a different operation tuple", () => {
	// Arrange: this is a valid HMAC for another binding, not merely a damaged MAC.
	const auth = input.lockAuthentication;
	if (!auth) throw new Error("missing fixture authentication");
	const record = authenticatedLock(process.pid);
	writeFileSync(lockPath(), JSON.stringify(record), { mode: 0o600 });
	const before = configText();
	const check = deadCheck();
	// Act: the same key cannot authorize an unrelated adoption operation.
	expect(() =>
		applyOwnerProfileConfig({
			...input,
			lockAuthentication: { ...auth, bindingId: "other-binding" },
		}),
	).toThrow();
	// Assert: operation mismatch stops before probing or removing the writer.
	expect(check).not.toHaveBeenCalled();
	expect(configText()).toBe(before);
	expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toEqual(record);
	expect(lockArtifacts()).toEqual([]);
});

it("keeps a raced writer's replacement inode between dead check and reclaim", () => {
	// Arrange: another writer publishes byte-identical content on a different inode.
	const text = JSON.stringify(authenticatedLock(process.pid));
	writeFileSync(lockPath(), text, { mode: 0o600 });
	const replacement = `${lockPath()}.replacement`;
	writeFileSync(replacement, text, { mode: 0o600 });
	const replacementSnapshot = ownerFileSnapshot(replacement);
	const before = configText();
	vi.spyOn(process, "kill").mockImplementation(() => {
		renameSync(replacement, lockPath());
		throw Object.assign(new Error("old writer dead"), { code: "ESRCH" });
	});
	// Act: reclaim must recheck the inode, not only the authenticated bytes.
	expect(() => applyOwnerProfileConfig(input)).toThrow();
	// Assert: the raced writer never loses its new lock.
	expect(ownerFileSnapshot(lockPath()).ino).toBe(replacementSnapshot.ino);
	expect(configText()).toBe(before);
	expect(lockArtifacts()).toEqual([]);
});

it("does not release a replacement lock when the writer loses ownership", () => {
	// Arrange: a writer replaces the acquired lock during config CAS.
	const replacement = JSON.stringify(authenticatedLock(process.pid));
	const before = configText();
	vi.spyOn(configWriter, "atomicReplaceConfigFile").mockImplementationOnce(
		(_path, _text, _mode, _uid, verify) => {
			const other = `${lockPath()}.replacement`;
			writeFileSync(other, replacement, { mode: 0o600 });
			renameSync(other, lockPath());
			verify?.();
		},
	);
	// Act: both CAS and cleanup must refuse the competing inode.
	expect(() => applyOwnerProfileConfig(input)).toThrow();
	// Assert: failure cleanup never unlinks the winning writer's lock.
	expect(readFileSync(lockPath(), "utf8")).toBe(replacement);
	expect(configText()).toBe(before);
});

it("preserves a writer that wins exclusive creation immediately after reclaim", () => {
	// Arrange: authentic dead ownership permits reclaim, but not overwriting a new writer.
	writeFileSync(lockPath(), JSON.stringify(authenticatedLock(process.pid)), { mode: 0o600 });
	const winner = JSON.stringify(authenticatedLock(process.pid));
	const before = configText();
	deadCheck();
	vi.mocked(unlinkSync).mockImplementation((path) => {
		realUnlink(path);
		if (path === lockPath()) writeFileSync(lockPath(), winner, { mode: 0o600 });
	});
	// Act: another writer creates its lock before recovery's exclusive open.
	expect(() => applyOwnerProfileConfig(input)).toThrow();
	// Assert: the losing recovery attempt cannot remove or replace the winner's lock.
	expect(readFileSync(lockPath(), "utf8")).toBe(winner);
	expect(configText()).toBe(before);
	expect(lockArtifacts()).toEqual([]);
});

it.each(["opened", "partial"])(
	"leaves no named lock when killed after initializer %s",
	(boundary) => {
		// Arrange: interrupt only the real writer's initialization, before lock publication.
		const beforeConfig = configText();
		const beforeKey = readFileSync(join(input.paths.keysDir, "device.key"));
		const beforeDatabase = readFileSync(input.paths.dbPath);
		const data = {
			...input,
			lockAuthentication: { ...input.lockAuthentication, privateKey: undefined },
		};
		const script = `
		import fs from 'node:fs';
		import { syncBuiltinESMExports } from 'node:module';
		const data = JSON.parse(process.argv[1]);
		const lock = data.paths.configPath + '.lock';
		let initializer;
		const open = fs.openSync;
		fs.openSync = (path, flags, mode) => {
			const fd = open(path, flags, mode);
			if (flags === 'wx' && String(path).startsWith(lock)) {
				initializer = fd;
				if (process.argv[2] === 'opened') process.kill(process.pid, 'SIGKILL');
			}
			return fd;
		};
		const write = fs.writeFileSync;
		fs.writeFileSync = (path, text, options) => {
			if (process.argv[2] === 'partial' && path === initializer) {
				write(path, String(text).slice(0, 19), options);
				process.kill(process.pid, 'SIGKILL');
			}
			return write(path, text, options);
		};
		syncBuiltinESMExports();
		const { applyOwnerProfileConfig } = await import(process.argv[3]);
		data.lockAuthentication.privateKey = fs.readFileSync(data.paths.keysDir + '/device.key');
		applyOwnerProfileConfig({ ...data, assertRuntime() {} });
	`;
		// Act: SIGKILL cannot run cleanup, but incomplete bytes must remain unnamed.
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
		// Assert: an abandoned private temp never becomes an unknown canonical lock.
		expect(child.error).toBeUndefined();
		expect(child.signal, child.stderr).toBe("SIGKILL");
		expect(existsSync(lockPath())).toBe(false);
		expect(configText()).toBe(beforeConfig);
		expect(readFileSync(join(input.paths.keysDir, "device.key"))).toEqual(beforeKey);
		expect(readFileSync(input.paths.dbPath)).toEqual(beforeDatabase);
		const artifacts = readdirSync(directory).filter((name) => name.startsWith("config.json.lock"));
		expect(artifacts).toHaveLength(1);
		const artifact = join(directory, artifacts[0] ?? "missing");
		const snapshot = ownerFileSnapshot(artifact);
		expect(lstatSync(artifact).mode & 0o777).toBe(0o600);
		expect(snapshot.text.length).toBe(boundary === "opened" ? 0 : 19);
		applyOwnerProfileConfig(input);
		expect(JSON.parse(configText()).actor_id).toBe("identity");
		expect(existsSync(lockPath())).toBe(false);
		expect(ownerFileSnapshot(artifact)).toEqual(snapshot);
	},
);

it.each(["write ENOSPC", "temp fsync"])(
	"does not strand a named lock after %s fails",
	(failure) => {
		// Arrange: disk failure occurs while initializing the unpublished private lock.
		const before = configText();
		const key = readFileSync(join(input.paths.keysDir, "device.key"));
		const database = readFileSync(input.paths.dbPath);
		const abandoned = `${lockPath()}.tmp-abandoned`;
		writeFileSync(abandoned, "crashed writer", { mode: 0o600 });
		const abandonedSnapshot = ownerFileSnapshot(abandoned);
		if (failure === "write ENOSPC")
			vi.mocked(writeFileSync).mockImplementationOnce(() => {
				throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			});
		else
			vi.mocked(fsyncSync).mockImplementationOnce(() => {
				throw Object.assign(new Error("fsync failed"), { code: "EIO" });
			});
		// Act: initialization failure must not publish an unverifiable lock.
		expect(() => applyOwnerProfileConfig(input)).toThrow();
		// Assert: config, signing key and the retained database/history stay unchanged.
		expect(existsSync(lockPath())).toBe(false);
		expect(configText()).toBe(before);
		expect(readFileSync(join(input.paths.keysDir, "device.key"))).toEqual(key);
		expect(readFileSync(input.paths.dbPath)).toEqual(database);
		expect(lockArtifacts()).toEqual(["config.json.lock.tmp-abandoned"]);
		expect(ownerFileSnapshot(abandoned)).toEqual(abandonedSnapshot);
		applyOwnerProfileConfig(input);
		expect(JSON.parse(configText()).actor_id).toBe("identity");
		expect(existsSync(lockPath())).toBe(false);
		expect(ownerFileSnapshot(abandoned)).toEqual(abandonedSnapshot);
	},
);

it.each([0o640, 0o660])(
	"preserves config mode %s and passes metadata through the observer seeding path",
	(mode) => {
		// Arrange: config permissions need not match the private lock's 0600 mode.
		chmodSync(input.paths.configPath, mode);
		input.snapshot = ownerFileSnapshot(input.paths.configPath);
		const before = lstatSync(input.paths.configPath);
		const replace = configWriter.atomicReplaceConfigFile;
		const seedMetadata = vi.fn((source: string, fd: number) => {
			// The observer's seed hook carries ACLs/xattrs before text truncation and replacement.
			expect(source).toBe(input.paths.configPath);
			actualFs.writeFileSync(fd, configText());
			return true;
		});
		const chown = vi.fn(actualFs.fchownSync);
		const replaceSpy = vi
			.spyOn(configWriter, "atomicReplaceConfigFile")
			.mockImplementation((path, text, metadata, _operations, verify, options) =>
				replace(
					path,
					text,
					metadata,
					{
						open: actualFs.openSync,
						write: actualFs.writeSync,
						sync: actualFs.fsyncSync,
						close: actualFs.closeSync,
						rename: actualFs.renameSync,
						unlink: actualFs.unlinkSync,
						chmod: actualFs.fchmodSync,
						chown,
						truncate: actualFs.ftruncateSync,
						seedMetadata,
					},
					verify,
					options,
				),
			);
		// Act: adoption uses the same atomic writer rather than a numeric-mode bypass.
		applyOwnerProfileConfig(input);
		// Assert: retained ownership, permissions and unrelated fields survive adoption.
		expect(replaceSpy.mock.calls[0]?.[2]).toEqual({ mode, uid: before.uid, gid: before.gid });
		expect(seedMetadata).toHaveBeenCalledOnce();
		const after = lstatSync(input.paths.configPath);
		expect(after.mode & 0o777).toBe(mode);
		if (process.platform !== "win32") {
			expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
			expect(chown).toHaveBeenCalledWith(expect.any(Number), before.uid, before.gid);
		}
		expect(JSON.parse(configText())).toEqual({
			actor_id: "identity",
			unrelated: { keep: [1, 2] },
			sync_coordinator_url: input.coordinatorOrigin,
			sync_coordinator_group: "group",
		});
		expect(existsSync(lockPath())).toBe(false);
	},
);

it("retains the complete canonical lock when hardlink publication succeeds but reports failure", () => {
	// Arrange: an ambiguous syscall result must not authorize deleting the canonical inode.
	const before = configText();
	let published: ReturnType<typeof ownerFileSnapshot> | undefined;
	vi.mocked(linkSync).mockImplementationOnce((temporary, canonical) => {
		actualFs.linkSync(temporary, canonical);
		published = ownerFileSnapshot(String(canonical));
		throw Object.assign(new Error("ambiguous publication"), { code: "EIO" });
	});
	// Act: ambiguous publication must retain both names once the inode has multiple links.
	expect(() => applyOwnerProfileConfig(input)).toThrow();
	// Assert: the complete authenticated canonical bytes remain recoverable.
	expect(configText()).toBe(before);
	expect(lockArtifacts()).toHaveLength(1);
	const retained = ownerFileSnapshot(lockPath());
	expect(retained).toEqual(published);
	expect(ownerFileSnapshot(join(directory, lockArtifacts()[0] ?? "missing"))).toEqual(published);
	expect(lstatSync(lockPath()).nlink).toBe(2);
	expect(JSON.parse(retained.text)).toMatchObject({
		purpose: "owner-profile-config-v1",
		pid: process.pid,
	});
	expect(JSON.parse(retained.text).mac).toMatch(/^[a-f0-9]{64}$/);
});

it("never deletes a replaced initializer inode during handled-error cleanup", () => {
	// Arrange: a different writer replaces our temp name with identical bytes before failure.
	const before = configText();
	let replacementPath = "";
	let replacement: ReturnType<typeof ownerFileSnapshot> | undefined;
	vi.mocked(fsyncSync).mockImplementationOnce((fd) => {
		actualFs.fsyncSync(fd);
		const name = lockArtifacts()[0];
		if (!name) throw new Error("initializer missing");
		replacementPath = join(directory, name);
		const other = join(directory, "replacement");
		actualFs.writeFileSync(other, readFileSync(replacementPath), { mode: 0o600 });
		actualFs.renameSync(other, replacementPath);
		replacement = ownerFileSnapshot(replacementPath);
		throw Object.assign(new Error("fsync failed after replacement"), { code: "EIO" });
	});
	// Act: the driver's inode identity, not equal text, determines cleanup ownership.
	expect(() => applyOwnerProfileConfig(input)).toThrow();
	// Assert: unknown replacement survives unchanged and config never publishes.
	expect(ownerFileSnapshot(replacementPath)).toEqual(replacement);
	expect(configText()).toBe(before);
	expect(existsSync(lockPath())).toBe(false);
});

it("refuses config metadata drift without changing permissions or unrelated content", () => {
	// Arrange: another writer changes permissions after adoption captures its config snapshot.
	const before = configText();
	chmodSync(input.paths.configPath, 0o640);
	const changed = ownerFileSnapshot(input.paths.configPath);
	const replace = vi.spyOn(configWriter, "atomicReplaceConfigFile");
	// Act: config CAS must reject metadata drift before attempting replacement.
	expect(() => applyOwnerProfileConfig(input)).toThrow();
	// Assert: the winning metadata survives, and this attempt leaves no lock artifacts.
	expect(replace).not.toHaveBeenCalled();
	expect(ownerFileSnapshot(input.paths.configPath)).toEqual(changed);
	expect(configText()).toBe(before);
	expect(lstatSync(input.paths.configPath).mode & 0o777).toBe(0o640);
	expect(existsSync(lockPath())).toBe(false);
	expect(lockArtifacts()).toEqual([]);
});

it("publishes complete private lock bytes and snapshots only after removing the temporary hardlink", () => {
	// Arrange: hardlink creation/removal changes ctime; a premature snapshot breaks CAS.
	const auth = input.lockAuthentication;
	if (!auth) throw new Error("missing fixture authentication");
	vi.mocked(openSync).mockClear();
	vi.mocked(fsyncSync).mockClear();
	let published = false;
	vi.mocked(linkSync).mockImplementation((temporary, canonical) => {
		if (canonical === lockPath()) {
			const record = JSON.parse(readFileSync(temporary, "utf8"));
			expect(record).toMatchObject({ purpose: "owner-profile-config-v1", pid: process.pid });
			expect(record.mac).toMatch(/^[0-9a-f]{64}$/);
			expect(record.operation).toBe(authenticatedLock(process.pid).operation);
			expect(record.mac).toBe(
				createHmac("sha256", auth.privateKey)
					.update(
						JSON.stringify([
							"owner-profile-config-lock-v1",
							record.purpose,
							record.token,
							record.pid,
							record.operation,
						]),
					)
					.digest("hex"),
			);
			expect(lstatSync(temporary).mode & 0o777).toBe(0o600);
			const opened = vi.mocked(openSync).mock.calls.findIndex(([path]) => path === temporary);
			expect(opened).toBeGreaterThanOrEqual(0);
			expect(fsyncSync).toHaveBeenCalledWith(vi.mocked(openSync).mock.results[opened]?.value);
			published = true;
		}
		actualFs.linkSync(temporary, canonical);
	});
	const replace = configWriter.atomicReplaceConfigFile;
	vi.spyOn(configWriter, "atomicReplaceConfigFile").mockImplementation((...args) => {
		expect(lstatSync(lockPath()).nlink).toBe(1);
		return replace(...args);
	});
	// Act: normal publication must survive ctime changes without losing its own lock.
	applyOwnerProfileConfig(input);
	// Assert: publication is atomic and normal config CAS/release succeeds.
	expect(published).toBe(true);
	expect(lstatSync(directory).mode & 0o777).toBe(0o700);
	expect(lstatSync(input.paths.keysDir).mode & 0o777).toBe(0o700);
	expect(lstatSync(input.paths.stateDir).mode & 0o777).toBe(0o700);
	expect(lstatSync(join(input.paths.keysDir, "device.key")).mode & 0o777).toBe(0o600);
	expect(JSON.parse(configText())).toMatchObject({
		actor_id: "identity",
		unrelated: { keep: [1, 2] },
	});
	expect(existsSync(lockPath())).toBe(false);
});

const statePath = () => join(input.paths.stateDir, "prepared.json");
const stateArtifacts = () =>
	readdirSync(input.paths.stateDir).filter((name) => name.startsWith("prepared.json.tmp-"));

it("syncs the private staged state directory entry before publishing the canonical hardlink", () => {
	// Arrange: file fsync alone does not make the temporary directory entry durable.
	const events: string[] = [];
	const value = { purpose: "retained-state-fixture", pid: process.pid, mac: "b".repeat(64) };
	vi.mocked(fsyncSync).mockImplementation((fd) => {
		events.push(fstatSync(fd).isDirectory() ? "directory sync" : "file sync");
		actualFs.fsyncSync(fd);
	});
	vi.mocked(linkSync).mockImplementation((temporary, canonical) => {
		events.push("publish");
		expect(JSON.parse(readFileSync(temporary, "utf8"))).toEqual(value);
		expect(lstatSync(temporary).mode & 0o777).toBe(0o600);
		actualFs.linkSync(temporary, canonical);
	});
	// Act: retain a new private state record.
	retainOwnerState(statePath(), value);
	// Assert: publication follows both file and staged-name durability, then removes its alias.
	expect(events.slice(0, 3)).toEqual(["file sync", "directory sync", "publish"]);
	expect(events.slice(3)).toContain("directory sync");
	expect(JSON.parse(readFileSync(statePath(), "utf8"))).toEqual(value);
	expect(lstatSync(statePath()).mode & 0o777).toBe(0o600);
	expect(lstatSync(statePath()).nlink).toBe(1);
	expect(stateArtifacts()).toEqual([]);
});

it.each(["link reports failure", "canonical directory sync fails"])(
	"keeps the verified durable staged name when %s after state publication",
	(failure) => {
		// Arrange: canonical publication is ambiguous until its directory sync succeeds.
		const value = { purpose: "retained-state-fixture", pid: process.pid, mac: "c".repeat(64) };
		let staged = "";
		let stagedDirectorySynced = false;
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			if (fstatSync(fd).isDirectory()) {
				if (existsSync(statePath())) throw new Error("canonical directory sync failed");
				stagedDirectorySynced = true;
			}
			actualFs.fsyncSync(fd);
		});
		vi.mocked(linkSync).mockImplementation((temporary, canonical) => {
			staged = String(temporary);
			actualFs.linkSync(temporary, canonical);
			if (failure === "link reports failure") throw new Error("ambiguous link result");
		});
		// Act: a failed publication cannot justify unlinking the only durable name.
		expect(() => retainOwnerState(statePath(), value)).toThrow();
		// Assert: both names still reference the same complete private inode.
		expect(stagedDirectorySynced).toBe(true);
		expect(existsSync(staged)).toBe(true);
		expect(JSON.parse(readFileSync(staged, "utf8"))).toEqual(value);
		expect(lstatSync(staged).ino).toBe(lstatSync(statePath()).ino);
		expect(lstatSync(staged).mode & 0o777).toBe(0o600);
		expect(unlinkSync).not.toHaveBeenCalledWith(staged);
		expect(unlinkSync).not.toHaveBeenCalledWith(statePath());
	},
);

it.each(["cyclic serialization", "write ENOSPC", "file fsync", "close"])(
	"cleans only its verified unpublished state inode after %s fails",
	(failure) => {
		// Arrange: unknown artifacts are never owned by this new invocation.
		const unknown = `${statePath()}.tmp-unknown`;
		writeFileSync(unknown, "interrupted private artifact", { mode: 0o600 });
		const before = ownerFileSnapshot(unknown);
		const config = ownerFileSnapshot(input.paths.configPath);
		const key = readFileSync(join(input.paths.keysDir, "device.key"));
		const database = ownerFileSnapshot(input.paths.dbPath);
		let stagedFd: number | undefined;
		let stagedIdentity: { dev: number; ino: number } | undefined;
		const value: Record<string, unknown> = { purpose: "retained-state-fixture" };
		if (failure === "cyclic serialization") value.self = value;
		if (failure === "write ENOSPC")
			vi.mocked(writeFileSync).mockImplementationOnce(() => {
				throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			});
		if (failure === "file fsync")
			vi.mocked(fsyncSync).mockImplementationOnce(() => {
				throw new Error("file fsync failed");
			});
		if (failure === "close")
			vi.mocked(closeSync).mockImplementation((fd) => {
				const node = actualFs.fstatSync(fd);
				if (node.isDirectory()) return actualFs.closeSync(fd);
				stagedFd = fd;
				stagedIdentity = { dev: node.dev, ino: node.ino };
				const staged = join(
					input.paths.stateDir,
					stateArtifacts().find((name) => name !== "prepared.json.tmp-unknown") ?? "missing",
				);
				expect(lstatSync(staged)).toMatchObject(stagedIdentity);
				actualFs.closeSync(fd);
				throw new Error("close failed after closing");
			});
		vi.mocked(closeSync).mockClear();
		try {
			// Act: ordinary handled failure cleans the invocation's unpublished inode.
			expect(() => retainOwnerState(statePath(), value)).toThrow();
			// Assert: only the pre-existing unknown name remains, byte/inode unchanged.
			expect(existsSync(statePath())).toBe(false);
			expect(stateArtifacts()).toEqual(["prepared.json.tmp-unknown"]);
			expect(ownerFileSnapshot(unknown)).toEqual(before);
			expect(ownerFileSnapshot(input.paths.configPath)).toEqual(config);
			expect(readFileSync(join(input.paths.keysDir, "device.key"))).toEqual(key);
			expect(ownerFileSnapshot(input.paths.dbPath)).toEqual(database);
			if (failure === "close") {
				expect(stagedFd).toEqual(expect.any(Number));
				expect(stagedIdentity).toBeDefined();
				expect(vi.mocked(closeSync).mock.calls.filter(([fd]) => fd === stagedFd)).toHaveLength(1);
			}
		} finally {
			vi.mocked(closeSync).mockImplementation(actualFs.closeSync);
		}
	},
);

it("preserves a replacement staged state inode during handled failure cleanup", () => {
	// Arrange: equal bytes on a different inode do not prove ownership of a temp name.
	let staged = "";
	let replacement: ReturnType<typeof ownerFileSnapshot> | undefined;
	vi.mocked(fsyncSync).mockImplementationOnce((fd) => {
		actualFs.fsyncSync(fd);
		staged = join(input.paths.stateDir, stateArtifacts()[0] ?? "missing");
		const other = join(input.paths.stateDir, "replacement");
		actualFs.writeFileSync(other, readFileSync(staged), { mode: 0o600 });
		actualFs.renameSync(other, staged);
		replacement = ownerFileSnapshot(staged);
		throw new Error("file fsync reports failure after replacement");
	});
	// Act: initialization fails after the invocation loses ownership of its staged name.
	expect(() => retainOwnerState(statePath(), { keep: true })).toThrow();
	// Assert: cleanup must not remove a different writer's inode.
	expect(ownerFileSnapshot(staged)).toEqual(replacement);
	expect(existsSync(statePath())).toBe(false);
	expect(unlinkSync).not.toHaveBeenCalledWith(staged);
});

it("refuses to overwrite existing retained state and preserves private publication evidence", () => {
	// Arrange: existing state is immutable even if this invocation has different bytes.
	writeFileSync(statePath(), JSON.stringify({ saved: true }), { mode: 0o600 });
	const before = ownerFileSnapshot(statePath());
	// Act: create-only publication loses to the retained canonical name.
	expect(() => retainOwnerState(statePath(), { saved: false })).toThrow();
	// Assert: a publication error never removes the canonical inode or its staged evidence.
	expect(ownerFileSnapshot(statePath())).toEqual(before);
	expect(stateArtifacts()).toHaveLength(1);
	const staged = join(input.paths.stateDir, stateArtifacts()[0] ?? "missing");
	expect(JSON.parse(readFileSync(staged, "utf8"))).toEqual({ saved: false });
	expect(lstatSync(staged).mode & 0o777).toBe(0o600);
	expect(unlinkSync).not.toHaveBeenCalledWith(statePath());
});

it.each(["opened", "partial", "staged directory synced"])(
	"retains an unknown private state artifact after a crash at %s without force-deleting it",
	(boundary) => {
		// Arrange: kill only this fixture process at a real primitive staging boundary.
		const script = `
			import fs from 'node:fs';
			import { syncBuiltinESMExports } from 'node:module';
			const path = process.argv[1], boundary = process.argv[2];
			let stagedFd;
			const open = fs.openSync;
			fs.openSync = (name, flags, mode) => {
				const fd = open(name, flags, mode);
				if (flags === 'wx' && String(name).startsWith(path + '.tmp-')) {
					stagedFd = fd;
					if (boundary === 'opened') process.kill(process.pid, 'SIGKILL');
				}
				return fd;
			};
			const write = fs.writeFileSync;
			fs.writeFileSync = (fd, bytes, options) => {
				if (fd === stagedFd && boundary === 'partial') {
					write(fd, String(bytes).slice(0, 19), options);
					process.kill(process.pid, 'SIGKILL');
				}
				return write(fd, bytes, options);
			};
			const sync = fs.fsyncSync;
			fs.fsyncSync = (fd) => {
				sync(fd);
				if (boundary === 'staged directory synced' && fs.fstatSync(fd).isDirectory() && !fs.existsSync(path)) process.kill(process.pid, 'SIGKILL');
			};
			syncBuiltinESMExports();
			const { retainOwnerState } = await import(process.argv[3]);
			retainOwnerState(path, { purpose: 'retained-state-fixture', pid: process.pid, mac: 'd'.repeat(64) });
		`;
		// Act: process death cannot run ordinary unpublished-temp cleanup.
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				script,
				statePath(),
				boundary,
				new URL("./coordinator-owner-profile-files.ts", import.meta.url).href,
			],
			{ timeout: 10000, encoding: "utf8" },
		);
		// Assert: the unknown private artifact remains untouched by a subsequent publication.
		expect(child.error).toBeUndefined();
		expect(child.signal, child.stderr).toBe("SIGKILL");
		expect(existsSync(statePath())).toBe(false);
		expect(stateArtifacts()).toHaveLength(1);
		const artifact = join(input.paths.stateDir, stateArtifacts()[0] ?? "missing");
		const before = ownerFileSnapshot(artifact);
		expect(lstatSync(artifact).mode & 0o777).toBe(0o600);
		if (boundary === "opened") expect(before.text).toBe("");
		if (boundary === "partial") expect(before.text).toHaveLength(19);
		if (boundary === "staged directory synced")
			expect(JSON.parse(before.text)).toMatchObject({ pid: child.pid, mac: "d".repeat(64) });
		retainOwnerState(statePath(), { retry: true });
		expect(ownerFileSnapshot(artifact)).toEqual(before);
		expect(JSON.parse(readFileSync(statePath(), "utf8"))).toEqual({ retry: true });
	},
);
