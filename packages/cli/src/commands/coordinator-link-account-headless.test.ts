import {
	CoordinatorAccountLinkError,
	type HeadlessLinkApproval,
	type LinkCoordinatorAccountHeadlessOptions,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	linkCoordinatorAccount: vi.fn(),
	linkCoordinatorAccountHeadless: vi.fn(),
	readAccountLinkDevice: vi.fn(),
	statSync: vi.fn(),
	readCoordinatorAccountLinkStatus: vi.fn(),
	readCodememConfigFile: vi.fn(),
	readCodememConfigFileAtPath: vi.fn(),
	resolveDbPath: vi.fn((path: string) => path),
	log: {
		error: vi.fn(),
		warn: vi.fn(),
		message: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		step: vi.fn(),
	},
	confirm: vi.fn(),
	text: vi.fn(),
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	...mocks,
}));
vi.mock("@clack/prompts", () => ({
	log: mocks.log,
	confirm: mocks.confirm,
	text: mocks.text,
	isCancel: (value: unknown) => typeof value === "symbol",
}));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	statSync: mocks.statSync,
}));

import { buildCoordinatorLinkAccountCommand } from "./coordinator-link-account.js";
import { confirmHeadlessApproval, showHeadlessCode } from "./coordinator-link-account-headless.js";

const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const exitCode = process.exitCode;
const out = { output: process.stderr };
const APPROVAL: HeadlessLinkApproval = {
	issuer: "https://accounts.google.com",
	subject: "subject-a",
	email: "ada@example.test",
	emailVerified: true,
	displayName: "Ada Example",
};

function restoreTty(stream: NodeJS.ReadStream | NodeJS.WriteStream, value?: PropertyDescriptor) {
	if (value) Object.defineProperty(stream, "isTTY", value);
	else Reflect.deleteProperty(stream, "isTTY");
}
beforeEach(() => {
	vi.clearAllMocks();
	for (const name of ["CODEMEM_SYNC_COORDINATOR_URL", "CODEMEM_ACTOR_ID", "CODEMEM_DEVICE_ID"])
		vi.stubEnv(name, undefined);
	process.exitCode = undefined;
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	mocks.readCodememConfigFile.mockReturnValue({
		sync_coordinator_url: "https://coordinator.example.test",
		actor_id: "identity-a",
	});
	mocks.statSync.mockReturnValue({ isFile: () => true, dev: 1n, ino: 2n });
	mocks.readAccountLinkDevice.mockReturnValue({
		deviceId: "device-a",
		fingerprint: "a".repeat(64),
	});
	mocks.readCoordinatorAccountLinkStatus.mockImplementation(async (options) => ({
		kind: "status",
		status: {
			version: 2,
			coordinatorId: "coordinator-a",
			groupId: options.groupId,
			deviceId: "device-a",
			fingerprint: "a".repeat(64),
			identityId: options.identityId,
			state: "unlinked",
			authority: "controller_attestation",
			account: null,
		},
	}));
	mocks.linkCoordinatorAccountHeadless.mockResolvedValue({
		coordinatorId: "coordinator-a",
		identityId: "identity-a",
		attemptId: "attempt-a",
		state: "finalized",
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	restoreTty(process.stderr, stderrTty);
	restoreTty(process.stdin, stdinTty);
	process.exitCode = exitCode;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const runCommand = (args: string[]) =>
	buildCoordinatorLinkAccountCommand()
		.exitOverride()
		.configureOutput({ writeErr: () => {} })
		.parseAsync(["group-a", "-d", "fixture.sqlite", ...args], { from: "user" });

describe("link-account --headless preconditions", () => {
	it("rejects --headless together with --loopback-host", async () => {
		// Act
		const run = runCommand(["--headless", "--loopback-host", "::1"]);
		// Assert
		await expect(run).rejects.toMatchObject({ code: "commander.conflictingOption" });
		expect(mocks.linkCoordinatorAccountHeadless).not.toHaveBeenCalled();
	});

	it.each(["stdin", "stderr"] as const)("requires a terminal on %s", async (stream) => {
		// Arrange
		Object.defineProperty(process[stream], "isTTY", { configurable: true, value: false });
		// Act
		await runCommand(["-H"]);
		// Assert
		expect(process.exitCode).toBe(2);
		expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining("docker exec -it"), out);
		expect(mocks.readCodememConfigFile).not.toHaveBeenCalled();
		expect(mocks.linkCoordinatorAccountHeadless).not.toHaveBeenCalled();
	});

	it("rejects --json as an interactive flow", async () => {
		// Act
		await runCommand(["--headless", "--json"]);
		// Assert
		expect(process.exitCode).toBe(2);
		expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
			error: "interactive_flow_only",
		});
		expect(mocks.linkCoordinatorAccountHeadless).not.toHaveBeenCalled();
	});

	it("skips an Identity that is already linked", async () => {
		// Arrange
		mocks.readCoordinatorAccountLinkStatus.mockImplementation(async (options) => ({
			kind: "status",
			status: { identityId: options.identityId, state: "linked", coordinatorId: "coordinator-a" },
		}));
		// Act
		await runCommand(["--headless"]);
		// Assert
		expect(mocks.linkCoordinatorAccountHeadless).not.toHaveBeenCalled();
		expect(mocks.log.success).toHaveBeenCalledWith(expect.stringContaining("already linked"), out);
	});
});

describe("link-account --headless flow", () => {
	it("prints the code, device, expiry and progress, then reports success", async () => {
		// Arrange
		mocks.linkCoordinatorAccountHeadless.mockImplementation(
			async (options: LinkCoordinatorAccountHeadlessOptions) => {
				options.onCode({
					verificationUri: "https://coordinator.example.test/auth/link/device",
					code: "BCDF-GHJK",
					fingerprint: "SHA256:aaaaaaaa...aaaaaaaa",
					deviceId: "device-a",
					expiresAtMs: Date.UTC(2026, 10, 6, 20, 0),
				});
				for (const state of ["pending", "browser_claimed", "oidc_verified", "confirmed"])
					options.onState?.(state);
				return { identityId: "identity-a", state: "finalized" };
			},
		);
		// Act
		await runCommand(["--headless"]);
		// Assert
		expect(mocks.linkCoordinatorAccountHeadless).toHaveBeenCalledWith(
			expect.objectContaining({
				groupId: "group-a",
				expectedIdentityId: "identity-a",
				expectedAuthority: "controller_attestation",
				expectedCoordinatorId: "coordinator-a",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(mocks.log.step).toHaveBeenCalledWith(
			"On any computer, open https://coordinator.example.test/auth/link/device and enter code:  BCDF-GHJK",
			out,
		);
		expect(mocks.log.message).toHaveBeenCalledWith(
			"This device: device-a  ·  key SHA256:aaaaaaaa...aaaaaaaa",
			out,
		);
		expect(mocks.log.message).toHaveBeenCalledWith(
			expect.stringMatching(/^The code expires at .+\.$/),
			out,
		);
		expect(mocks.log.info.mock.calls.map(([line]) => line)).toEqual([
			"Waiting for the code…",
			"Code entered, signing in…",
			"Reviewing in browser…",
		]);
		expect(mocks.log.success).toHaveBeenCalledWith("Linked.", out);
		expect(process.exitCode).toBeUndefined();
	});

	it.each([
		{
			code: "link_declined",
			text: "declined",
		},
		{
			code: "headless_unsupported",
			text: "This coordinator does not support headless linking. Ask its operator to apply migration 0043 and deploy.",
		},
	] as const)("reports $code", async ({ code, text }) => {
		// Arrange
		mocks.linkCoordinatorAccountHeadless.mockRejectedValue(new CoordinatorAccountLinkError(code));
		// Act
		await runCommand(["--headless"]);
		// Assert
		expect(process.exitCode).toBe(1);
		expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining(text), out);
	});
});

describe("headless code display", () => {
	it("keeps the device and fingerprint on one line whatever the device ID holds", () => {
		// Act
		showHeadlessCode({
			verificationUri: "https://coordinator.example.test/auth/link/device",
			code: "BCDF-GHJK",
			fingerprint: "SHA256:aaaaaaaa...aaaaaaaa",
			deviceId: "device\u2028key SHA256:forged\u2029-a",
			expiresAtMs: Date.UTC(2026, 10, 6, 20, 0),
		});
		// Assert
		expect(mocks.log.message).toHaveBeenCalledWith(
			"This device: device?key SHA256:forged?-a  ·  key SHA256:aaaaaaaa...aaaaaaaa",
			out,
		);
	});
});

describe("headless approval prompt", () => {
	const signal = new AbortController().signal;

	it.each([
		{ verified: true, label: "(verified by Google)", answer: true, linked: true },
		{ verified: false, label: "(email not verified by Google)", answer: false, linked: false },
		{
			verified: null,
			label: "(email not verified by Google)",
			answer: Symbol("cancel"),
			linked: false,
		},
	])("shows $label and links only on yes", async ({ verified, label, answer, linked }) => {
		// Arrange
		mocks.confirm.mockResolvedValue(answer);
		// Act
		const result = await confirmHeadlessApproval(
			"identity-a",
			{ ...APPROVAL, emailVerified: verified },
			{ signal },
		);
		// Assert
		expect(result).toBe(linked);
		expect(mocks.log.info).toHaveBeenCalledWith(
			`Approved in the browser by ada@example.test ${label}`,
			out,
		);
		expect(mocks.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Link Identity identity-a to this Google account? (y/N)",
				initialValue: false,
				signal,
			}),
		);
	});

	it.each([
		{ name: "Ada Example", shown: "Ada Example", typed: "link", linked: true },
		{ name: null, shown: "an account with no email", typed: "yes", linked: false },
		{ name: "Ada\u001b[2JExample", shown: "Ada?[2JExample", typed: " link ", linked: true },
	])("requires typing link without an email ($shown)", async ({ name, shown, typed, linked }) => {
		// Arrange
		mocks.text.mockResolvedValue(typed);
		// Act
		const result = await confirmHeadlessApproval(
			"identity-a",
			{ ...APPROVAL, email: null, emailVerified: null, displayName: name },
			{ signal },
		);
		// Assert
		expect(result).toBe(linked);
		expect(mocks.log.warn).toHaveBeenCalledWith(`Approved in the browser by ${shown}`, out);
		expect(mocks.text).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("Type link"), signal }),
		);
		expect(mocks.confirm).not.toHaveBeenCalled();
	});
});
