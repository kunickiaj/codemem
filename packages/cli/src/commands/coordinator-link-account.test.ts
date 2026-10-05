import { CoordinatorAccountLinkError } from "@codemem/core";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	linkCoordinatorAccount: vi.fn(),
	readCodememConfigFile: vi.fn(),
	readCodememConfigFileAtPath: vi.fn(),
	resolveDbPath: vi.fn((path: string) => path),
	log: { error: vi.fn(), warn: vi.fn(), message: vi.fn(), success: vi.fn() },
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	...mocks,
}));
vi.mock("@clack/prompts", () => ({ log: mocks.log }));

import { buildCoordinatorCommand } from "./coordinator.js";
import { buildCoordinatorLinkAccountCommand } from "./coordinator-link-account.js";

const privateUrl =
	"https://coordinator.example.test/auth/link/start?attempt_id=attempt-a&start_code=private-proof";
const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const exitCode = process.exitCode;
beforeEach(() => {
	vi.clearAllMocks();
	for (const name of [
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_SYNC_COORDINATOR_GROUPS",
		"CODEMEM_SYNC_COORDINATOR_TIMEOUT_S",
		"CODEMEM_SYNC_COORDINATOR_PRESENCE_TTL_S",
		"CODEMEM_KEYS_DIR",
	])
		vi.stubEnv(name, undefined);
	process.exitCode = undefined;
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	mocks.readCodememConfigFile.mockReturnValue({
		sync_coordinator_url: "https://saved.example.test",
	});
	mocks.readCodememConfigFileAtPath.mockReturnValue({
		sync_coordinator_url: "https://saved.example.test",
	});
	mocks.linkCoordinatorAccount.mockResolvedValue({
		coordinatorId: "coordinator-a",
		identityId: "identity-a",
		attemptId: "attempt-a",
		state: "finalized",
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	process.exitCode = exitCode;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("canonical and legacy trees own distinct link-account instances", async () => {
	// Arrange
	const canonical = buildCoordinatorCommand();
	const legacy = buildCoordinatorCommand();
	const root = new Command()
		.addCommand(canonical)
		.addCommand(new Command("sync").addCommand(legacy));
	// Act
	await root.parseAsync(["coordinator", "link-account", "group-a", "--db-path", "fixture.sqlite"], {
		from: "user",
	});
	// Assert
	expect(canonical.commands.find((cmd) => cmd.name() === "link-account")).not.toBe(
		legacy.commands.find((cmd) => cmd.name() === "link-account"),
	);
	expect(mocks.linkCoordinatorAccount).toHaveBeenCalledWith(
		expect.objectContaining({
			groupId: "group-a",
			dbPath: "fixture.sqlite",
			coordinatorUrl: "https://saved.example.test",
		}),
	);
});

it("TTY-only handoff prints privately to stderr and removes signal listeners", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_KEYS_DIR", "  fixture-keys  ");
	const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
	mocks.linkCoordinatorAccount.mockImplementation(async (options) => {
		options.onBrowserStart(privateUrl);
		return {
			coordinatorId: "coordinator-a",
			identityId: "identity-a",
			attemptId: "attempt-a",
			state: "finalized",
		};
	});
	// Act
	await buildCoordinatorLinkAccountCommand().parseAsync(
		[
			"group-a",
			"-d",
			"fixture.sqlite",
			"-c",
			"fixture.json",
			"-u",
			"https://override.example.test",
			"-l",
			"::1",
		],
		{ from: "user" },
	);
	// Assert
	expect(mocks.readCodememConfigFileAtPath).toHaveBeenCalledWith("fixture.json");
	expect(mocks.linkCoordinatorAccount).toHaveBeenCalledWith(
		expect.objectContaining({
			dbPath: "fixture.sqlite",
			keysDir: "fixture-keys",
			groupId: "group-a",
			coordinatorUrl: "https://override.example.test",
			loopbackHost: "::1",
			signal: expect.any(AbortSignal),
		}),
	);
	expect(mocks.log.message).toHaveBeenCalledWith(privateUrl, { output: process.stderr });
	expect(mocks.log.success).toHaveBeenCalledWith(
		expect.stringContaining("coordinator Identity identity-a. Your local Identity has not changed"),
		{ output: process.stderr },
	);
	expect(console.log).not.toHaveBeenCalled();
	expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
});

it.each([
	{ name: "environment over saved URL", saved: "https://saved.example.test", flag: undefined },
	{ name: "environment without saved URL", saved: undefined, flag: undefined },
	{
		name: "explicit flag over environment",
		saved: "https://saved.example.test",
		flag: "https://flag.example.test",
	},
])("$name uses the same coordinator as the shared runtime config", async ({ saved, flag }) => {
	// Arrange: the actual shared loader trims the environment override, including custom configs.
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "  https://environment.example.test  ");
	mocks.readCodememConfigFileAtPath.mockReturnValue({ sync_coordinator_url: saved });
	// Act
	await buildCoordinatorLinkAccountCommand().parseAsync(
		["group-a", "-d", "fixture.sqlite", "-c", "fixture.json", ...(flag ? ["-u", flag] : [])],
		{ from: "user" },
	);
	// Assert: never pass the saved URL or whitespace through to the account-link runtime.
	expect(mocks.linkCoordinatorAccount).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			coordinatorUrl: flag ?? "https://environment.example.test",
			groupId: "group-a",
			dbPath: "fixture.sqlite",
		}),
	);
	expect(process.exitCode).toBeUndefined();
});

it.each(["json", "nonterminal"])(
	"%s rejects before reading config or starting the runtime",
	async (mode) => {
		// Arrange
		if (mode === "nonterminal")
			Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
		const args = ["group-a", ...(mode === "json" ? ["--json"] : [])];
		// Act
		await buildCoordinatorLinkAccountCommand().parseAsync(args, { from: "user" });
		// Assert
		expect(mocks.linkCoordinatorAccount).not.toHaveBeenCalled();
		expect(mocks.readCodememConfigFile).not.toHaveBeenCalled();
		expect(mocks.log.message).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
		if (mode === "json")
			expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
				error: "interactive_flow_only",
			});
	},
);

it("unexpected failure cannot echo private URLs or proof-bearing causes", async () => {
	// Arrange
	const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
	mocks.linkCoordinatorAccount.mockRejectedValueOnce(new Error(privateUrl));
	// Act
	await buildCoordinatorLinkAccountCommand().parseAsync(
		["group-a", "--db-path", "fixture.sqlite"],
		{ from: "user" },
	);
	// Assert
	expect(mocks.log.error).toHaveBeenCalledWith(
		expect.stringContaining("Account linking could not finish"),
		{ output: process.stderr },
	);
	expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain("private-proof");
	expect(console.log).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
	expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
});

it("review rejection names the operator action without reconstructing secret-bearing arguments", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "private-admin-secret");
	mocks.linkCoordinatorAccount.mockRejectedValueOnce(
		new CoordinatorAccountLinkError("review_required"),
	);
	// Act
	await buildCoordinatorLinkAccountCommand().parseAsync(
		["group-private", "-d", "private-db.sqlite", "-c", "private-config.json"],
		{ from: "user" },
	);
	// Assert
	const output = JSON.stringify([mocks.log.error.mock.calls, mocks.log.message.mock.calls]);
	expect(output).toContain("codemem coordinator review-device-owner");
	expect(output).toMatch(/this group.*this device/);
	expect(output).toMatch(/admin.*credential/);
	for (const setting of ["--coordinator", "--config", "--db-path", "environment"])
		expect(output).toContain(setting);
	for (const secret of [
		"group-private",
		"private-db.sqlite",
		"private-config.json",
		"private-admin-secret",
		"private-proof",
	])
		expect(output).not.toContain(secret);
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(console.log).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});

it("conflict guidance uses only the configured origin and does not promise another account fixes it", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "https://environment.example.test");
	mocks.linkCoordinatorAccount.mockRejectedValueOnce(
		new CoordinatorAccountLinkError("link_conflict"),
	);
	// Act
	await buildCoordinatorLinkAccountCommand().parseAsync(
		["group-a", "-d", "fixture.sqlite", "-u", "https://pinned.example.test/"],
		{ from: "user" },
	);
	// Assert
	const output = JSON.stringify([mocks.log.error.mock.calls, mocks.log.message.mock.calls]);
	expect(output).toContain("https://pinned.example.test/auth/sign-in");
	expect(output).toMatch(/If.*intended.*Identity/);
	expect(output).toMatch(/Otherwise.*operator/);
	expect(output).toMatch(/not supported/);
	expect(output).not.toMatch(/environment\.example|saved\.example|private-proof|switch accounts/i);
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(console.log).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});
