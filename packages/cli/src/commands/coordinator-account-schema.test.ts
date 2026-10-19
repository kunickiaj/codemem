import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import {
	ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	BetterSqliteCoordinatorStore,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCoordinatorCommand } from "./coordinator.js";
import { buildCoordinatorAccountSchemaCommand } from "./coordinator-auth-schema.js";

const originalExit = process.exitCode;
let dir: string;
beforeEach(() => {
	mkdirSync(".tmp", { recursive: true });
	dir = mkdtempSync(join(".tmp", "account-schema-cli-"));
});
afterEach(() => {
	process.exitCode = originalExit;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
async function run(args: string[]) {
	vi.restoreAllMocks();
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const errors = vi.spyOn(console, "log").mockImplementation(() => {});
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	await buildCoordinatorAccountSchemaCommand().parseAsync(args, { from: "user" });
	return { stdout, errors, stderr };
}
function open(path: string) {
	return new Database(path, { readOnly: true });
}

it("requires an explicit path instead of environment/profile defaults", async () => {
	const path = join(dir, "never-created.sqlite");
	vi.stubEnv("CODEMEM_DB", path);
	const out = await run(["--json"]);
	expect(JSON.parse(String(out.errors.mock.calls[0]?.[0]))).toMatchObject({
		error: "usage_error",
		message: expect.stringContaining("--db-path"),
	});
	expect(process.exitCode).toBe(2);
	expect(existsSync(path)).toBe(false);
	expect(out.stderr).not.toHaveBeenCalled();
});

it.each(["explicit", "empty"])(
	"rejects export with an %s database selection before opening anything",
	async (selection) => {
		const path = selection === "empty" ? "" : join(dir, "absent.sqlite"),
			out = await run(["--export-sql", "--db-path", path, "--json"]);
		expect(JSON.parse(String(out.errors.mock.calls[0]?.[0]))).toMatchObject({
			error: "usage_error",
		});
		expect(process.exitCode).toBe(2);
		expect(existsSync(path)).toBe(false);
		expect(out.stdout).not.toHaveBeenCalled();
	},
);

it("exports intact statement boundaries and no transaction wrapper without opening a database", async () => {
	const path = join(dir, "must-stay-absent.sqlite");
	vi.stubEnv("CODEMEM_DB", path);
	const out = await run(["--export-sql", "--json"]),
		result = JSON.parse(String(out.stdout.mock.calls[0]?.[0]));
	expect(result).toEqual({ statements: ACCOUNT_CONNECTION_MIGRATION_STATEMENTS, applied: false });
	expect(result.statements.some((s: string) => /^\s*(BEGIN|COMMIT)\b/u.test(s))).toBe(false);
	expect(
		result.statements.some((s: string) =>
			s.includes("RAISE(ABORT,'account_change_transition_invalid')"),
		),
	).toBe(true);
	expect(existsSync(path)).toBe(false);
	expect(out.stderr).not.toHaveBeenCalled();
	expect(out.errors).not.toHaveBeenCalled();
});

it("prints an atomic-batch warning and complete semicolon SQL for plaintext export", async () => {
	const out = await run(["--export-sql"]),
		text = String(out.stdout.mock.calls[0]?.[0]);
	expect(text).toContain("ONE atomic D1 batch");
	expect(text).toContain("back up");
	expect(text).toContain("END;");
	expect(text).toMatch(/;\n$/u);
	expect(out.errors).not.toHaveBeenCalled();
});

it("rejects nonexistent files without silently creating them", async () => {
	const path = join(dir, "absent.sqlite"),
		out = await run(["--db-path", path, "--json"]);
	expect(JSON.parse(String(out.errors.mock.calls[0]?.[0]))).toMatchObject({
		error: "account_schema_upgrade_failed",
	});
	expect(process.exitCode).toBe(1);
	expect(existsSync(path)).toBe(false);
	expect(out.stderr).not.toHaveBeenCalled();
});

it("rejects an unrelated existing database without initialization or data changes", async () => {
	const path = join(dir, "unrelated.sqlite"),
		db = new Database(path);
	db.exec(
		"CREATE TABLE application_data (value TEXT); INSERT INTO application_data VALUES ('unchanged')",
	);
	db.close();
	const before = readFileSync(path),
		out = await run(["--db-path", path, "--json"]);
	expect(JSON.parse(String(out.errors.mock.calls[0]?.[0]))).toMatchObject({
		error: "account_schema_upgrade_failed",
	});
	expect(process.exitCode).toBe(1);
	expect(readFileSync(path)).toEqual(before);
	const check = open(path);
	try {
		expect(check.prepare("SELECT name FROM sqlite_master").all()).toEqual([
			{ name: "application_data" },
		]);
	} finally {
		check.close();
	}
});

it("upgrades only the selected V2 file and preserves raw enrollment row identity and key bytes", async () => {
	const path = join(dir, "coordinator.sqlite"),
		store = new BetterSqliteCoordinatorStore(path);
	await store.createGroup("fixture-group");
	await store.enrollDevice("fixture-group", {
		deviceId: "fixture-device",
		publicKey: "fixture public key\r\nbytes",
		fingerprint: "a".repeat(64),
	});
	const before = store.db.prepare("SELECT rowid AS original_rowid,* FROM enrolled_devices").all();
	await store.close();
	const out = await run(["--db-path", path, "--json"]);
	expect(JSON.parse(String(out.stdout.mock.calls[0]?.[0]))).toEqual({ upgraded: true });
	expect(out.errors).not.toHaveBeenCalled();
	const check = open(path);
	try {
		expect(check.prepare("SELECT rowid AS original_rowid,* FROM enrolled_devices").all()).toEqual(
			before,
		);
		expect(
			check
				.prepare("SELECT name FROM sqlite_master WHERE name='coordinator_account_change_attempts'")
				.get(),
		).toEqual({ name: "coordinator_account_change_attempts" });
	} finally {
		check.close();
	}
	const applied = readFileSync(path);
	const replay = await run(["--db-path", path, "--json"]);
	expect(JSON.parse(String(replay.errors.mock.calls[0]?.[0]))).toMatchObject({
		error: "account_schema_upgrade_failed",
		message: expect.stringContaining("already_installed"),
	});
	expect(process.exitCode).toBe(1);
	expect(readFileSync(path)).toEqual(applied);
});

it("includes pause/drain/backup guidance and keeps the new command at coordinator depth", () => {
	const command = buildCoordinatorAccountSchemaCommand();
	let help = "";
	command
		.configureOutput({
			writeOut: (text) => {
				help += text;
			},
		})
		.outputHelp();
	expect(command.name()).toBe("upgrade-account-schema");
	expect(command.helpInformation()).toContain("--db-path");
	expect(command.helpInformation()).toContain("--json");
	expect(help).toContain("Pause auth writers");
	expect(help).toContain("drain pending attempts");
	expect(help).toContain("back up");
	expect(
		buildCoordinatorCommand().commands.some((c) => c.name() === "upgrade-account-schema"),
	).toBe(true);
});
