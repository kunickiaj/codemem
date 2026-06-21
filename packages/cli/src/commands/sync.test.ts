import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	fingerprintPublicKey,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
	startMaintenanceJob,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { buildCoordinatorCommand } from "./coordinator.js";
import { syncCommand } from "./sync.js";
import {
	buildServeLifecycleArgs,
	collectAdvertiseAddresses,
	formatSyncAttempt,
	formatSyncOnceResult,
	parseProjectList,
} from "./sync-helpers.js";

describe("formatSyncAttempt", () => {
	it("matches the compact Python-era output shape", () => {
		expect(
			formatSyncAttempt({
				peer_device_id: "peer-1",
				ok: 1,
				ops_in: 3,
				ops_out: 5,
				error: null,
				finished_at: "2026-03-18T20:00:00Z",
			}),
		).toBe("peer-1|ok|in=3|out=5|2026-03-18T20:00:00Z");
	});

	it("includes the error suffix when present", () => {
		expect(
			formatSyncAttempt({
				peer_device_id: "peer-2",
				ok: 0,
				ops_in: 0,
				ops_out: 1,
				error: "timeout",
				finished_at: "2026-03-18T21:00:00Z",
			}),
		).toBe("peer-2|error|in=0|out=1|2026-03-18T21:00:00Z | timeout");
	});

	it("builds sync start as a background serve invocation using the current runner", () => {
		expect(
			buildServeLifecycleArgs(
				"start",
				{ dbPath: "/tmp/test.sqlite", host: "127.0.0.1", port: "7337" },
				"/repo/packages/cli/src/index.ts",
				["--conditions", "source"],
			),
		).toEqual([
			"--conditions",
			"source",
			"/repo/packages/cli/src/index.ts",
			"serve",
			"--restart",
			"--db-path",
			"/tmp/test.sqlite",
			"--host",
			"127.0.0.1",
			"--port",
			"7337",
		]);
	});

	it("builds sync start without host/port when not explicitly provided", () => {
		expect(
			buildServeLifecycleArgs(
				"start",
				{ dbPath: "/tmp/test.sqlite" },
				"/repo/packages/cli/src/index.ts",
				["--conditions", "source"],
			),
		).toEqual([
			"--conditions",
			"source",
			"/repo/packages/cli/src/index.ts",
			"serve",
			"--restart",
			"--db-path",
			"/tmp/test.sqlite",
		]);
	});

	it("passes config path through sync lifecycle args", () => {
		expect(
			buildServeLifecycleArgs(
				"start",
				{ dbPath: "/tmp/test.sqlite", config: "/tmp/workspace-config.json" },
				"/repo/packages/cli/src/index.ts",
				[],
			),
		).toEqual([
			"/repo/packages/cli/src/index.ts",
			"serve",
			"--restart",
			"--db-path",
			"/tmp/test.sqlite",
			"--config",
			"/tmp/workspace-config.json",
		]);
	});

	it("builds sync restart as a serve restart invocation", () => {
		expect(
			buildServeLifecycleArgs(
				"restart",
				{ dbPath: "/tmp/test.sqlite" },
				"/repo/packages/cli/src/index.ts",
				[],
			),
		).toEqual([
			"/repo/packages/cli/src/index.ts",
			"serve",
			"--restart",
			"--db-path",
			"/tmp/test.sqlite",
		]);
	});

	it("formats sync once success output like the Python command", () => {
		expect(formatSyncOnceResult("peer-1", { ok: true })).toBe("- peer-1: ok");
	});

	it("formats sync once error output like the Python command", () => {
		expect(formatSyncOnceResult("peer-2", { ok: false, error: "timeout" })).toBe(
			"- peer-2: error: timeout",
		);
	});

	it("parses comma-separated project filter lists", () => {
		expect(parseProjectList("foo, bar ,baz")).toEqual(["foo", "bar", "baz"]);
	});

	it("drops empty project filter entries", () => {
		expect(parseProjectList("foo, , ,bar")).toEqual(["foo", "bar"]);
	});

	it("collects advertise addresses from non-loopback interfaces when host is unspecified", () => {
		expect(
			collectAdvertiseAddresses(null, "0.0.0.0", 7337, {
				lo0: [{ address: "127.0.0.1", internal: true, family: "IPv4" }],
				en0: [{ address: "192.168.1.10", internal: false, family: "IPv4" }],
			}),
		).toEqual(["192.168.1.10:7337"]);
	});

	it("brackets configured IPv6 advertise hosts", () => {
		expect(collectAdvertiseAddresses(null, "fd00::1", 7337, {})).toEqual(["[fd00::1]:7337"]);
	});

	it("brackets IPv6 interface advertise addresses", () => {
		expect(
			collectAdvertiseAddresses(null, "0.0.0.0", 7337, {
				utun0: [{ address: "fd00::2", internal: false, family: "IPv6" }],
			}),
		).toEqual(["[fd00::2]:7337"]);
	});

	it("registers coordinator parity subcommands", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");
		expect(coordinator).toBeDefined();
		expect(coordinator?.commands.map((command) => command.name())).toEqual([
			"group-create",
			"list-groups",
			"enroll-device",
			"list-devices",
			"list-scopes",
			"create-scope",
			"update-scope",
			"list-scope-members",
			"grant-scope-member",
			"revoke-scope-member",
			"rename-device",
			"disable-device",
			"remove-device",
			"serve",
			"list-bootstrap-grants",
			"revoke-bootstrap-grant",
			"create-invite",
			"import-invite",
			"list-join-requests",
			"approve-join-request",
			"deny-join-request",
		]);
	});

	it("documents the coordinator command surface in help output", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");
		const help = coordinator?.helpInformation() ?? "";
		expect(help).toContain("group-create");
		expect(help).toContain("list-groups");
		expect(help).toContain("enroll-device");
		expect(help).toContain("list-devices");
		expect(help).toContain("list-scopes");
		expect(help).toContain("create-scope");
		expect(help).toContain("update-scope");
		expect(help).toContain("list-scope-members");
		expect(help).toContain("grant-scope-member");
		expect(help).toContain("revoke-scope-member");
		expect(help).toContain("rename-device");
		expect(help).toContain("disable-device");
		expect(help).toContain("remove-device");
		expect(help).toContain("serve");
		expect(help).toContain("create-invite");
		expect(help).toContain("import-invite");
		expect(help).toContain("list-join-requests");
		expect(help).toContain("approve-join-request");
		expect(help).toContain("deny-join-request");
	});

	it("manages Sharing domains through coordinator CLI JSON commands", async () => {
		const tmpDbDir = mkdtempSync(join(tmpdir(), "coordinator-scope-cli-test-"));
		const dbPath = join(tmpDbDir, "coordinator.sqlite");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const prevExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			const devicePublicKey = "test-public-key-device-a";
			await buildCoordinatorCommand().parseAsync(
				["group-create", "team-a", "--db-path", dbPath, "--json"],
				{ from: "user" },
			);
			await buildCoordinatorCommand().parseAsync(
				[
					"enroll-device",
					"team-a",
					"device-a",
					"--fingerprint",
					fingerprintPublicKey(devicePublicKey),
					"--public-key",
					devicePublicKey,
					"--db-path",
					dbPath,
					"--json",
				],
				{ from: "user" },
			);
			logSpy.mockClear();
			await buildCoordinatorCommand().parseAsync(
				[
					"create-scope",
					"team-a",
					"scope-acme",
					"--label",
					"Acme Work",
					"--membership-epoch",
					"2",
					"--db-path",
					dbPath,
					"--json",
				],
				{ from: "user" },
			);
			await buildCoordinatorCommand().parseAsync(
				[
					"grant-scope-member",
					"team-a",
					"scope-acme",
					"device-a",
					"--role",
					"admin",
					"--db-path",
					dbPath,
					"--json",
				],
				{ from: "user" },
			);
			await buildCoordinatorCommand().parseAsync(
				["list-scope-members", "team-a", "scope-acme", "--db-path", dbPath, "--json"],
				{ from: "user" },
			);

			const createdScope = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
			const grant = JSON.parse(String(logSpy.mock.calls[1]?.[0])) as Record<string, unknown>;
			const members = JSON.parse(String(logSpy.mock.calls[2]?.[0])) as Array<
				Record<string, unknown>
			>;
			expect(createdScope).toMatchObject({
				scope_id: "scope-acme",
				label: "Acme Work",
				membership_epoch: 2,
			});
			expect(grant).toMatchObject({ device_id: "device-a", role: "admin" });
			expect(members).toEqual([expect.objectContaining({ device_id: "device-a" })]);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			process.exitCode = prevExitCode;
			rmSync(tmpDbDir, { recursive: true, force: true });
		}
	});

	it("reports Sharing domain CLI errors as JSON", async () => {
		const tmpDbDir = mkdtempSync(join(tmpdir(), "coordinator-scope-cli-error-test-"));
		const dbPath = join(tmpDbDir, "coordinator.sqlite");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const prevExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await buildCoordinatorCommand().parseAsync(
				["group-create", "team-a", "--db-path", dbPath, "--json"],
				{ from: "user" },
			);
			await buildCoordinatorCommand().parseAsync(
				[
					"grant-scope-member",
					"team-a",
					"missing-scope",
					"device-a",
					"--db-path",
					dbPath,
					"--json",
				],
				{ from: "user" },
			);

			const error = JSON.parse(String(logSpy.mock.calls[1]?.[0])) as Record<string, unknown>;
			expect(error).toMatchObject({
				error: "grant_scope_member_failed",
				message: "Scope not found: missing-scope",
			});
			expect(process.exitCode).toBe(1);
		} finally {
			logSpy.mockRestore();
			process.exitCode = prevExitCode;
			rmSync(tmpDbDir, { recursive: true, force: true });
		}
	});

	it("defaults coordinator serve to the coordinator store database", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");
		const serve = coordinator?.commands.find((command) => command.name() === "serve");
		expect(serve?.options.find((opt) => opt.long === "--db")?.defaultValue).toBeUndefined();
		// Defaults live in the action handler, not on the Option definitions,
		// so that hidden --host/--port aliases can fall through correctly.
		expect(
			serve?.options.find((opt) => opt.long === "--coordinator-port")?.defaultValue,
		).toBeUndefined();
		const help = serve?.helpInformation() ?? "";
		expect(help).toContain("coordinator database path");
		expect(help).toContain("bind port");
	});

	it("allows positional group ids for create-invite and list-join-requests", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");
		const createInvite = coordinator?.commands.find(
			(command) => command.name() === "create-invite",
		);
		const listRequests = coordinator?.commands.find(
			(command) => command.name() === "list-join-requests",
		);
		expect(createInvite?.registeredArguments[0]?.required).toBe(false);
		expect(listRequests?.registeredArguments[0]?.required).toBe(false);
		expect(createInvite?.helpInformation()).toContain("[group]");
		expect(listRequests?.helpInformation()).toContain("[group]");
	});

	it("initializes sync identity from CODEMEM_KEYS_DIR during sync enable", async () => {
		const tmpDbDir = mkdtempSync(join(tmpdir(), "sync-enable-keys-dir-test-"));
		const dbPath = join(tmpDbDir, "mem.sqlite");
		const configPath = join(tmpDbDir, "codemem.json");
		const keysDir = join(tmpDbDir, "keys");
		const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			process.env.CODEMEM_KEYS_DIR = keysDir;
			const enable = syncCommand.commands.find((command) => command.name() === "enable");
			await enable?.parseAsync(["--db-path", dbPath, "--config", configPath, "--json"], {
				from: "user",
			});

			const publicKey = loadPublicKey(keysDir);
			expect(publicKey).toBeTruthy();
			const store = new MemoryStore(dbPath);
			try {
				const row = store.db.prepare("SELECT public_key FROM sync_device LIMIT 1").get() as
					| { public_key: string }
					| undefined;
				expect(row?.public_key).toBe(publicKey);
			} finally {
				store.close();
			}
		} finally {
			logSpy.mockRestore();
			if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			rmSync(tmpDbDir, { recursive: true, force: true });
		}
	});

	it("registers peer repair subcommands", () => {
		const peers = syncCommand.commands.find((command) => command.name() === "peers");
		expect(peers?.commands.map((command) => command.name())).toEqual(["remove"]);
		expect(peers?.helpInformation()).toContain("remove");
	});

	it("removes a peer by exact name", async () => {
		const tmpDbDir = mkdtempSync(join(tmpdir(), "sync-peers-remove-test-"));
		const dbPath = join(tmpDbDir, "mem.sqlite");
		const rawDb = connect(dbPath);
		initTestSchema(rawDb);
		rawDb.close();
		const store = new MemoryStore(dbPath);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const prevExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			store.db
				.prepare("INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES (?, ?, ?)")
				.run("peer-1", "work", new Date().toISOString());
			store.db
				.prepare(
					"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
				)
				.run("peer-1", "cursor-1", "cursor-1", new Date().toISOString());
			// The v2 cursor drives the replication retention floor; removal must
			// clear it or replication_ops can never prune past this peer.
			store.db
				.prepare(
					"INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("peer-1", "local-default", "cursor-1", "cursor-1", new Date().toISOString());
			const peers = syncCommand.commands.find((command) => command.name() === "peers");
			const remove = peers?.commands.find((command) => command.name() === "remove");
			await remove?.parseAsync(["work", "--db-path", dbPath, "--json"], { from: "user" });
			expect(logSpy).toHaveBeenCalledWith(
				JSON.stringify(
					{
						ok: true,
						peer_device_id: "peer-1",
						name: "work",
						removed: { cursors: 1, cursorsV2: 1, peers: 1, attempts: 0, rejections: 0 },
					},
					null,
					2,
				),
			);
			const row = store.db
				.prepare("SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?")
				.get("peer-1");
			const cursor = store.db
				.prepare("SELECT peer_device_id FROM replication_cursors WHERE peer_device_id = ?")
				.get("peer-1");
			const cursorV2 = store.db
				.prepare("SELECT peer_device_id FROM replication_cursors_v2 WHERE peer_device_id = ?")
				.get("peer-1");
			expect(row).toBeUndefined();
			expect(cursor).toBeUndefined();
			expect(cursorV2).toBeUndefined();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			store.close();
			rmSync(tmpDbDir, { recursive: true, force: true });
			process.exitCode = prevExitCode;
		}
	});

	it("removes a stranded orphan device id with only a replication_cursors_v2 row", async () => {
		const tmpDbDir = mkdtempSync(join(tmpdir(), "sync-peers-remove-orphan-test-"));
		const dbPath = join(tmpDbDir, "mem.sqlite");
		const rawDb = connect(dbPath);
		initTestSchema(rawDb);
		rawDb.close();
		const store = new MemoryStore(dbPath);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const prevExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			// No sync_peers row — only a stranded v2 cursor that pins the
			// retention floor. Removal by device id must still succeed.
			store.db
				.prepare(
					"INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("orphan-device", "local-default", "cursor-1", "cursor-1", new Date().toISOString());
			const peers = syncCommand.commands.find((command) => command.name() === "peers");
			const remove = peers?.commands.find((command) => command.name() === "remove");
			await remove?.parseAsync(["orphan-device", "--db-path", dbPath, "--json"], { from: "user" });
			expect(logSpy).toHaveBeenCalledWith(
				JSON.stringify(
					{
						ok: true,
						peer_device_id: "orphan-device",
						name: null,
						removed: { cursors: 0, cursorsV2: 1, peers: 0, attempts: 0, rejections: 0 },
					},
					null,
					2,
				),
			);
			const cursorV2 = store.db
				.prepare("SELECT peer_device_id FROM replication_cursors_v2 WHERE peer_device_id = ?")
				.get("orphan-device");
			expect(cursorV2).toBeUndefined();
			// Did not fail: not-found would set exit code 1.
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			store.close();
			rmSync(tmpDbDir, { recursive: true, force: true });
			process.exitCode = prevExitCode;
		}
	});

	it("prefers an orphan cursor id over a registered peer whose name collides with it", async () => {
		const tmpDbDir = mkdtempSync(join(tmpdir(), "sync-peers-remove-collision-test-"));
		const dbPath = join(tmpDbDir, "mem.sqlite");
		const rawDb = connect(dbPath);
		initTestSchema(rawDb);
		rawDb.close();
		const store = new MemoryStore(dbPath);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const prevExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			// A live registered peer whose NAME equals an orphan's device id, plus
			// the stranded orphan v2 cursor under that same id. Removal by id must
			// target the orphan cursor (exact id), NOT the name-matched live peer.
			store.db
				.prepare("INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES (?, ?, ?)")
				.run("real-device", "collision-id", new Date().toISOString());
			store.db
				.prepare(
					"INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("collision-id", "local-default", "cursor-1", "cursor-1", new Date().toISOString());
			const peers = syncCommand.commands.find((command) => command.name() === "peers");
			const remove = peers?.commands.find((command) => command.name() === "remove");
			await remove?.parseAsync(["collision-id", "--db-path", dbPath, "--json"], { from: "user" });
			expect(logSpy).toHaveBeenCalledWith(
				JSON.stringify(
					{
						ok: true,
						peer_device_id: "collision-id",
						name: null,
						removed: { cursors: 0, cursorsV2: 1, peers: 0, attempts: 0, rejections: 0 },
					},
					null,
					2,
				),
			);
			// The orphan cursor is gone...
			expect(
				store.db
					.prepare("SELECT peer_device_id FROM replication_cursors_v2 WHERE peer_device_id = ?")
					.get("collision-id"),
			).toBeUndefined();
			// ...and the live peer that merely shares the name is untouched.
			expect(
				store.db
					.prepare("SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?")
					.get("real-device"),
			).toEqual({ peer_device_id: "real-device" });
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			store.close();
			rmSync(tmpDbDir, { recursive: true, force: true });
			process.exitCode = prevExitCode;
		}
	});

	it("reports semantic-index diagnostics in sync status json output", async () => {
		const tmpDbDir = mkdtempSync(join(tmpdir(), "sync-status-diagnostics-test-"));
		const dbPath = join(tmpDbDir, "mem.sqlite");
		const configPath = join(tmpDbDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ sync_enabled: true }, null, 2));
		const rawDb = connect(dbPath);
		initTestSchema(rawDb);
		rawDb.close();
		const store = new MemoryStore(dbPath);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			startMaintenanceJob(store.db, {
				kind: "vector_model_migration",
				title: "Re-indexing memories",
				status: "pending",
				message: "Queued vector catch-up for synced bootstrap data",
				progressTotal: 4,
				metadata: { processed_embeddable: 1, embeddable_total: 4 },
			});

			await syncCommand.parseAsync(
				["status", "--db-path", dbPath, "--config", configPath, "--json"],
				{ from: "user" },
			);

			expect(logSpy).toHaveBeenCalledTimes(1);
			const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
			expect(payload.semantic_index).toMatchObject({
				state: "pending",
				pending_memory_count: 3,
				maintenance_job: { status: "pending" },
			});
		} finally {
			logSpy.mockRestore();
			store.close();
			rmSync(tmpDbDir, { recursive: true, force: true });
		}
	});

	it("reports per-Space sync progress in sync status output", async () => {
		const tmpDbDir = mkdtempSync(join(tmpdir(), "sync-status-scopes-test-"));
		const dbPath = join(tmpDbDir, "mem.sqlite");
		const configPath = join(tmpDbDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ sync_enabled: true }, null, 2));
		const rawDb = connect(dbPath);
		initTestSchema(rawDb);
		rawDb.close();
		const store = new MemoryStore(dbPath);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const now = "2026-01-01T00:00:00.000Z";
			store.db
				.prepare(
					"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
				)
				.run("local-device", "local-public-key", "local-fingerprint", now);
			store.db
				.prepare("INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES (?, ?, ?)")
				.run("peer-device", "Work laptop", now);
			for (const [scopeId, label] of [
				["work", "Work"],
				["personal", "Personal"],
			] as const) {
				store.db
					.prepare(
						`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
						 VALUES (?, ?, 'user', 'local', 1, 'active', ?, ?)`,
					)
					.run(scopeId, label, now, now);
				for (const deviceId of ["local-device", "peer-device"]) {
					store.db
						.prepare(
							`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
							 VALUES (?, ?, 'member', 'active', 1, ?)`,
						)
						.run(scopeId, deviceId, now);
				}
			}
			store.db
				.prepare(
					`INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run("peer-device", "work", "2026-01-01T00:00:01Z|op", null, now);

			await syncCommand.parseAsync(
				["status", "--db-path", dbPath, "--config", configPath, "--json"],
				{
					from: "user",
				},
			);

			const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
				peers?: Array<{
					scopes?: Array<{ label: string; scope_id: string; bootstrapped: boolean }>;
				}>;
			};
			expect(payload.peers?.[0]?.scopes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ label: "Work", scope_id: "work", bootstrapped: true }),
					expect.objectContaining({
						label: "Personal",
						bootstrapped: false,
						scope_id: "personal",
					}),
				]),
			);

			logSpy.mockClear();
			const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			try {
				await syncCommand.parseAsync(["status", "--db-path", dbPath, "--config", configPath], {
					from: "user",
				});

				const rendered = writeSpy.mock.calls.map((call) => String(call[0])).join("\n");
				expect(rendered).toContain("Spaces:");
				expect(rendered).toContain("Work (work): received");
				expect(rendered).toContain("Personal (personal): pending");
			} finally {
				writeSpy.mockRestore();
			}
		} finally {
			logSpy.mockRestore();
			store.close();
			rmSync(tmpDbDir, { recursive: true, force: true });
		}
	});
});
