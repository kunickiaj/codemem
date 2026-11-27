import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/api", () => ({ runSyncNow: vi.fn() }));
vi.mock("../../../../lib/notice", () => ({ showGlobalNotice: vi.fn() }));
vi.mock("../../../../lib/state", () => ({ state: {} }));
vi.mock("../../view-model", () => ({ summarizeSyncRunResult: vi.fn() }));
vi.mock("../helpers/invite-panel-dom", () => ({
	renderAdminSetupDisclosure: vi.fn(),
	renderInvitePolicySelect: vi.fn(),
}));
vi.mock("../../../project-sharing", () => ({ openProjectShareFlow: vi.fn() }));

import { showGlobalNotice } from "../../../../lib/notice";
import { openProjectShareFlow } from "../../../project-sharing";
import { initTeamSyncEvents } from "./init-team-sync-events";

beforeEach(() => {
	document.body.innerHTML = `<button id="syncShareProjectsButton">Share projects</button>`;
});

afterEach(() => {
	vi.clearAllMocks();
	document.body.innerHTML = "";
});

describe("project sharing entry", () => {
	it("opens the shared project flow from Sync", () => {
		vi.mocked(openProjectShareFlow).mockReturnValueOnce(true);
		initTeamSyncEvents();

		(document.getElementById("syncShareProjectsButton") as HTMLButtonElement).click();

		expect(openProjectShareFlow).toHaveBeenCalledExactlyOnceWith();
	});

	it("explains when the shared project flow is unavailable", () => {
		vi.mocked(openProjectShareFlow).mockReturnValueOnce(false);
		initTeamSyncEvents();

		(document.getElementById("syncShareProjectsButton") as HTMLButtonElement).click();

		expect(showGlobalNotice).toHaveBeenCalledWith(
			"Project sharing is unavailable. Refresh Projects and try again.",
			"warning",
		);
	});
});
