import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, encodeInvitePayload, ensureDeviceIdentity, initTestSchema } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCoordinatorCommand } from "./coordinator.js";

const prompts = vi.hoisted(() => ({ confirm: vi.fn(), write: vi.fn() }));
vi.mock("@clack/prompts", () => ({
	confirm: prompts.confirm,
	intro: prompts.write,
	outro: prompts.write,
	log: {
		info: prompts.write,
		message: prompts.write,
		success: prompts.write,
		error: prompts.write,
	},
}));

const WARNING =
	"Joining a coordinator permanently turns off syncing without a coordinator for this device's key";

let directory: string;
let fetchMock: ReturnType<typeof vi.fn>;
let isTTY: boolean | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-join-confirmation-"));
	writeFileSync(join(directory, "config.json"), "{}");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	fetchMock = vi.fn(async () => Response.json({ ok: true, status: "enrolled" }));
	vi.stubGlobal("fetch", fetchMock);
	isTTY = process.stdin.isTTY;
	process.exitCode = undefined;
});

afterEach(() => {
	if (existsSync(join(directory, "keys"))) chmodSync(join(directory, "keys"), 0o700);
	process.stdin.isTTY = isTTY as boolean;
	process.exitCode = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function accept(...extra: string[]) {
	const invite = encodeInvitePayload({
		v: 1,
		kind: "coordinator_team_invite",
		coordinator_url: "https://coord.example.test",
		group_id: "team-a",
		policy: "auto_admit",
		token: "join-token",
		expires_at: "2099-01-01T00:00:00.000Z",
		team_name: "Team A",
	});
	const args = ["invitation", "accept", invite, "--db-path", join(directory, "mem.sqlite")];
	const flags = ["--keys-dir", join(directory, "keys"), ...extra];
	return buildCoordinatorCommand().parseAsync([...args, ...flags], { from: "user" });
}

it("refuses a JSON join without the confirmation flag and says how to confirm", async () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

	await accept("--json");

	expect(fetchMock).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
	const output = JSON.parse(String(log.mock.calls[0]?.[0]));
	expect(output.message).toContain(WARNING);
	expect(output.message).toContain("--confirm-coordinator-join");
});

it("joins with the confirmation flag", async () => {
	vi.spyOn(console, "log").mockImplementation(() => undefined);

	await accept("--json", "--confirm-coordinator-join");

	expect(fetchMock).toHaveBeenCalledOnce();
	expect(process.exitCode).toBeUndefined();
});

it.each([
	[true, 1],
	[false, 0],
])("asks in a terminal and joins only when confirmed (%s)", async (answer, joins) => {
	process.stdin.isTTY = true;
	prompts.confirm.mockResolvedValue(answer);

	await accept();

	expect(prompts.confirm).toHaveBeenCalledWith(
		expect.objectContaining({ message: expect.stringContaining(WARNING), initialValue: false }),
	);
	expect(fetchMock).toHaveBeenCalledTimes(joins);
});

it("says to unlock or repair the keychain when the join can't be recorded", async () => {
	const db = connect(join(directory, "mem.sqlite"));
	initTestSchema(db);
	ensureDeviceIdentity(db, { keysDir: join(directory, "keys") });
	db.close();
	chmodSync(join(directory, "keys"), 0o500);
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

	await accept("--json", "--confirm-coordinator-join");

	expect(fetchMock).not.toHaveBeenCalled();
	expect(JSON.parse(String(log.mock.calls[0]?.[0])).message).toBe(
		"codemem couldn't save this device's coordinator record. Unlock or repair the keychain, or make the codemem keys folder writable, then try again.",
	);
});
