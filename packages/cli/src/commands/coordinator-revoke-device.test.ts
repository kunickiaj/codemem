import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	readCodememConfigFile: vi.fn(),
	readCodememConfigFileAtPath: vi.fn(),
	confirm: vi.fn(),
	isCancel: vi.fn((value) => typeof value === "symbol"),
	log: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	readCodememConfigFile: mocks.readCodememConfigFile,
	readCodememConfigFileAtPath: mocks.readCodememConfigFileAtPath,
}));
vi.mock("@clack/prompts", () => ({
	confirm: mocks.confirm,
	isCancel: mocks.isCancel,
	log: mocks.log,
}));

import { COORDINATOR_DEVICE_REVOCATION_SCOPE as scope } from "@codemem/core";
import { buildCoordinatorCommand } from "./coordinator.js";
import { buildCoordinatorRevokeDeviceCommand } from "./coordinator-revoke-device.js";
import { syncCommand } from "./sync.js";

// Only terminal/config reads/fetch are replaced: the public action and HTTP client run unchanged.
const config = {
	sync_coordinator_url: "https://saved.example.test",
	sync_coordinator_admin_secret: "fixture-admin-secret",
};
const key = "a".repeat(64),
	digest = "b".repeat(64);
const preview = {
	state: "ready",
	version: 1,
	coordinator_id: "coordinator-a",
	group_id: "group-a",
	device_id: "device-a",
	key_id: key,
	scope,
	expected_digest: digest,
};
const { expected_digest: _digest, ...subjects } = preview;
const committed = {
	...subjects,
	state: "revoked",
	revocations: [
		{
			subject_kind: "device_id",
			subject_value: "device-a",
			revocation_id: "first-device",
			created_at: "device retained timestamp",
		},
		{
			subject_kind: "ed25519_key",
			subject_value: key,
			revocation_id: "first-key",
			created_at: "2001-01-01T00:00:00+07:00",
		},
	],
};
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const exitCode = process.exitCode;
function reply(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), { status });
}
function run(args: string[] = [], group = "group-a", device = "device-a") {
	return buildCoordinatorRevokeDeviceCommand().parseAsync([group, device, ...args], {
		from: "user",
	});
}
function output() {
	return JSON.stringify([
		...Object.values(mocks.log).map((log) => log.mock.calls),
		vi.mocked(process.stdout.write).mock.calls,
		vi.mocked(console.log).mock.calls,
	]);
}
function bodies() {
	return vi
		.mocked(fetch)
		.mock.calls.map(([, init]) => JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)));
}
beforeEach(() => {
	vi.resetAllMocks();
	process.exitCode = undefined;
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	mocks.readCodememConfigFile.mockReturnValue({ ...config });
	mocks.readCodememConfigFileAtPath.mockReturnValue({ ...config });
	mocks.confirm.mockResolvedValue(false);
	mocks.isCancel.mockImplementation((value) => typeof value === "symbol");
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockRejectedValue(new Error("unexpected request"))
			.mockResolvedValueOnce(reply(preview)),
	);
});
afterEach(() => {
	expect(output()).not.toContain(config.sync_coordinator_admin_secret);
	if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	if (stderrTty) Object.defineProperty(process.stderr, "isTTY", stderrTty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it.each([false, Symbol("cancel")])(
	"defaults to No and stops after network preview for %s",
	async (answer) => {
		// Arrange
		mocks.confirm.mockResolvedValueOnce(answer);
		// Act
		await run();
		// Assert
		expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ initialValue: false, output: process.stderr }),
		);
		expect(fetch).toHaveBeenCalledOnce();
		expect(bodies()).toEqual([{ group_id: "group-a", device_id: "device-a" }]);
		expect(output()).toContain("No revocation requested.");
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	},
);
it.each(["json", "stdin", "stderr"])("performs only network preview for %s", async (mode) => {
	// Arrange
	if (mode !== "json")
		Object.defineProperty(process[mode as "stdin" | "stderr"], "isTTY", {
			configurable: true,
			value: false,
		});
	mocks.confirm.mockResolvedValueOnce(true);
	// Act
	await run(mode === "json" ? ["--json"] : []);
	// Assert
	expect(fetch).toHaveBeenCalledOnce();
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(mocks.log.success).not.toHaveBeenCalled();
	if (mode === "json")
		expect(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]?.[0]))).toMatchObject({
			preview,
			network_request: true,
			unchanged: true,
		});
	else expect(output()).toContain("Network preview only");
});
it("confirms exact reviewed subjects once and displays both retained references without date normalization", async () => {
	// Arrange
	mocks.confirm.mockResolvedValueOnce(true);
	vi.mocked(fetch).mockResolvedValueOnce(reply(committed));
	// Act
	await run(["--config", "fixture-config.json"]);
	// Assert
	expect(mocks.readCodememConfigFileAtPath).toHaveBeenNthCalledWith(1, "fixture-config.json");
	expect(mocks.readCodememConfigFileAtPath).toHaveBeenNthCalledWith(2, "fixture-config.json");
	expect(mocks.readCodememConfigFile).not.toHaveBeenCalled();
	expect(bodies()).toEqual([
		{ group_id: "group-a", device_id: "device-a" },
		{ group_id: "group-a", device_id: "device-a", expected_digest: digest },
	]);
	expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
		`${config.sync_coordinator_url}/v1/admin/devices/revoke-preview`,
		`${config.sync_coordinator_url}/v1/admin/devices/revoke`,
	]);
	expect(mocks.log.success).toHaveBeenCalledOnce();
	for (const row of committed.revocations) {
		expect(output()).toContain(row.revocation_id);
		expect(output()).toContain(row.created_at);
	}
	expect(output()).toContain(key);
	expect(process.exitCode).toBeUndefined();
});
it("quotes retained receipt data with visible escapes instead of terminal controls", async () => {
	// Arrange: inspect raw logger arguments, not JSON-stringified mocks that would hide controls.
	const text = "ledger\n\u001b\u0085\u202e\u2028\u2029\ud800";
	const quoted = '"ledger\\n\\u001b\\u{85}\\u{202e}\\u{2028}\\u{2029}\\ud800"';
	mocks.confirm.mockResolvedValueOnce(true);
	vi.mocked(fetch).mockResolvedValueOnce(
		reply({
			...committed,
			revocations: committed.revocations.map((row) => ({
				...row,
				revocation_id: text,
				created_at: text,
			})),
		}),
	);
	// Act
	await run();
	// Assert
	const logs = Object.values(mocks.log).flatMap((logger) =>
		logger.mock.calls.map(([message]) => String(message)),
	);
	const receipts = logs.filter((message) => message.includes("retained reference:"));
	expect(receipts).toEqual(
		committed.revocations.map(
			(row) =>
				`${row.subject_kind}: ${row.subject_value}; retained reference: ${quoted}; created: ${quoted}`,
		),
	);
	for (const receipt of receipts) expect(receipt).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u);
	for (const log of logs) {
		for (const character of ["\u001b", "\u0085", "\u202e", "\u2028", "\u2029", "\ud800"])
			expect(log).not.toContain(character);
	}
	expect(mocks.log.success).toHaveBeenCalledOnce();
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(process.exitCode).toBeUndefined();
});
it("shows exact coordinator/key/scope and alias/distinct-device limits without claiming UI authority", async () => {
	// Arrange
	mocks.confirm.mockResolvedValueOnce(false);
	// Act
	await run();
	// Assert
	for (const text of [
		"Coordinator: coordinator-a",
		"Evidence group: group-a",
		"Global device ID: device-a",
		`Canonical key ID: ${key}`,
		scope,
		"ANY key",
		"ANY device ID",
		"ALL groups",
		"BOTH its device ID and key differ",
		"No immediate offline enforcement",
		"manual/direct-peer",
		"stored memories are not rewritten",
	])
		expect(output()).toContain(text);
	expect(output()).not.toMatch(/owner authorized|Team administrator authorized|signed out/);
	expect(fetch).toHaveBeenCalledOnce();
});
it.each([
	null,
	{},
	{ ...config, sync_coordinator_url: "http://localhost" },
	{ ...config, sync_coordinator_admin_secret: "" },
	{ ...config, sync_coordinator_admin_secret: "bad\nheader" },
	{ ...config, sync_coordinator_timeout_s: "3" },
	{ ...config, sync_coordinator_timeout_s: 0 },
])("rejects missing/invalid saved config %j before preview", async (saved) => {
	// Arrange
	mocks.readCodememConfigFile.mockReturnValueOnce(saved);
	// Act
	await run(["--json"]);
	// Assert
	expect(fetch).not.toHaveBeenCalled();
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(output()).toContain("revocation_unavailable");
	expect(process.exitCode).toBe(1);
});
it.each([
	{},
	{ ...config, sync_coordinator_url: "https://changed.example.test" },
	{ ...config, sync_coordinator_admin_secret: "changed-secret" },
	{ ...config, sync_coordinator_timeout_s: 4 },
	{ ...config, sync_coordinator_url: "http://localhost" },
])("rereads config and blocks commit for missing/invalid/changed values %j", async (changed) => {
	// Arrange
	mocks.confirm.mockResolvedValueOnce(true);
	mocks.readCodememConfigFile.mockReturnValueOnce(config).mockReturnValueOnce(changed);
	// Act
	await run();
	// Assert
	expect(fetch).toHaveBeenCalledOnce();
	expect(output()).toContain("Operator configuration changed or is unavailable");
	expect(output()).toContain("No revocation requested");
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});
it("blocks commit when rereading config throws", async () => {
	// Arrange
	mocks.confirm.mockResolvedValueOnce(true);
	mocks.readCodememConfigFile.mockReturnValueOnce(config).mockImplementationOnce(() => {
		throw new Error("private config detail");
	});
	// Act
	await run();
	// Assert
	expect(fetch).toHaveBeenCalledOnce();
	expect(output()).toContain("Operator configuration changed");
	expect(output()).not.toContain("private config detail");
});
it("does not use environment credentials to repair missing saved configuration", async () => {
	// Arrange
	mocks.readCodememConfigFile.mockReturnValueOnce({});
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", config.sync_coordinator_url);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "environment-secret");
	// Act
	await run(["--json"]);
	// Assert
	expect(fetch).not.toHaveBeenCalled();
	expect(output()).toContain("revocation_unavailable");
	expect(output()).not.toContain("environment-secret");
});
it.each(["--yes", "--admin-secret", "--secret", "--expected-digest", "--key-id"])(
	"rejects bypass/secret argument %s",
	async (flag) => {
		// Arrange
		const command = buildCoordinatorRevokeDeviceCommand()
			.exitOverride()
			.configureOutput({ writeErr: () => {} });
		// Act
		const result = command.parseAsync(["group-a", "device-a", flag], { from: "user" });
		// Assert
		await expect(result).rejects.toMatchObject({ code: "commander.unknownOption" });
		expect(fetch).not.toHaveBeenCalled();
	},
);
it.each(["", " bad", "bad\n", "bad\u200b", "x".repeat(257)])(
	"rejects invalid target %j without network",
	async (device) => {
		// Arrange
		const args = ["--json"];
		// Act
		await run(args, "group-a", device);
		// Assert
		expect(fetch).not.toHaveBeenCalled();
		expect(output()).toContain("revocation_invalid_input");
		expect(process.exitCode).toBe(2);
	},
);
it.each(["revocation_preview_stale", "revocation_target_unavailable"])(
	"treats only HTTP 409 %s as definitive after dispatch",
	async (error) => {
		// Arrange
		mocks.confirm.mockResolvedValueOnce(true);
		vi.mocked(fetch).mockResolvedValueOnce(reply({ error }, 409));
		// Act
		await run();
		// Assert
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(output()).toContain("Revocation rejected");
		expect(output()).not.toContain("outcome is unknown");
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	},
);
it.each([400, 401, 403, 500, 302])(
	"does not treat stale code at HTTP %i as definitive",
	async (status) => {
		// Arrange
		mocks.confirm.mockResolvedValueOnce(true);
		vi.mocked(fetch).mockResolvedValueOnce(
			reply({ error: "revocation_preview_stale", diagnostic: "private-body" }, status),
		);
		// Act
		await run();
		// Assert
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(output()).toContain("Revocation outcome is unknown");
		expect(output()).not.toContain("private-body");
		expect(output()).not.toContain("Revocation rejected");
	},
);
it.each(
	[
		null,
		[],
		{ ...committed, key_id: "c".repeat(64) },
		{ ...committed, coordinator_id: "other" },
		{ error: "device_revocation_incomplete" },
	].map((payload) => ({ payload })),
)(
	"keeps malformed post-dispatch response %j unknown without rollback/retry",
	async ({ payload }) => {
		// Arrange
		mocks.confirm.mockResolvedValueOnce(true);
		vi.mocked(fetch).mockResolvedValueOnce(reply(payload));
		// Act
		await run();
		// Assert
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(output()).toContain(
			"It may have committed; do not assume rollback or retry automatically",
		);
		expect(output()).not.toContain("No revocation requested");
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	},
);
it.each([false, true])(
	"classifies transport failure using actual dispatch phase %s",
	async (commit) => {
		// Arrange
		mocks.confirm.mockResolvedValueOnce(true);
		if (!commit) vi.mocked(fetch).mockReset();
		vi.mocked(fetch).mockRejectedValueOnce(new Error("private transport cause"));
		// Act
		await run();
		// Assert
		expect(fetch).toHaveBeenCalledTimes(commit ? 2 : 1);
		expect(output()).toContain(
			commit ? "Revocation outcome is unknown" : "No revocation requested",
		);
		expect(output()).not.toContain("private transport cause");
		expect(mocks.log.success).not.toHaveBeenCalled();
	},
);
it("does not mark the write phase when actual action rejects a malformed credential before dispatch", async () => {
	// Arrange: setup permits text that Headers rejects; real Core validation must precede onDispatch.
	mocks.confirm.mockResolvedValueOnce(true);
	mocks.readCodememConfigFile.mockReturnValue({ ...config, sync_coordinator_admin_secret: "🔒" });
	// Act
	await run();
	// Assert
	expect(fetch).not.toHaveBeenCalled();
	expect(output()).toContain("No revocation requested");
	expect(output()).not.toContain("outcome is unknown");
});
it("registers independent equivalent top-level and sync-alias commands", () => {
	// Arrange
	const top = buildCoordinatorCommand();
	const alias = syncCommand.commands.find((command) => command.name() === "coordinator");
	// Act
	const first = top.commands.find((command) => command.name() === "revoke-device");
	const second = alias?.commands.find((command) => command.name() === "revoke-device");
	// Assert
	expect(first).toBeDefined();
	expect(second).toBeDefined();
	expect(first).not.toBe(second);
	expect(first?.helpInformation()).toContain("Usage: coordinator revoke-device");
	expect(second?.helpInformation()).toContain("Usage: sync coordinator revoke-device");
	expect(first?.registeredArguments).toEqual(second?.registeredArguments);
	expect(first?.options).toEqual(second?.options);
	expect(first?.options.map((option) => option.long)).toEqual(["--config", "--json"]);
});

it.each(["top-level", "sync-alias"])(
	"executes real network preview through %s registration",
	async (entry) => {
		// Arrange
		const args = ["coordinator", "revoke-device", "group-a", "device-a", "--json"];
		// Act
		if (entry === "sync-alias") await syncCommand.parseAsync(args, { from: "user" });
		else await buildCoordinatorCommand().parseAsync(args.slice(1), { from: "user" });
		// Assert
		expect(fetch).toHaveBeenCalledOnce();
		expect(bodies()).toEqual([{ group_id: "group-a", device_id: "device-a" }]);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]?.[0]))).toMatchObject({
			preview,
			unchanged: true,
			network_request: true,
		});
	},
);
