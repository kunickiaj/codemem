import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/api", () => ({
	createCoordinatorInvite: vi.fn(),
	importCoordinatorInvite: vi.fn(),
	inspectCoordinatorInvite: vi.fn(),
	runSyncNow: vi.fn(),
}));
vi.mock("../../../../lib/form", () => ({
	clearFieldError: vi.fn(),
	friendlyError: vi.fn((_error: unknown, fallback: string) => fallback),
	markFieldError: vi.fn(() => false),
}));
vi.mock("../../../../lib/keyboard", () => ({ handlePrimaryActionKeyboard: vi.fn() }));
vi.mock("../../../../lib/notice", () => ({ showGlobalNotice: vi.fn() }));
vi.mock("../../../../lib/state", () => ({ state: {} }));
vi.mock("../../view-model", () => ({ summarizeSyncRunResult: vi.fn() }));
vi.mock("../data/state", () => ({ teamSyncState: { invitePolicy: "auto_admit" } }));
vi.mock("../helpers/invite-panel-dom", () => ({
	renderAdminSetupDisclosure: vi.fn(),
	renderInvitePolicySelect: vi.fn(),
	setInviteOutputVisibility: vi.fn(),
	setJoinFeedbackVisibility: vi.fn(),
}));
vi.mock("../../../project-sharing", () => ({ openProjectShareFlow: vi.fn() }));

import * as api from "../../../../lib/api";
import { showGlobalNotice } from "../../../../lib/notice";
import { openProjectShareFlow } from "../../../project-sharing";
import { initTeamSyncEvents } from "./init-team-sync-events";

describe("project invite review events", () => {
	beforeEach(() => {
		document.body.innerHTML = `
			<textarea id="syncJoinInvite"></textarea>
			<div id="syncProjectInviteReview" role="region" aria-labelledby="syncProjectInviteReviewHeading" hidden>
				<h4 id="syncProjectInviteReviewHeading" tabindex="-1">Review project invitation</h4>
				<div id="syncProjectInviteContext"></div>
				<input id="syncRecipientName" />
			<input id="syncRecipientDeviceName" />
			</div>
			<button id="syncShareProjectsButton">Share projects</button>
			<button id="syncJoinButton">Review invite</button>
		`;
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue({
			device_name: "Brian's Mac",
			inviter_name: "Adam",
			kind: "project_share_invite",
			operation_id: `share_${"a".repeat(40)}`,
			projects: [{ display_name: "codemem", existing_memory_count: 3 }],
			recipient_name: "Brian",
			team_name: "Team",
		});
		vi.mocked(api.importCoordinatorInvite).mockResolvedValue({ status: "joined" });
	});

	it("opens the shared project flow from Sync", () => {
		vi.mocked(openProjectShareFlow).mockReturnValueOnce(true);
		initTeamSyncEvents(
			() => {},
			async () => {},
		);

		(document.getElementById("syncShareProjectsButton") as HTMLButtonElement).click();

		expect(openProjectShareFlow).toHaveBeenCalledOnce();
		expect(openProjectShareFlow).toHaveBeenCalledWith();
	});

	it("explains when the shared project flow is unavailable", () => {
		vi.mocked(openProjectShareFlow).mockReturnValueOnce(false);
		initTeamSyncEvents(
			() => {},
			async () => {},
		);

		(document.getElementById("syncShareProjectsButton") as HTMLButtonElement).click();

		expect(showGlobalNotice).toHaveBeenCalledWith(
			"Project sharing is unavailable. Refresh Projects and try again.",
			"warning",
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
		document.body.innerHTML = "";
	});

	it("moves focus into the labelled review region before acceptance", async () => {
		initTeamSyncEvents(
			() => {},
			async () => {},
		);
		const invite = document.getElementById("syncJoinInvite") as HTMLTextAreaElement;
		const button = document.getElementById("syncJoinButton") as HTMLButtonElement;
		invite.value = "project-invite";

		button.click();
		await vi.waitFor(() => expect(button.textContent).toBe("Accept and start syncing"));

		const review = document.getElementById("syncProjectInviteReview") as HTMLDivElement;
		const heading = document.getElementById("syncProjectInviteReviewHeading") as HTMLHeadingElement;
		expect(review.hidden).toBe(false);
		expect(review.getAttribute("aria-labelledby")).toBe(heading.id);
		expect(document.activeElement).toBe(heading);
		expect(document.getElementById("syncProjectInviteContext")?.textContent).toContain(
			"Adam invited you through Team to share codemem",
		);

		invite.value = "different-invite";
		invite.dispatchEvent(new Event("input", { bubbles: true }));
		expect(review.hidden).toBe(true);
		expect(button.textContent).toBe("Review invite");
	});

	it("ignores stale inspection results after the invite input changes", async () => {
		let resolveInspection: (
			value: Awaited<ReturnType<typeof api.inspectCoordinatorInvite>>,
		) => void = () => {};
		vi.mocked(api.inspectCoordinatorInvite).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveInspection = resolve;
			}),
		);
		initTeamSyncEvents(
			() => {},
			async () => {},
		);
		const invite = document.getElementById("syncJoinInvite") as HTMLTextAreaElement;
		const button = document.getElementById("syncJoinButton") as HTMLButtonElement;
		const review = document.getElementById("syncProjectInviteReview") as HTMLDivElement;
		invite.value = "old-invite";
		button.click();
		invite.value = "new-invite";
		invite.dispatchEvent(new Event("input", { bubbles: true }));
		invite.focus();
		resolveInspection({
			device_name: "Brian's Mac",
			inviter_name: "Adam",
			kind: "project_share_invite",
			projects: [{ display_name: "codemem", existing_memory_count: 3 }],
			recipient_name: "Brian",
		});
		await vi.waitFor(() => expect(api.inspectCoordinatorInvite).toHaveBeenCalledOnce());
		await Promise.resolve();

		expect(review.hidden).toBe(true);
		expect(button.textContent).toBe("Review invite");
		expect(document.activeElement).toBe(invite);
		expect(api.importCoordinatorInvite).not.toHaveBeenCalled();
	});

	it("requires a second truthful action before importing a legacy invite", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValueOnce({ kind: "legacy_team_invite" });
		initTeamSyncEvents(
			() => {},
			async () => {},
		);
		const invite = document.getElementById("syncJoinInvite") as HTMLTextAreaElement;
		const button = document.getElementById("syncJoinButton") as HTMLButtonElement;
		invite.value = "legacy-invite";

		button.click();
		await vi.waitFor(() => expect(button.textContent).toBe("Accept invite"));
		expect(api.importCoordinatorInvite).not.toHaveBeenCalled();

		button.click();
		await vi.waitFor(() => expect(api.importCoordinatorInvite).toHaveBeenCalledOnce());
		expect(api.importCoordinatorInvite).toHaveBeenCalledWith("legacy-invite", undefined);
		expect(invite.value).toBe("");
		await vi.waitFor(() => expect(button.textContent).toBe("Review invite"));
	});

	it("forwards confirmed project identity only after review", async () => {
		initTeamSyncEvents(
			() => {},
			async () => {},
		);
		const invite = document.getElementById("syncJoinInvite") as HTMLTextAreaElement;
		const button = document.getElementById("syncJoinButton") as HTMLButtonElement;
		invite.value = "project-invite";
		button.click();
		await vi.waitFor(() => expect(button.textContent).toBe("Accept and start syncing"));
		(document.getElementById("syncRecipientName") as HTMLInputElement).value = "Brian Updated";

		button.click();
		await vi.waitFor(() => expect(api.importCoordinatorInvite).toHaveBeenCalledOnce());
		expect(api.importCoordinatorInvite).toHaveBeenCalledWith("project-invite", {
			device_name: "Brian's Mac",
			recipient_name: "Brian Updated",
		});
		await vi.waitFor(() => expect(button.textContent).toBe("Review invite"));
	});
});
