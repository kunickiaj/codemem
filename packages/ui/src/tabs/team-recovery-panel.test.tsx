import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyTeamSetupSummaryResponseV1 } from "../lib/api";
import { TeamRecoveryApiError, type TeamRecoveryPreviewV1 } from "../lib/api/team-recovery";
import { type TeamRecoveryActions, TeamRecoveryPanel } from "./team-recovery-panel";

const PREVIEW: TeamRecoveryPreviewV1 = {
	teamId: "team-1",
	teamName: "Engineering",
	people: [
		{ identityId: "identity-b", displayName: "Person B", outcome: "member" },
		{
			identityId: "identity-c",
			displayName: "Person C",
			outcome: "left_out",
			reason: "removed_from_team",
		},
	],
	devices: [
		{ deviceId: "device-b", displayName: "Desktop", outcome: "regains_access" },
		{
			deviceId: "device-a",
			displayName: "Laptop",
			outcome: "stays_out",
			reason: "removed_from_group",
		},
	],
	projects: [
		{ projectIdentity: "project-1", displayName: "api", outcome: "restored" },
		{
			projectIdentity: "project-2",
			displayName: null,
			outcome: "skipped",
			reason: "sharing_changed",
		},
	],
	discardedSetupAttempts: 1,
	expectedDigest: "digest-1",
};

function summary(recoverableTeamId?: string): LegacyTeamSetupSummaryResponseV1 {
	const candidate = {
		candidateRef: "candidate-1",
		displayName: "Engineering",
		status: "stale" as const,
		deviceCount: 2,
		projectCount: 1,
		unresolvedDeviceCount: 0,
		unresolvedProjectCount: 0,
		blockingError: "team_setup_completion_conflict" as const,
	};
	return {
		version: 1,
		candidates: [recoverableTeamId ? { ...candidate, recoverableTeamId } : candidate],
	};
}

function actions(overrides: Partial<TeamRecoveryActions> = {}): TeamRecoveryActions {
	return {
		loadSummary: vi.fn().mockResolvedValue(summary("team-1")),
		preview: vi.fn().mockResolvedValue(PREVIEW),
		commit: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

async function mount(recovery: TeamRecoveryActions, onRecovered = vi.fn()) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	await act(async () => {
		render(
			<TeamRecoveryPanel actions={recovery} candidateRef="candidate-1" onRecovered={onRecovered} />,
			element,
		);
	});
	return onRecovered;
}

async function click(id: string) {
	const button = document.getElementById(id);
	if (!button) throw new Error(`button missing: ${id}`);
	await act(async () => {
		button.click();
	});
}

const text = (id: string) => document.getElementById(id)?.textContent ?? "";

beforeEach(() => {
	document.body.innerHTML = '<div id="mount"></div>';
});

afterEach(() => {
	const element = document.getElementById("mount");
	if (element) render(null, element);
});

describe("Team recovery panel", () => {
	it("shows nothing when the summary names no Team to recover", async () => {
		await mount(actions({ loadSummary: vi.fn().mockResolvedValue(summary()) }));

		expect(document.getElementById("team-recovery-panel")).toBeNull();
	});

	it("lists who and what comes back and what stays out before anything is recovered", async () => {
		const recovery = actions();
		await mount(recovery);

		await click("team-recovery-review-button");

		const review = text("team-recovery-review");
		expect(review).toContain("People who become members againPerson B");
		expect(review).toContain("Devices that receive the Team's Projects againDesktop");
		expect(review).toContain("Projects shared with the Team againapi");
		expect(review).toContain("People left outPerson C (removed from the Team)");
		expect(review).toContain("Devices left outLaptop (removed from the coordinator group)");
		expect(review).toContain(
			"Projects not shared againproject-2 (its sharing was changed after the Team was turned off)",
		);
		expect(review).toContain("1 unfinished setup attempt started since the Team was turned off");
		expect(recovery.preview).toHaveBeenCalledWith({ teamId: "team-1" });
		expect(recovery.commit).not.toHaveBeenCalled();
	});

	it("recovers with the reviewed digest and refreshes what opened the dialog", async () => {
		const recovery = actions();
		const onRecovered = await mount(recovery);
		await click("team-recovery-review-button");

		await click("team-recovery-commit");

		expect(recovery.commit).toHaveBeenCalledWith({ teamId: "team-1", expectedDigest: "digest-1" });
		expect(text("team-recovery-status")).toContain("Engineering is recovered");
		expect(onRecovered).toHaveBeenCalledTimes(1);
		expect(document.getElementById("team-recovery-commit")).toBeNull();
	});

	it("goes back to the start without recovering when the review is cancelled", async () => {
		const recovery = actions();
		await mount(recovery);
		await click("team-recovery-review-button");

		await click("team-recovery-cancel");

		expect(document.getElementById("team-recovery-review")).toBeNull();
		expect(document.getElementById("team-recovery-review-button")).not.toBeNull();
		expect(recovery.commit).not.toHaveBeenCalled();
	});

	it("names the device when a device stops the recovery, without the error code", async () => {
		const refused = new TeamRecoveryApiError(409, "device_key_changed", {
			deviceIds: ["device-b"],
		});
		await mount(actions({ preview: vi.fn().mockRejectedValue(refused) }));

		await click("team-recovery-review-button");

		expect(text("team-recovery-error")).toContain("now has a different key");
		expect(text("team-recovery-error")).toContain("Device ID: device-b.");
		expect(document.body.textContent).not.toContain("device_key_changed");
	});

	it.each([
		[
			"was saved and could not be confirmed in time",
			new TeamRecoveryApiError(503, "recovery_unverified", { reason: "evidence_stale" }),
			"shares nothing until a recovery is confirmed",
		],
		[
			"was undone because the coordinator changed",
			new TeamRecoveryApiError(409, "recovery_quarantined_again", { reason: "evidence_changed" }),
			"the Team was turned off again",
		],
		[
			"was refused because the review is out of date",
			new TeamRecoveryApiError(409, "recovery_preview_stale"),
			"Review it again",
		],
	])("asks for a new review when the recovery %s", async (_case, cause, message) => {
		const onRecovered = await mount(actions({ commit: vi.fn().mockRejectedValue(cause) }));
		await click("team-recovery-review-button");

		await click("team-recovery-commit");

		expect(text("team-recovery-error")).toContain(message);
		expect(document.getElementById("team-recovery-review")).toBeNull();
		expect(document.getElementById("team-recovery-review-button")).not.toBeNull();
		expect(onRecovered).not.toHaveBeenCalled();
	});

	it("does not send a second request while one is out", async () => {
		let finish: (preview: TeamRecoveryPreviewV1) => void = () => undefined;
		const preview = vi.fn(
			() => new Promise<TeamRecoveryPreviewV1>((resolve) => (finish = resolve)),
		);
		await mount(actions({ preview }));

		await click("team-recovery-review-button");
		await click("team-recovery-review-button");

		expect(preview).toHaveBeenCalledTimes(1);
		expect(text("team-recovery-review-button")).toBe("Checking the coordinator…");
		await act(async () => finish(PREVIEW));
	});
});
