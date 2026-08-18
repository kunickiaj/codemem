import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	coordinatorImportInviteAction: vi.fn(),
}));

vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	return {
		...actual,
		coordinatorImportInviteAction: mocks.coordinatorImportInviteAction,
	};
});

import { buildCoordinatorCommand } from "./coordinator.js";

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
			["import-invite", "invite-value", ...args, "--json"],
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
			["import-invite", "invite-value", "--recipient-name", "   ", "--json"],
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

		await buildCoordinatorCommand().parseAsync(["import-invite", "invite-value", "--json"], {
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

		await buildCoordinatorCommand().parseAsync(["import-invite", "invite-value", "--json"], {
			from: "user",
		});

		const output = vi.mocked(console.log).mock.calls.at(-1)?.[0];
		expect(JSON.parse(String(output)).message).toContain("codemem serve");
		expect(process.exitCode).toBe(1);
	});

	it("directs reviewed recipient invitations to the Viewer", async () => {
		mocks.coordinatorImportInviteAction.mockRejectedValueOnce(
			new Error("reviewed_onboarding_digest_required"),
		);

		await buildCoordinatorCommand().parseAsync(["import-invite", "invite-value", "--json"], {
			from: "user",
		});

		const output = vi.mocked(console.log).mock.calls.at(-1)?.[0];
		expect(console.log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(output))).toEqual({
			error: "import_invite_failed",
			message:
				"Accept Team/add-device recipient invitations through the Viewer: run `codemem serve`, review the access details, and confirm the invitation there.",
		});
		expect(process.exitCode).toBe(1);
	});
});
