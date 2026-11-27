import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	log: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn() },
	linkError: null as string | null,
}));
vi.mock("@clack/prompts", () => ({ log: mocks.log }));
// Stands in for a filesystem without hard links when a test sets `linkError`.
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	const linkSync: typeof fs.linkSync = (existing, target) => {
		if (!mocks.linkError) return fs.linkSync(existing, target);
		throw Object.assign(new Error(`${mocks.linkError}: link refused`), { code: mocks.linkError });
	};
	return { ...fs, linkSync, default: { ...fs, linkSync } };
});

import { BetterSqliteCoordinatorStore } from "@codemem/core";
import { buildCoordinatorCommand } from "./coordinator.js";

let dir: string;
let dbPath: string;
let output: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-record-floor-"));
	dbPath = join(dir, "coordinator.sqlite");
	output = vi.spyOn(console, "log").mockImplementation(() => undefined);
	process.exitCode = undefined;
});
afterEach(() => {
	output.mockRestore();
	vi.clearAllMocks();
	process.exitCode = undefined;
	rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
	return buildCoordinatorCommand().parseAsync(["invitation", "record-floor", ...args], {
		from: "user",
	});
}

function jsonOutput(): Record<string, unknown> {
	return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}

async function legacyInvite() {
	const store = new BetterSqliteCoordinatorStore(dbPath);
	try {
		await store.createGroup("g1", "Team");
		return await store.createInvite({
			groupId: "g1",
			policy: "approval_required",
			expiresAt: "2099-01-01T00:00:00Z",
		});
	} finally {
		await store.close();
	}
}

function storedToken(inviteId: string): string {
	const store = new BetterSqliteCoordinatorStore(dbPath);
	try {
		return String(
			store.db
				.prepare("SELECT token FROM coordinator_invites WHERE invite_id = ?")
				.pluck()
				.get(inviteId),
		);
	} finally {
		store.db.close();
	}
}

it("refuses a floor above this release's lookup version, or one that is not a version, without opening the database", async () => {
	for (const version of ["2", "0", "1.5", "one"]) {
		// Act
		await run(version, "--db-path", dbPath, "--json");
		// Assert
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
	}
	expect(output.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])).error)).toEqual([
		"version_above_build",
		"invalid_version",
		"invalid_version",
		"invalid_version",
	]);
	await run("1", "--db-path", dbPath, "--json");
	expect(jsonOutput()).toMatchObject({ error: "coordinator_database_missing" });
});

it("answers with a structured error when the path is not a readable coordinator database", async () => {
	// Arrange
	const notDatabase = join(dir, "notes.txt");
	writeFileSync(notDatabase, "not a database\n".repeat(200));
	for (const path of [dir, notDatabase]) {
		// Act
		await run("1", "--db-path", path, "--json");
		// Assert
		expect(process.exitCode).toBe(1);
		expect(jsonOutput()).toMatchObject({ error: "coordinator_database_unreadable" });
		process.exitCode = undefined;
	}
});

it("records the floor, then encrypts the tokens the coordinator stored before it", async () => {
	// Arrange: before the floor, the coordinator keeps the bearer token.
	const invite = await legacyInvite();
	expect(storedToken(invite.invite_id)).toBe(invite.token);
	// Act
	await run("1", "--db-path", dbPath, "--json");
	// Assert
	expect(process.exitCode).toBeUndefined();
	expect(jsonOutput()).toMatchObject({
		ok: true,
		build_lookup_version: 1,
		min_serving_lookup_version: 1,
		remaining_plaintext_invites: 0,
		remaining_spent_ciphertext: 0,
	});
	expect(storedToken(invite.invite_id)).toMatch(/^sealed:/u);
	const store = new BetterSqliteCoordinatorStore(dbPath);
	try {
		expect((await store.getInviteByToken(invite.token))?.invite_id).toBe(invite.invite_id);
		expect(await store.inviteLinkToken(invite)).toBe(invite.token);
	} finally {
		await store.close();
	}
});

function minServingFloor(): unknown {
	const store = new BetterSqliteCoordinatorStore(dbPath);
	try {
		return store.db
			.prepare(
				"SELECT value FROM coordinator_metadata WHERE name = 'invite_token_min_serving_lookup_version'",
			)
			.pluck()
			.get();
	} finally {
		store.db.close();
	}
}

it("records nothing when the key file cannot be linked into place or an existing one is unusable", async () => {
	// Arrange: no configured key, so the coordinator would create its key file.
	const saved = { key: process.env.CODEMEM_INVITE_TOKEN_KEY, config: process.env.CODEMEM_CONFIG };
	delete process.env.CODEMEM_INVITE_TOKEN_KEY;
	process.env.CODEMEM_CONFIG = join(dir, "config.json");
	writeFileSync(process.env.CODEMEM_CONFIG, "{}");
	try {
		const invite = await legacyInvite();
		const keyFile = `${dbPath}.invite-token-key`;
		// Act: a filesystem that refuses hard links.
		mocks.linkError = "EPERM";
		await run("1", "--db-path", dbPath, "--json");
		mocks.linkError = null;
		// Assert
		expect(process.exitCode).toBe(1);
		const refused = jsonOutput();
		expect(refused.error).toBe("invite_token_key_file_unsupported");
		expect(String(refused.message)).toContain("CODEMEM_INVITE_TOKEN_KEY");
		expect(String(refused.message)).toContain("The floor was not recorded.");
		expect(minServingFloor()).toBeUndefined();
		expect(storedToken(invite.invite_id)).toBe(invite.token);
		expect(existsSync(keyFile)).toBe(false);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		// Act: an existing key file that other users can read.
		process.exitCode = undefined;
		writeFileSync(keyFile, `${"a".repeat(64)}\n`, { mode: 0o644 });
		await run("1", "--db-path", dbPath, "--json");
		// Assert
		expect(process.exitCode).toBe(1);
		expect(jsonOutput().error).toBe("invite_token_key_file_invalid");
		expect(minServingFloor()).toBeUndefined();
		expect(storedToken(invite.invite_id)).toBe(invite.token);
	} finally {
		mocks.linkError = null;
		if (saved.config === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = saved.config;
		if (saved.key === undefined) delete process.env.CODEMEM_INVITE_TOKEN_KEY;
		else process.env.CODEMEM_INVITE_TOKEN_KEY = saved.key;
	}
});

it("is listed under the coordinator invitation commands", () => {
	const invitation = buildCoordinatorCommand().commands.find(
		(command) => command.name() === "invitation",
	);
	expect(invitation?.commands.map((command) => command.name())).toContain("record-floor");
});
