import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSyncRejoinCommand } from "./sync-rejoin.js";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	config: vi.fn(),
	device: vi.fn(),
	log: { error: vi.fn(), success: vi.fn(), warn: vi.fn(), message: vi.fn() },
}));
vi.mock("@clack/prompts", () => ({ log: mocks.log }));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	readAccountLinkDevice: mocks.device,
	readCodememConfigFileAtPath: mocks.config,
	runDeviceRejoin: mocks.run,
}));

const origin = "https://coordinator.example.test";
const privateLink = `${origin}/auth/rejoin/start?attempt_id=fixture&start_code=fixture-private-code`;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const initialExitCode = process.exitCode;
let dir = "";
let dbPath = "";

function tty(value: boolean) {
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value });
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", undefined);
	vi.stubEnv("CODEMEM_KEYS_DIR", "/fixture/keys");
	process.exitCode = undefined;
	tty(true);
	dir = mkdtempSync(join(tmpdir(), "codemem-cli-rejoin-"));
	dbPath = join(dir, "profile.sqlite");
	writeFileSync(dbPath, "fixture");
	mocks.config.mockReturnValue({ sync_coordinator_url: origin });
	mocks.device.mockReturnValue({ deviceId: "device-a", fingerprint: "fixture-fingerprint" });
});

afterEach(() => {
	process.exitCode = initialExitCode;
	if (ttyDescriptor) Object.defineProperty(process.stderr, "isTTY", ttyDescriptor);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function run(...args: string[]) {
	return buildSyncRejoinCommand().parseAsync(
		["--db-path", dbPath, "--config", "fixture.json", ...args],
		{ from: "user" },
	);
}

it("uses the configured coordinator and displays the private link only to the terminal", async () => {
	mocks.run.mockImplementation(async (options) => {
		expect(options).toMatchObject({ dbPath, keysDir: "/fixture/keys", coordinatorUrl: origin });
		expect(options.assertCurrentContext()).toBe(true);
		options.openBrowser(privateLink);
		mocks.config.mockReturnValue({ sync_coordinator_url: "https://other.example.test" });
		expect(options.assertCurrentContext()).toBe(false);
		return { kind: "finalized", receipt: { groupIds: ["group-a"] } };
	});
	await run();
	expect(mocks.log.message).toHaveBeenCalledWith(privateLink, { output: process.stderr });
	expect(mocks.log.success).toHaveBeenCalledWith(expect.stringContaining("This device rejoined"), {
		output: process.stderr,
	});
	expect(mocks.config).toHaveBeenCalledWith("fixture.json");
});

it("does not start or expose a browser link for JSON or non-terminal callers", async () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	await run("--json");
	expect(log).toHaveBeenCalledWith(expect.stringContaining("interactive_flow_only"));
	expect(process.exitCode).toBe(2);
	tty(false);
	await run();
	expect(mocks.run).not.toHaveBeenCalled();
	expect(mocks.log.message).not.toHaveBeenCalled();
});

it("leaves an unknown outcome unconfirmed and asks the person to check sync", async () => {
	mocks.run.mockResolvedValueOnce({ kind: "unknown" });
	await run();
	expect(mocks.run).toHaveBeenCalledOnce();
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining("Check sync status"), {
		output: process.stderr,
	});
	expect(process.exitCode).toBe(1);
});

it("refuses a configured device ID that does not match the local key", async () => {
	vi.stubEnv("CODEMEM_DEVICE_ID", "unexpected-device");
	await run();
	expect(mocks.run).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});
