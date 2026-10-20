import { RemoteCoordinatorRequestError } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	coordinatorGrantIdentityGroupAction: vi.fn(),
	readCodememConfigFile: vi.fn(),
	readCodememConfigFileAtPath: vi.fn(),
	resolveDbPath: vi.fn(),
	confirm: vi.fn(),
	isCancel: vi.fn((value) => typeof value === "symbol"),
	log: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	...mocks,
}));
vi.mock("@clack/prompts", () => ({
	confirm: mocks.confirm,
	isCancel: mocks.isCancel,
	log: mocks.log,
}));

import { buildCoordinatorGrantIdentityGroupCommand } from "./coordinator-grant-identity-group.js";

const reference = `controller-v1:${"a".repeat(64)}`;
const config = {
	sync_coordinator_url: "https://saved.example.test",
	sync_coordinator_admin_secret: "fixture-admin-secret",
};
const grant = {
	coordinator_id: "coordinator-a",
	identity_id: "identity-a",
	group_id: "group-a",
	status: "active",
	revision: 1,
	source_kind: "controller_attestation",
	source_receipt_id: "receipt-a",
	created_at: "2026-10-02T12:00:00Z",
	revoked_at: null,
};
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const exitCode = process.exitCode;

function run(args: string[] = [], attestationId = reference) {
	return buildCoordinatorGrantIdentityGroupCommand().parseAsync([attestationId, ...args], {
		from: "user",
	});
}
function output() {
	return (
		JSON.stringify(Object.values(mocks.log).map((log) => log.mock.calls)) +
		JSON.stringify(vi.mocked(process.stdout.write).mock.calls) +
		JSON.stringify(vi.mocked(console.log).mock.calls)
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	for (const key of [
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
		"CODEMEM_SYNC_COORDINATOR_TIMEOUT_S",
	])
		vi.stubEnv(key, undefined);
	process.exitCode = undefined;
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	mocks.readCodememConfigFile.mockReturnValue(config);
	mocks.readCodememConfigFileAtPath.mockReturnValue(config);
	mocks.confirm.mockResolvedValue(false);
	mocks.isCancel.mockImplementation((value) => typeof value === "symbol");
	mocks.coordinatorGrantIdentityGroupAction.mockResolvedValue({ kind: "created", grant });
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(mocks.resolveDbPath).not.toHaveBeenCalled();
	expect(output()).not.toContain(config.sync_coordinator_admin_secret);
	if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	if (stderrTty) Object.defineProperty(process.stderr, "isTTY", stderrTty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	process.exitCode = exitCode;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it.each(["created", "existing"])(
	"explicit Yes issues one %s grant with backend-only credential",
	async (kind) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		mocks.coordinatorGrantIdentityGroupAction.mockResolvedValue({ kind, grant });
		// Act
		await run();
		// Assert
		expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ initialValue: false, output: process.stderr }),
		);
		expect(mocks.readCodememConfigFile).toHaveBeenCalledTimes(2);
		expect(mocks.coordinatorGrantIdentityGroupAction).toHaveBeenCalledExactlyOnceWith({
			remoteUrl: config.sync_coordinator_url,
			adminSecret: config.sync_coordinator_admin_secret,
			timeoutS: 3,
			attestationId: reference,
		});
		expect(mocks.log.success).toHaveBeenCalledExactlyOnceWith(
			`Transport enrollment grant ${kind}: coordinator coordinator-a; Identity identity-a; group group-a. No Team/Project access or local profile changes.`,
			{ output: process.stderr },
		);
		expect(process.stdout.write).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	},
);

it.each([false, Symbol("cancel"), undefined, "yes"])(
	"answer %s cannot issue a grant; default is No",
	async (answer) => {
		// Arrange
		mocks.confirm.mockResolvedValue(answer);
		// Act
		await run();
		// Assert
		expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
		expect(mocks.coordinatorGrantIdentityGroupAction).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(mocks.log.info).toHaveBeenCalledWith("Nothing changed.", { output: process.stderr });
	},
);

it.each(["json", "stdin", "stderr"])(
	"%s mode is a local-only preview even with Yes configured",
	async (mode) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		if (mode === "stdin")
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
		if (mode === "stderr")
			Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
		// Act
		await run(mode === "json" ? ["--json"] : []);
		// Assert
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.coordinatorGrantIdentityGroupAction).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
		if (mode === "json") {
			const preview = JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]?.[0]));
			expect(preview).toMatchObject({
				state: "preview",
				coordinator_url: config.sync_coordinator_url,
				attestation_id: reference,
				unchanged: true,
				eligibility_checked: false,
			});
			expect(preview.message).toContain("not Team/Project access");
		} else expect(process.stdout.write).not.toHaveBeenCalled();
	},
);

it.each(["url", "secret", "missing-url", "missing-secret"])(
	"reread %s drift denies mutation",
	async (mode) => {
		// Arrange
		const current = { ...config };
		if (mode === "url") current.sync_coordinator_url = "https://changed.example.test";
		if (mode === "secret") current.sync_coordinator_admin_secret = "changed-fixture-secret";
		if (mode === "missing-url") current.sync_coordinator_url = "";
		if (mode === "missing-secret") current.sync_coordinator_admin_secret = "";
		mocks.readCodememConfigFileAtPath.mockReturnValueOnce(config).mockReturnValueOnce(current);
		mocks.confirm.mockResolvedValue(true);
		// Act
		await run(["--config", "fixture.json"]);
		// Assert
		expect(mocks.readCodememConfigFileAtPath.mock.calls).toEqual([
			["fixture.json"],
			["fixture.json"],
		]);
		expect(mocks.coordinatorGrantIdentityGroupAction).not.toHaveBeenCalled();
		expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining("configuration changed"), {
			output: process.stderr,
		});
		expect(output()).not.toContain("changed-fixture-secret");
		expect(process.exitCode).toBe(1);
	},
);

it.each([
	{ sync_coordinator_url: "" },
	{ sync_coordinator_admin_secret: "" },
	{ sync_coordinator_url: "http://remote.example.test" },
	{ sync_coordinator_url: "https://user:private-password@example.test" },
	{ sync_coordinator_url: "https://saved.example.test/path" },
])("invalid configuration %j never prompts or POSTs", async (change) => {
	// Arrange
	mocks.readCodememConfigFile.mockReturnValue({ ...config, ...change });
	// Act
	await run();
	// Assert
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(mocks.coordinatorGrantIdentityGroupAction).not.toHaveBeenCalled();
	expect(mocks.log.error).toHaveBeenCalledOnce();
	expect(output()).not.toContain("private-password");
	expect(process.exitCode).toBeGreaterThan(0);
});

it.each(["wrong", `controller-v1:${"A".repeat(64)}`, `${reference}\n`])(
	"invalid reference %j fails before reading configuration",
	async (input) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		// Act
		await run(["--json"], input);
		// Assert
		expect(mocks.readCodememConfigFile).not.toHaveBeenCalled();
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.coordinatorGrantIdentityGroupAction).not.toHaveBeenCalled();
		expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
			error: "identity_group_grant_unavailable",
		});
		expect(process.exitCode).toBe(2);
	},
);

it.each(["--db-path", "-d", "--db"])(
	"shared %s and config target options never open a local DB",
	async (dbFlag) => {
		// Arrange
		mocks.confirm.mockResolvedValue(true);
		mocks.readCodememConfigFileAtPath.mockReturnValue({
			...config,
			sync_coordinator_timeout_s: 12,
		});
		// Act
		await run(["-c", "fixture.json", dbFlag, "fixture.sqlite"]);
		// Assert
		expect(mocks.readCodememConfigFileAtPath).toHaveBeenCalledTimes(2);
		expect(mocks.readCodememConfigFile).not.toHaveBeenCalled();
		expect(mocks.coordinatorGrantIdentityGroupAction).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutS: 12 }),
		);
	},
);

it("uses the shared environment target and credential without displaying the credential", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "https://environment.example.test");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "environment-fixture-secret");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_TIMEOUT_S", "9");
	mocks.confirm.mockResolvedValue(true);
	// Act
	await run();
	// Assert
	expect(mocks.coordinatorGrantIdentityGroupAction).toHaveBeenCalledExactlyOnceWith({
		remoteUrl: "https://environment.example.test",
		adminSecret: "environment-fixture-secret",
		timeoutS: 9,
		attestationId: reference,
	});
	expect(output()).not.toContain("environment-fixture-secret");
});

it.each(["--identity-id", "--group-id", "--coordinator", "--admin-secret", "--yes"])(
	"rejects unsupported authority/confirmation override %s",
	async (flag) => {
		// Arrange
		const command = buildCoordinatorGrantIdentityGroupCommand()
			.exitOverride()
			.configureOutput({ writeErr: () => {} });
		// Act
		const parse = command.parseAsync([reference, flag, "attacker"], { from: "user" });
		// Assert
		await expect(parse).rejects.toMatchObject({ code: "commander.unknownOption" });
		expect(mocks.coordinatorGrantIdentityGroupAction).not.toHaveBeenCalled();
		expect(mocks.confirm).not.toHaveBeenCalled();
	},
);

it.each([
	[401, "unauthorized", "refused"],
	[403, "unauthorized", "refused"],
	[400, "invalid_grant_input", "rejected the reference"],
	[409, "grant_authority_unavailable", "cannot authorize"],
	[429, "rate_limited", "rate limit"],
	[404, "unknown", "does not support"],
	[500, "private-remote-error", "outcome may be unknown"],
])("remote %s/%s uses fixed redacted guidance", async (status, code, message) => {
	// Arrange
	const error = new RemoteCoordinatorRequestError(status, code);
	error.message = "private-cookie-and-server-body";
	mocks.coordinatorGrantIdentityGroupAction.mockRejectedValue(error);
	mocks.confirm.mockResolvedValue(true);
	// Act
	await run();
	// Assert
	expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining(message), {
		output: process.stderr,
	});
	expect(output()).not.toMatch(/private-cookie|private-remote-error/);
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});

it("redacts raw configuration read failures without issuing a grant", async () => {
	// Arrange
	mocks.readCodememConfigFile.mockImplementation(() => {
		throw new Error("private-profile-content");
	});
	// Act
	await run();
	// Assert
	expect(output()).not.toContain("private-profile-content");
	expect(mocks.coordinatorGrantIdentityGroupAction).not.toHaveBeenCalled();
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});
