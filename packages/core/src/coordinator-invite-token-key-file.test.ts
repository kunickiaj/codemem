import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	inviteTokenKeyFilePath,
	readOrCreateInviteTokenKeyFile,
} from "./coordinator-invite-token-key-file.js";
import { InviteTokenSealError } from "./coordinator-invite-token-seal.js";

let dir: string;
let path: string;
let warn: ReturnType<typeof vi.spyOn>;
const saved = { key: process.env.CODEMEM_INVITE_TOKEN_KEY, config: process.env.CODEMEM_CONFIG };
const stores: BetterSqliteCoordinatorStore[] = [];

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "codemem-invite-key-file-")));
	path = join(dir, "coordinator.sqlite");
	// No configured key: neither the environment nor the config file has one.
	delete process.env.CODEMEM_INVITE_TOKEN_KEY;
	process.env.CODEMEM_CONFIG = join(dir, "config.json");
	writeFileSync(process.env.CODEMEM_CONFIG, "{}");
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	process.env.CODEMEM_INVITE_TOKEN_KEY = saved.key;
	process.env.CODEMEM_CONFIG = saved.config;
	warn.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

/** A store on the database, with the operator's lookup floor recorded so it seals. */
async function open(options: { existingOnly?: boolean; at?: string } = {}) {
	const store = new BetterSqliteCoordinatorStore(options.at ?? path, options);
	stores.push(store);
	if (!options.existingOnly) await store.raiseInviteTokenLookupFloor(1);
	return store;
}

async function invite(store: BetterSqliteCoordinatorStore) {
	if (!(await store.getGroup("g1"))) await store.createGroup("g1", "Team");
	return store.createInvite({
		groupId: "g1",
		policy: "approval_required",
		expiresAt: "2099-01-01T00:00:00Z",
	});
}

async function sealError(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(InviteTokenSealError);
	return error as InviteTokenSealError;
}

it("creates a mode-600 key file next to the database on first sealing use and logs its path only", async () => {
	// Act
	const first = await invite(await open());
	const keyFile = inviteTokenKeyFilePath(path);
	const key = readFileSync(keyFile, "utf8").trim();
	const second = await invite(await open());
	// Assert
	expect(keyFile).toBe(`${path}.invite-token-key`);
	expect(statSync(keyFile).mode & 0o777).toBe(0o600);
	expect(key).toMatch(/^[0-9a-f]{64}$/u);
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn).toHaveBeenCalledWith(`created invite token key at ${keyFile}`);
	expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
	expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	// Both stores used the one key: each reads the other's link.
	expect(await (await open()).inviteLinkToken(first)).toBe(first.token);
	expect(await (await open()).inviteLinkToken(second)).toBe(second.token);
});

it("uses a configured key instead, without creating the file", async () => {
	process.env.CODEMEM_INVITE_TOKEN_KEY = randomBytes(32).toString("hex");
	await invite(await open());
	expect(existsSync(`${path}.invite-token-key`)).toBe(false);
	expect(warn).not.toHaveBeenCalled();
});

it("never creates the file from a store that opens an existing database only", async () => {
	// Arrange
	await (await open()).createGroup("g1", "Team");
	// Act
	const refused = await sealError(invite(await open({ existingOnly: true })));
	// Assert
	expect(refused.code).toBe("invite_token_key_unavailable");
	expect(existsSync(`${path}.invite-token-key`)).toBe(false);
});

it("after losing the file, keeps accepting open invitations and only stops copying their links", async () => {
	// Arrange
	const issued = await invite(await open());
	rmSync(inviteTokenKeyFilePath(path));
	// Act
	const reopened = await open();
	const found = await reopened.getInviteByToken(issued.token);
	const copied = await sealError(reopened.inviteLinkToken(issued));
	const fresh = await invite(reopened);
	// Assert
	expect(found?.invite_id).toBe(issued.invite_id);
	expect(copied.code).toBe("invite_token_key_unavailable");
	expect(await reopened.inviteLinkToken(fresh)).toBe(fresh.token);
});

it("refuses an existing key file that others can read, that is a link, or that holds no key", async () => {
	// Arrange
	await open();
	const keyFile = `${path}.invite-token-key`;
	const valid = `${randomBytes(32).toString("hex")}\n`;
	const outside = join(dir, "elsewhere.key");
	writeFileSync(outside, valid, { mode: 0o600 });
	const cases: Array<[string, () => void]> = [
		["can be read or written by other users", () => writeFileSync(keyFile, valid, { mode: 0o644 })],
		["is not a regular file", () => symlinkSync(outside, keyFile)],
		["does not hold a 32-byte key", () => writeFileSync(keyFile, "short\n", { mode: 0o600 })],
	];
	for (const [reason, arrange] of cases) {
		rmSync(keyFile, { force: true });
		arrange();
		// Act
		const refused = await sealError(invite(await open()));
		// Assert
		expect(refused.code).toBe("invite_token_key_file_invalid");
		expect(refused.message).toContain(keyFile);
		expect(refused.message).toContain(reason);
		expect(refused.message).not.toContain(valid.trim());
	}
	expect(readFileSync(keyFile, "utf8")).toBe("short\n");
});

it("gives every process the same key when they create it at once through real and linked paths", async () => {
	// Arrange: the database, and a symbolic link to it from another directory.
	await open();
	const linked = join(dir, "linked");
	mkdirSync(linked);
	symlinkSync(path, join(linked, "coordinator.sqlite"));
	const module = fileURLToPath(new URL("./coordinator-invite-token-key-file.ts", import.meta.url));
	const run = (databasePath: string) =>
		new Promise<string>((resolve, reject) => {
			const script = `const m = await import(${JSON.stringify(module)});
				const { createHash } = await import("node:crypto");
				const key = m.readOrCreateInviteTokenKeyFile(${JSON.stringify(databasePath)}, {
					create: true, log: (line) => console.log("LOG " + line) });
				console.log("KEY " + createHash("sha256").update(key).digest("hex"));`;
			const child = spawn(
				process.execPath,
				["--import", "tsx", "--input-type=module", "--eval", script],
				{
					cwd: fileURLToPath(new URL("../../..", import.meta.url)),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let out = "";
			let err = "";
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.stderr.on("data", (chunk) => {
				err += chunk;
			});
			child.on("close", (status) => (status === 0 ? resolve(out) : reject(new Error(err))));
		});
	// Act
	const outputs = await Promise.all(
		Array.from({ length: 8 }, (_, index) =>
			run(index % 2 === 0 ? path : join(linked, "coordinator.sqlite")),
		),
	);
	// Assert
	const lines = outputs.join("").trim().split("\n");
	const keys = new Set(lines.filter((line) => line.startsWith("KEY ")));
	const key = readFileSync(`${path}.invite-token-key`, "utf8").trim();
	expect(keys).toEqual(new Set([`KEY ${createHash("sha256").update(key).digest("hex")}`]));
	expect(lines.filter((line) => line.startsWith("LOG "))).toEqual([
		`LOG created invite token key at ${path}.invite-token-key`,
	]);
	expect(existsSync(join(linked, "coordinator.sqlite.invite-token-key"))).toBe(false);
	expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	expect(
		readOrCreateInviteTokenKeyFile(join(linked, "coordinator.sqlite"), { create: false }),
	).toBe(key);
}, 60_000);
