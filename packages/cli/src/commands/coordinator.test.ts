import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	coordinatorImportInviteAction: vi.fn(),
	coordinatorRemoveDeviceAction: vi.fn(),
}));

vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	return {
		...actual,
		coordinatorImportInviteAction: mocks.coordinatorImportInviteAction,
		coordinatorRemoveDeviceAction: mocks.coordinatorRemoveDeviceAction,
	};
});

import { buildCoordinatorCommand } from "./coordinator.js";

describe("coordinator aliases used by deployed browser pages", () => {
	it.each(["link-account", "upgrade-auth-schema", "upgrade-account-schema"])(
		"parses hidden %s help without executing its action",
		async (name) => {
			// Arrange: help exercises routing without accessing auth or storage.
			const coordinator = buildCoordinatorCommand();
			const alias = coordinator.commands.find((command) => command.name() === name);
			const action = vi.fn();
			let output = "";
			expect(alias).toBeDefined();
			alias
				?.exitOverride()
				.configureOutput({
					writeOut: (text) => {
						output += text;
					},
				})
				.action(action);
			// Act
			const result = coordinator.parseAsync([name, "--help"], { from: "user" });
			// Assert
			await expect(result).rejects.toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
			expect(output).toContain(` ${name}`);
			expect(action).not.toHaveBeenCalled();
			expect(alias).not.toBe(
				buildCoordinatorCommand().commands.find((command) => command.name() === name),
			);
			expect(
				coordinator
					.createHelp()
					.visibleCommands(coordinator)
					.map((command) => command.name()),
			).not.toContain(name);
			expect(coordinator.helpInformation()).not.toMatch(new RegExp(`^\\s+${name}(?:\\s|$)`, "m"));
		},
	);

	it("does not restore unrelated flat commands", () => {
		// Arrange
		const coordinator = buildCoordinatorCommand();
		// Act
		const names = coordinator.commands.map((command) => command.name());
		// Assert
		for (const name of [
			"enroll-owner",
			"review-device-owner",
			"qualify-owner",
			"group-create",
			"list-groups",
			"enroll-device",
			"revoke-device",
			"create-scope",
			"import-invite",
			"approve-join-request",
		]) {
			expect(names).not.toContain(name);
		}
	});
});

describe("coordinator device remove", () => {
	const previousExitCode = process.exitCode;
	const remove = (...flags: string[]) =>
		buildCoordinatorCommand().parseAsync(["device", "remove", "team-a", "device-1", ...flags], {
			from: "user",
		});

	beforeEach(() => {
		process.exitCode = undefined;
		mocks.coordinatorRemoveDeviceAction.mockReset();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		process.exitCode = previousExitCode;
		vi.restoreAllMocks();
	});

	it("reports a removal that the coordinator cannot record as a JSON error and exits 1", async () => {
		// Arrange: the local coordinator database has an enrollment without a key ID.
		mocks.coordinatorRemoveDeviceAction.mockRejectedValueOnce(
			new Error("device_removal_unavailable"),
		);
		// Act: the handler does not throw.
		await remove("--json");
		// Assert
		expect(vi.mocked(console.log).mock.calls).toEqual([
			[JSON.stringify({ error: "remove_failed", message: "device_removal_unavailable" })],
		]);
		expect(process.exitCode).toBe(1);
	});

	it("keeps its replies for a removed device and for a device that is not enrolled", async () => {
		// Arrange
		mocks.coordinatorRemoveDeviceAction.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		// Act
		await remove("--json");
		const removedExitCode = process.exitCode;
		await remove("--json");
		// Assert
		expect(vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
			{ ok: true, group_id: "team-a", device_id: "device-1" },
			{ error: "device_not_found", message: "Device not found: device-1" },
		]);
		expect([removedExitCode, process.exitCode]).toEqual([undefined, 1]);
	});
});

describe("coordinator import-invite", () => {
	const previousExitCode = process.exitCode;

	beforeEach(() => {
		process.exitCode = undefined;
		mocks.coordinatorImportInviteAction.mockReset();
		mocks.coordinatorImportInviteAction.mockResolvedValue({
			group_id: "team-a",
			coordinator_url: "https://coordinator.example.test",
			status: "pending",
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		process.exitCode = previousExitCode;
		vi.restoreAllMocks();
	});

	it.each([
		{
			label: "long options",
			args: ["--recipient-name", "  Alice Example  ", "--device-name", "  Work Laptop  "],
			recipientDisplayName: "Alice Example",
			deviceDisplayName: "Work Laptop",
		},
		{
			label: "short options",
			args: ["-R", "  Bob Example  ", "-N", "  Travel Phone  "],
			recipientDisplayName: "Bob Example",
			deviceDisplayName: "Travel Phone",
		},
	])("trims and forwards $label", async ({ args, recipientDisplayName, deviceDisplayName }) => {
		await buildCoordinatorCommand().parseAsync(
			["invitation", "accept", "invite-value", ...args, "--json"],
			{
				from: "user",
			},
		);

		expect(mocks.coordinatorImportInviteAction).toHaveBeenCalledWith(
			expect.objectContaining({ recipientDisplayName, deviceDisplayName }),
		);
	});

	it("forwards absent or blank names as null", async () => {
		await buildCoordinatorCommand().parseAsync(
			["invitation", "accept", "invite-value", "--recipient-name", "   ", "--json"],
			{ from: "user" },
		);

		expect(mocks.coordinatorImportInviteAction).toHaveBeenCalledWith(
			expect.objectContaining({ recipientDisplayName: null, deviceDisplayName: null }),
		);
	});

	it.each([
		["invite_already_bound", "already used"],
		["invite_expired", "expired"],
		["invite_invalid", "invalid"],
		["recipient_display_name_invalid", "--recipient-name"],
		["recipient_display_name_required", "--recipient-name"],
		["recipient_display_name_too_long", "--recipient-name"],
		["device_display_name_invalid", "--device-name"],
		["device_display_name_required", "--device-name"],
		["device_display_name_too_long", "--device-name"],
	])("maps %s to actionable JSON guidance", async (code, expectedFlag) => {
		mocks.coordinatorImportInviteAction.mockRejectedValueOnce(new Error(code));

		await buildCoordinatorCommand().parseAsync(["invitation", "accept", "invite-value", "--json"], {
			from: "user",
		});

		const output = vi.mocked(console.log).mock.calls.at(-1)?.[0];
		expect(console.log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(output))).toMatchObject({
			error: "import_invite_failed",
			message: expect.stringContaining(expectedFlag),
		});
		expect(process.exitCode).toBe(1);
	});

	it.each([
		"add_device_invite_self_acceptance_forbidden",
		"invite_identity_conflict",
		"recipient_invite_intent_mismatch",
		"recipient_invite_review_unavailable",
	])("directs %s recipient invitation failures to the Viewer", async (code) => {
		mocks.coordinatorImportInviteAction.mockRejectedValueOnce(new Error(code));

		await buildCoordinatorCommand().parseAsync(["invitation", "accept", "invite-value", "--json"], {
			from: "user",
		});

		const output = vi.mocked(console.log).mock.calls.at(-1)?.[0];
		expect(JSON.parse(String(output)).message).toContain("codemem service start");
		expect(process.exitCode).toBe(1);
	});

	it("explains how to review and explicitly confirm recipient invitations", async () => {
		// Arrange
		mocks.coordinatorImportInviteAction.mockRejectedValueOnce(
			new Error("reviewed_onboarding_digest_required"),
		);

		// Act
		await buildCoordinatorCommand().parseAsync(["invitation", "accept", "invite-value", "--json"], {
			from: "user",
		});

		// Assert
		const output = vi.mocked(console.log).mock.calls.at(-1)?.[0];
		expect(console.log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(output))).toMatchObject({
			error: "import_invite_failed",
			message: expect.stringContaining("--review"),
		});
		expect(JSON.parse(String(output)).message).toContain("--reviewed-onboarding-digest");
		expect(process.exitCode).toBe(1);
	});
});
