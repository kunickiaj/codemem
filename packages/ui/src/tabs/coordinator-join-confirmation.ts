import * as api from "../lib/api";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

type ImportArguments = Parameters<typeof api.importCoordinatorInvite>;

export function coordinatorJoinConfirmation(detail: string) {
	return {
		title: "Join this coordinator?",
		description: `${detail} This can't be undone.`,
		confirmLabel: "Join coordinator",
		cancelLabel: "Cancel",
		autoFocusAction: "cancel",
		tone: "danger",
	} as const;
}

/** Accepts an invitation, asking first when joining turns off syncing without a coordinator. */
export async function acceptCoordinatorInvite(
	invite: ImportArguments[0],
	identity: ImportArguments[1],
	inviteKind: ImportArguments[2],
	confirm: typeof openSyncConfirmDialog = openSyncConfirmDialog,
): Promise<Awaited<ReturnType<typeof api.importCoordinatorInvite>>> {
	try {
		return await api.importCoordinatorInvite(invite, identity, inviteKind);
	} catch (error) {
		if (!(error instanceof api.CoordinatorJoinConfirmationRequiredError)) throw error;
		if ((await confirm(coordinatorJoinConfirmation(error.message))) !== true)
			throw new Error("Invitation not accepted.");
		return api.importCoordinatorInvite(invite, identity, inviteKind, {
			confirmCoordinatorJoin: true,
		});
	}
}
