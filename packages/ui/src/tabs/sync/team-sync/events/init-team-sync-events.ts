/* Wires up the buttons on the team-sync card: Share projects. Accepting
 * invitations and pairing codes happens in Sharing and Devices, and creating Teams and
 * invitations happens in Sharing (see sync-disclosure.tsx). Also runs an initial paint
 * of the Radix disclosure + invite policy select so the controls are populated on first
 * render. Kept separate from the render pipeline so the render path can stay pure with
 * respect to DOM listeners. */

import { mountOperationStatusHost } from "../../../../components/operation-status";
import { showGlobalNotice } from "../../../../lib/notice";
import { openProjectShareFlow } from "../../../project-sharing";
import { renderAdminSetupDisclosure, renderInvitePolicySelect } from "../helpers/invite-panel-dom";

export function initTeamSyncEvents() {
	renderAdminSetupDisclosure();
	renderInvitePolicySelect();
	const operationStatusRoot = document.getElementById("operationStatusRoot");
	if (operationStatusRoot) mountOperationStatusHost(operationStatusRoot);

	const syncShareProjectsButton = document.getElementById(
		"syncShareProjectsButton",
	) as HTMLButtonElement | null;
	syncShareProjectsButton?.addEventListener("click", () => {
		if (!openProjectShareFlow()) {
			showGlobalNotice(
				"Project sharing is unavailable. Refresh Projects and try again.",
				"warning",
			);
		}
	});
}
