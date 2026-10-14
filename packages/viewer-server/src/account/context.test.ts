import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountContextReader } from "../index.js";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	for (const name of [
		"CODEMEM_ACTOR_ID",
		"CODEMEM_DEVICE_ID",
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_SYNC_COORDINATOR_GROUPS",
	])
		vi.stubEnv(name, undefined);
	const dir = mkdtempSync(join(tmpdir(), "account-context-test-"));
	dirs.push(dir);
	const dbPath = join(dir, "fixture.sqlite");
	const publicKey = "ssh-ed25519 Zml4dHVyZS1wdWJsaWMta2V5 fixture";
	const fingerprint = createHash("sha256").update(publicKey).digest("hex");
	const db = new Database(dbPath);
	db.exec(
		"CREATE TABLE sync_device(device_id TEXT, public_key TEXT, fingerprint TEXT); CREATE TABLE actors(actor_id TEXT); CREATE TABLE memories(id INTEGER, text TEXT)",
	);
	db.prepare("INSERT INTO sync_device VALUES (?, ?, ?)").run("device-a", publicKey, fingerprint);
	db.prepare("INSERT INTO actors VALUES (?)").run("local:device-a");
	db.close();
	const profile = {
		dbPath,
		deviceId: "device-a",
		identityId: "local:device-a",
		identityLabel: "Fixture user",
		deviceLabel: "Fixture laptop",
	};
	const config: Record<string, unknown> = {
		sync_coordinator_url: "https://coordinator.example.test",
		sync_coordinator_groups: ["group-a"],
	};
	const getProfile = vi.fn((): typeof profile | null => profile);
	const read = createAccountContextReader({
		getProfile,
		readConfig: () => config,
		configPath: join(dir, "config.json"),
		keysDir: join(dir, "keys"),
	});
	return { dir, dbPath, profile, config, getProfile, read, fingerprint };
}
describe("running account context", () => {
	it("reads the explicit profile without changing schema, rows, keys or database bytes", () => {
		// Arrange: no MemoryStore, migrations, default profile or keys exist.
		const f = fixture();
		const before = readFileSync(f.dbPath);
		const files = readdirSync(f.dir);
		const first = f.read(); // Act
		const second = f.read();
		// Assert
		expect(first).toMatchObject({
			setup: "ready",
			context: { deviceId: "device-a", identityId: "local:device-a", fingerprint: f.fingerprint },
		});
		expect("context" in second && second.context?.contextId).toBe(
			"context" in first && first.context?.contextId,
		);
		expect(readFileSync(f.dbPath)).toEqual(before);
		expect(readdirSync(f.dir)).toEqual(files);
		expect(JSON.stringify(first)).not.toContain("ssh-ed25519");
	});
	it.each(["missing-profile", "missing-device", "wrong-device", "wrong-actor", "blank-actor"])(
		"fails closed for %s",
		(scenario) => {
			const f = fixture(); // Arrange
			if (scenario === "missing-profile") f.getProfile.mockReturnValue(null);
			if (scenario === "missing-device") f.profile.dbPath = join(f.dir, "missing.sqlite");
			if (scenario === "wrong-device") vi.stubEnv("CODEMEM_DEVICE_ID", "device-other");
			if (scenario === "wrong-actor") vi.stubEnv("CODEMEM_ACTOR_ID", "actor-other");
			if (scenario === "blank-actor") {
				f.config.actor_id = "actor-config";
				f.profile.identityId = "actor-config";
				vi.stubEnv("CODEMEM_ACTOR_ID", " ");
			}
			const context = f.read(); // Act
			expect("setup" in context && context.setup).not.toBe("ready"); // Assert
			expect(readdirSync(f.dir)).toEqual(["fixture.sqlite"]);
		},
	);
	it.each(["config", "env", "blank-env", "blank-device-env", "whitespace-device-env"])(
		"resolves actor/device precedence from %s",
		(source) => {
			const f = fixture(); // Arrange
			if (source === "blank-device-env") vi.stubEnv("CODEMEM_DEVICE_ID", " ");
			if (source === "whitespace-device-env") vi.stubEnv("CODEMEM_DEVICE_ID", " device-a ");
			f.config.actor_id = "actor-config";
			f.profile.identityId = "actor-config";
			if (source === "env") {
				vi.stubEnv("CODEMEM_ACTOR_ID", "actor-env");
				f.profile.identityId = "actor-env";
			}
			if (source === "blank-env") {
				vi.stubEnv("CODEMEM_ACTOR_ID", " ");
				f.profile.identityId = "local:device-a";
			}
			const result = f.read(); // Act
			expect(result).toMatchObject({ setup: "ready" }); // Assert
		},
	);
});
describe("account configuration and freshness", () => {
	it.each([
		["", "coordinator_not_configured"],
		["http://remote.example.test", "coordinator_url_invalid"],
	])("classifies coordinator %s", (url, setup) => {
		const f = fixture(); // Arrange
		f.config.sync_coordinator_url = url;
		const result = f.read(); // Act
		expect(result).toMatchObject({ setup }); // Assert
	});
	it("reports no configured groups as missing coordinator setup", () => {
		const f = fixture(); // Arrange
		f.config.sync_coordinator_groups = [];
		const result = f.read(); // Act
		expect(result).toMatchObject({
			setup: "coordinator_not_configured",
			groups: [],
			context: null,
		}); // Assert
	});
	it("uses coordinator environment overrides and omits unsafe display labels", () => {
		const f = fixture(); // Arrange
		vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "https://env.example.test");
		vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", "env-group");
		f.profile.identityLabel = "unsafe\nlabel";
		f.profile.deviceLabel = "unsafe\u202elabel";
		const result = f.read(); // Act
		expect(result).toMatchObject({
			setup: "ready",
			groups: ["env-group"],
			coordinator: { origin: "https://env.example.test" },
			context: { identityLabel: undefined, deviceLabel: undefined },
		}); // Assert
	});
	it("requires explicit selection among deduplicated configured groups and rejects unknown groups", () => {
		const f = fixture(); // Arrange
		f.config.sync_coordinator_groups = ["group-a", "group-b", "group-a"];
		const ambiguous = f.read(); // Act
		const selected = f.read("group-b");
		expect(ambiguous).toMatchObject({ setup: "group_selection_required" }); // Assert
		expect(selected).toMatchObject({ setup: "ready", selectedGroupId: "group-b" });
		expect("groups" in selected && selected.groups).toEqual(["group-a", "group-b"]);
		expect(f.read("unknown")).toEqual({ error: "account_group_not_configured" });
	});
	it.each([["x".repeat(257)], ["bad\nvalue"], Array.from({ length: 26 }, (_, i) => `group-${i}`)])(
		"does not truncate invalid group configuration",
		(...groups) => {
			const f = fixture(); // Arrange
			f.config.sync_coordinator_groups = groups.flat();
			const result = f.read(); // Act
			expect(result).toEqual({ error: "account_context_unavailable" }); // Assert
		},
	);
	it("ignores ordinary capture writes and mtime but detects database inode replacement", () => {
		const f = fixture(); // Arrange
		const initial = f.read();
		if (!("context" in initial) || !initial.context) throw new Error("Expected ready fixture");
		const original = initial.context.contextId;
		const db = new Database(f.dbPath);
		db.exec("INSERT INTO memories VALUES (1, 'fixture capture')");
		db.close();
		utimesSync(f.dbPath, 100, 100);
		const captured = f.read(); // Act
		renameSync(f.dbPath, join(f.dir, "previous.sqlite"));
		copyFileSync(join(f.dir, "previous.sqlite"), f.dbPath);
		const replaced = f.read();
		expect("context" in captured && captured.context?.contextId).toBe(original); // Assert
		expect(replaced).toMatchObject({ setup: "ready" });
		expect("context" in replaced && replaced.context?.contextId).not.toBe(original);
	});
	it.each(["key", "device", "actor", "coordinator"])(
		"invalidates context when %s changes",
		(change) => {
			const f = fixture(); // Arrange
			const initial = f.read();
			if (!("context" in initial) || !initial.context) throw new Error("Expected ready fixture");
			// Act
			if (change === "coordinator") f.config.sync_coordinator_url = "https://new.example.test";
			if (change === "actor") {
				f.config.actor_id = "actor-new";
				f.profile.identityId = "actor-new";
			}
			const db = new Database(f.dbPath);
			if (change === "key") {
				const key = "ssh-ed25519 cHVibGljLWZpeHR1cmUtdHdv fixture";
				db.prepare("UPDATE sync_device SET public_key=?, fingerprint=?").run(
					key,
					createHash("sha256").update(key).digest("hex"),
				);
			}
			if (change === "device") db.exec("UPDATE sync_device SET device_id='device-other'");
			db.close();
			const current = f.read();
			// Assert
			expect("context" in current && current.context?.contextId).not.toBe(
				initial.context.contextId,
			);
		},
	);
});
