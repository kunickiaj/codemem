import { RemoteCoordinatorRequestError } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	coordinatorAuthControllerReviewAction: vi.fn(),
	readCoordinatorOwnerReviewLocalEvidence: vi.fn(),
	readCodememConfigFile: vi.fn(),
	readCodememConfigFileAtPath: vi.fn(),
	resolveDbPath: vi.fn((path: string) => path),
	confirm: vi.fn(),
	isCancel: vi.fn((value) => typeof value === "symbol"),
	log: { error: vi.fn(), warn: vi.fn(), message: vi.fn(), success: vi.fn(), info: vi.fn() },
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

import { buildCoordinatorReviewDeviceOwnerCommand } from "./coordinator-review-device-owner.js";

const local = {
	state: "ready",
	reasons: [],
	device: {
		deviceId: "device-a",
		publicKey: "ssh-ed25519 private-display-key",
		fingerprint: "a".repeat(64),
	},
	identity: { identityId: "actor-a", source: "config" },
	memoryCounts: { current: 2, others: 3, unknown: 1 },
	teamCount: 1,
	projectCount: 2,
};
const preview = {
	state: "ready",
	reasons: [],
	coordinator_id: "server-coordinator",
	evidence_digest: "b".repeat(64),
	enrollment: {
		device_id: "device-a",
		fingerprint: "a".repeat(64),
		identity_label: "none",
		display_name: null,
	},
	reviewed_invites: [],
};
const config = {
	actor_id: "actor-a",
	sync_coordinator_url: "https://saved.example.test",
	sync_coordinator_admin_secret: "fixture-secret",
};
const reviewedOwner = {
	state: "created",
	coordinator_id: preview.coordinator_id,
	group_id: "group-a",
	device_id: "device-a",
	identity_id: "actor-a",
	fingerprint: local.device.fingerprint,
	created_at: "2026-10-05T00:00:00Z",
};
const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const originalExitCode = process.exitCode;
function run(extra: string[] = []) {
	return buildCoordinatorReviewDeviceOwnerCommand().parseAsync(
		["group-a", "-d", "fixture.sqlite", ...extra],
		{ from: "user" },
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("CODEMEM_ACTOR_ID", undefined);
	vi.stubEnv("CODEMEM_DEVICE_ID", undefined);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", undefined);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", undefined);
	process.exitCode = undefined;
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	mocks.readCodememConfigFile.mockReturnValue(config);
	mocks.readCodememConfigFileAtPath.mockReturnValue(config);
	mocks.readCoordinatorOwnerReviewLocalEvidence.mockReturnValue(structuredClone(local));
	mocks.coordinatorAuthControllerReviewAction.mockResolvedValue(preview);
	mocks.confirm.mockResolvedValue(false);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	process.exitCode = originalExitCode;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("JSON previews once with shared options and never prompts or exposes the public key/credential", async () => {
	// Arrange
	const args = ["--json", "-c", "fixture.json", "-u", "https://override.example.test"];
	// Act
	await run(args);
	// Assert
	expect(mocks.readCodememConfigFileAtPath).toHaveBeenCalledWith("fixture.json");
	expect(mocks.readCoordinatorOwnerReviewLocalEvidence).toHaveBeenCalledWith({
		dbPath: "fixture.sqlite",
		actorId: "actor-a",
		identitySource: "config",
		deviceIdOverride: undefined,
	});
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledExactlyOnceWith({
		remoteUrl: "https://override.example.test",
		adminSecret: "fixture-secret",
		groupId: "group-a",
		deviceId: "device-a",
		identityId: "actor-a",
		fingerprint: local.device.fingerprint,
	});
	const output = String(vi.mocked(process.stdout.write).mock.calls[0]?.[0]);
	expect(JSON.parse(output)).toMatchObject({ unchanged: true, review: { state: "ready" } });
	expect(output).not.toContain(local.device.publicKey);
	expect(output).not.toContain("fixture-secret");
	expect(mocks.confirm).not.toHaveBeenCalled();
});
it.each([false, Symbol("cancel")])(
	"No/Cancel %s never commits; confirmation defaults to No",
	async (answer) => {
		// Arrange
		mocks.confirm.mockResolvedValue(answer);
		// Act
		await run();
		// Assert
		expect(mocks.confirm).toHaveBeenCalledWith(
			expect.objectContaining({ initialValue: false, output: process.stderr }),
		);
		expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
		expect(mocks.log.success).not.toHaveBeenCalled();
	},
);

it("explicit approval rereads local identity before committing the server digest", async () => {
	// Arrange
	mocks.confirm.mockResolvedValue(true);
	mocks.coordinatorAuthControllerReviewAction
		.mockResolvedValueOnce(preview)
		.mockResolvedValueOnce(reviewedOwner);
	// Act
	await run();
	// Assert
	expect(mocks.readCoordinatorOwnerReviewLocalEvidence).toHaveBeenCalledTimes(2);
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenLastCalledWith(
		expect.objectContaining({
			confirmEvidenceDigest: preview.evidence_digest,
			identityId: "actor-a",
		}),
	);
	expect(mocks.log.success).toHaveBeenCalledOnce();
	expect(mocks.log.info).toHaveBeenLastCalledWith(
		expect.stringContaining("Reuse the same --coordinator, --config, and --db-path"),
		{ output: process.stderr },
	);
});

it.each([
	{ name: "coordinator only", args: ["--coordinator", "https://override.example.test"] },
	{ name: "config only", args: ["--config", "fixture.json"] },
	{ name: "db-path only", args: ["--db-path", "fixture.sqlite"] },
	{ name: "short database alias", args: ["-d", "fixture.sqlite"] },
	{
		name: "coordinator and config",
		args: ["--coordinator", "https://override.example.test", "--config", "fixture.json"],
	},
	{
		name: "coordinator and database",
		args: ["--coordinator", "https://override.example.test", "--db-path", "fixture.sqlite"],
	},
	{
		name: "config and database",
		args: ["--config", "fixture.json", "--db-path", "fixture.sqlite"],
	},
	{
		name: "all target overrides",
		args: [
			"--coordinator",
			"https://override.example.test",
			"--config",
			"fixture.json",
			"--db-path",
			"fixture.sqlite",
		],
	},
	{ name: "saved defaults", args: [] },
])("$name preserves the review target and gives safe linking guidance", async ({ args }) => {
	// Arrange: parse directly so single-option cases do not inherit run()'s database override.
	const hasCoordinator = args.includes("--coordinator");
	const hasConfig = args.includes("--config");
	const dbPath = args.includes("--db-path") || args.includes("-d") ? "fixture.sqlite" : undefined;
	const request = {
		remoteUrl: hasCoordinator ? "https://override.example.test" : config.sync_coordinator_url,
		adminSecret: config.sync_coordinator_admin_secret,
		groupId: "group-a",
		deviceId: "device-a",
		identityId: "actor-a",
		fingerprint: local.device.fingerprint,
	};
	mocks.confirm.mockResolvedValue(true);
	mocks.coordinatorAuthControllerReviewAction
		.mockResolvedValueOnce(preview)
		.mockResolvedValueOnce(reviewedOwner);
	// Act
	await buildCoordinatorReviewDeviceOwnerCommand().parseAsync(["group-a", ...args], {
		from: "user",
	});
	// Assert: both preview and commit reuse the chosen target without opening a real database.
	expect(mocks.coordinatorAuthControllerReviewAction.mock.calls).toEqual([
		[request],
		[{ ...request, confirmEvidenceDigest: preview.evidence_digest }],
	]);
	expect(mocks.resolveDbPath.mock.calls).toEqual([[dbPath], [dbPath]]);
	expect(mocks.readCoordinatorOwnerReviewLocalEvidence.mock.calls).toEqual([
		[{ dbPath, actorId: "actor-a", identitySource: "config", deviceIdOverride: undefined }],
		[{ dbPath, actorId: "actor-a", identitySource: "config", deviceIdOverride: undefined }],
	]);
	if (hasConfig) {
		expect(mocks.readCodememConfigFileAtPath.mock.calls).toEqual([
			["fixture.json"],
			["fixture.json"],
		]);
		expect(mocks.readCodememConfigFile).not.toHaveBeenCalled();
	} else {
		expect(mocks.readCodememConfigFile).toHaveBeenCalledTimes(2);
		expect(mocks.readCodememConfigFileAtPath).not.toHaveBeenCalled();
	}
	expect(mocks.log.success).toHaveBeenCalledOnce();
	const followUp = String(mocks.log.info.mock.calls.at(-1)?.[0]);
	expect(followUp).toContain("codemem coordinator link-account");
	if (args.length) {
		expect(followUp).toContain("Reuse the same --coordinator, --config, and --db-path");
		expect(followUp).not.toContain("link-account 'group-a'");
		expect(followUp).not.toContain("fixture.sqlite");
		expect(followUp).not.toContain("fixture.json");
		expect(followUp).not.toContain("https://override.example.test");
	} else {
		expect(followUp).toContain("link-account 'group-a'");
		expect(followUp).not.toContain("Reuse the same");
	}
});

it.each(["actor", "key"])("changed local %s during approval prevents commit", async (changed) => {
	// Arrange
	mocks.confirm.mockResolvedValue(true);
	const after = structuredClone(local);
	if (changed === "actor") after.identity.identityId = "actor-b";
	else after.device.publicKey = "replacement-key";
	mocks.readCoordinatorOwnerReviewLocalEvidence
		.mockReturnValueOnce(local)
		.mockReturnValueOnce(after);
	// Act
	await run();
	// Assert
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
	expect(process.exitCode).toBe(1);
});

it("changed device override during approval is reread and prevents commit", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_DEVICE_ID", " device-a ");
	mocks.readCoordinatorOwnerReviewLocalEvidence.mockImplementation((options) =>
		options.deviceIdOverride === "device-a"
			? local
			: { ...local, state: "needs_review", reasons: ["device_override_mismatch"] },
	);
	mocks.confirm.mockImplementation(async () => {
		vi.stubEnv("CODEMEM_DEVICE_ID", " device-b ");
		return true;
	});
	// Act
	await run();
	// Assert
	expect(
		mocks.readCoordinatorOwnerReviewLocalEvidence.mock.calls.map(
			([options]) => options.deviceIdOverride,
		),
	).toEqual(["device-a", "device-b"]);
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
	expect(process.exitCode).toBe(1);
});

it.each(["needs_review", "ready"])(
	"different canonical enrollment fingerprint in %s cannot commit",
	async (state) => {
		// Arrange
		mocks.coordinatorAuthControllerReviewAction.mockResolvedValue({
			...preview,
			state,
			reasons: state === "needs_review" ? ["key_mismatch"] : [],
			enrollment: { ...preview.enrollment, fingerprint: "c".repeat(64) },
		});
		// Act
		await run();
		// Assert
		expect(mocks.log.error).toHaveBeenCalledWith(
			expect.stringContaining(
				state === "needs_review"
					? "Coordinator review stopped: key_mismatch"
					: "Device owner review could not finish",
			),
			{ output: process.stderr },
		);
		expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	},
);

it.each(["no-secret", "local-conflict", "unsafe-url"])(
	"%s stops before any remote request",
	async (mode) => {
		// Arrange
		if (mode === "no-secret")
			mocks.readCodememConfigFile.mockReturnValue({ ...config, sync_coordinator_admin_secret: "" });
		if (mode === "local-conflict")
			mocks.readCoordinatorOwnerReviewLocalEvidence.mockReturnValue({
				...local,
				state: "needs_review",
				reasons: ["local_actor_ambiguous"],
			});
		// Act
		await run(mode === "unsafe-url" ? ["-u", "http://remote.example.test"] : []);
		// Assert
		expect(mocks.coordinatorAuthControllerReviewAction).not.toHaveBeenCalled();
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(process.exitCode).toBeGreaterThan(0);
	},
);

it.each([
	["review_stale", "Evidence changed since the preview"],
	["already_reviewed_or_needs_review", "This device already has a reviewed owner"],
	["needs_review", "Coordinator ownership evidence needs review"],
	["unknown", "Device owner review could not finish"],
])("remote %s uses fixed safe guidance", async (code, message) => {
	// Arrange
	const error = new RemoteCoordinatorRequestError(409, code);
	error.message = "private-admin-secret-and-cookie";
	mocks.coordinatorAuthControllerReviewAction.mockRejectedValueOnce(error);
	// Act
	await run();
	// Assert
	expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining(message), {
		output: process.stderr,
	});
	expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(error.message);
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});

it.each(["needs-review", "malformed", "nonterminal"])("%s preview cannot commit", async (mode) => {
	// Arrange
	if (mode === "needs-review")
		mocks.coordinatorAuthControllerReviewAction.mockResolvedValue({
			...preview,
			state: "needs_review",
			reasons: ["key_mismatch"],
			evidence_digest: undefined,
		});
	if (mode === "malformed")
		mocks.coordinatorAuthControllerReviewAction.mockResolvedValue({
			...preview,
			evidence_digest: "wrong",
		});
	if (mode === "nonterminal")
		Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
	// Act
	await run();
	// Assert
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(process.exitCode).toBeGreaterThan(0);
});
