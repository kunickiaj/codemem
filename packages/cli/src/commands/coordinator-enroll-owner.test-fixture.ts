import { afterEach, beforeEach, type Mock, vi } from "vitest";

type EnrollmentMocks = {
	execFile: Mock;
	enrollOwnerProfile: Mock;
	readCodememConfigFileAtPath: Mock<() => Record<string, unknown>>;
	readCoordinatorSyncConfig: Mock<
		(config?: Record<string, unknown>) => {
			syncCoordinatorUrl?: string;
			syncCoordinatorGroups?: string[];
		}
	>;
	resolveCodememConfigPath: Mock<(value?: string, mode?: string) => { resolved: { path: string } }>;
	resolveDbPath: Mock<(value?: string) => string>;
	resolveKeyPaths: Mock<() => string[]>;
	log: Record<"error" | "warn" | "message" | "success" | "info", Mock>;
};

const mocks: EnrollmentMocks = vi.hoisted(() => ({
	execFile: vi.fn((_file, _args, _options, callback) => callback(new Error("ENOENT"))),
	enrollOwnerProfile: vi.fn(),
	readCodememConfigFileAtPath: vi.fn(
		(): Record<string, unknown> => ({ sync_coordinator_url: "https://coordinator.example" }),
	),
	readCoordinatorSyncConfig: vi.fn(
		(
			_config?: Record<string, unknown>,
		): {
			syncCoordinatorUrl?: string;
			syncCoordinatorGroups?: string[];
		} => ({ syncCoordinatorUrl: "https://coordinator.example" }),
	),
	resolveCodememConfigPath: vi.fn(() => ({ resolved: { path: "fixture-config.json" } })),
	resolveDbPath: vi.fn((value?: string) => value ?? "fixture.sqlite"),
	resolveKeyPaths: vi.fn(() => ["fixture-keys/device.key", "fixture-keys/device.key.pub"]),
	log: { error: vi.fn(), warn: vi.fn(), message: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

export { mocks };

vi.mock("@codemem/core", async (importOriginal) => {
	const { OwnerProfileEnrollmentError, expandUserPath } =
		await importOriginal<typeof import("@codemem/core")>();
	return { ...mocks, OwnerProfileEnrollmentError, expandUserPath };
});
vi.mock("@clack/prompts", () => ({ log: mocks.log }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

export { expandUserPath, OwnerProfileEnrollmentError } from "@codemem/core";

import { buildCoordinatorEnrollOwnerCommand } from "./coordinator-enroll-owner.js";

const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const exitCode = process.exitCode;
export const preparedReviewDigest = "0123456789abcdef".repeat(4);
export const forbiddenOverrides = [
	"CODEMEM_SYNC_COORDINATOR_URL",
	"CODEMEM_SYNC_COORDINATOR_GROUP",
	"CODEMEM_SYNC_COORDINATOR_GROUPS",
	"CODEMEM_WORKSPACE_ID",
	"CODEMEM_ACTOR_ID",
	"CODEMEM_DEVICE_ID",
	"CODEMEM_ACTOR_DISPLAY_NAME",
];
export const enrollmentModes = [
	{ mode: "prepare JSON", args: ["--prepare", "--json"] },
	{ mode: "interactive resume", args: ["--resume", "--review-digest", preparedReviewDigest] },
];
export const parseSelected = (group: string, args: string[]) =>
	buildCoordinatorEnrollOwnerCommand().parseAsync([group, ...args], { from: "user" });
export const parse = (args: string[]) => parseSelected("group", ["-d", "fixture.sqlite", ...args]);

// Vitest isolates this module per test file; reset implementations as well as call history
// so shuffled cases cannot inherit profile resolvers or queued enrollment results.
beforeEach(() => {
	vi.resetAllMocks();
	mocks.execFile.mockImplementation((_file, _args, _options, callback) =>
		callback(new Error("ENOENT")),
	);
	mocks.readCodememConfigFileAtPath.mockReturnValue({
		sync_coordinator_url: "https://coordinator.example",
	});
	mocks.readCoordinatorSyncConfig.mockReturnValue({
		syncCoordinatorUrl: "https://coordinator.example",
	});
	mocks.resolveCodememConfigPath.mockReturnValue({
		resolved: { path: "fixture-config.json" },
	});
	mocks.resolveDbPath.mockImplementation((value?: string) => value ?? "fixture.sqlite");
	mocks.resolveKeyPaths.mockReturnValue(["fixture-keys/device.key", "fixture-keys/device.key.pub"]);
	mocks.enrollOwnerProfile.mockResolvedValue({
		kind: "adopted",
		identityId: "verified-identity",
		bindingId: "verified-binding",
		groups: ["group"],
	});
	process.exitCode = undefined;
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	for (const variable of [
		...forbiddenOverrides,
		"CODEMEM_KEYS_DIR",
		"CODEMEM_CONFIG",
		"CODEMEM_DB",
		"CODEMEM_SYNC_KEY_STORE",
	])
		vi.stubEnv(variable, undefined);
});
afterEach(() => {
	if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
