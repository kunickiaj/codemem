/* Shared module state for the Coordinator Admin tab — everything that
 * was previously a file-local `let` or `const Map` lives on a single
 * exported object so the panels/actions/lifecycle slices can all read
 * and write it without hitting ES-module `export let` limitations. */

export type AdminSection = "groups" | "invites" | "join-requests" | "devices";

export type GroupActionKind = "create" | "rename" | "archive" | "unarchive" | "";
export type JoinReviewAction = "approve" | "deny" | "";
export type DeviceActionKind = "rename" | "disable" | "enable" | "remove" | "";
export type InvitePolicy = "auto_admit" | "approval_required";

export interface GroupPreferencesDraft {
	projects_include: string;
	projects_exclude: string;
	auto_seed_scope: boolean;
	loaded: boolean;
	saving: boolean;
	error: string;
}

export interface CoordinatorAdminState {
	activeSection: AdminSection;
	inviteGroup: string;
	inviteTtlHours: string;
	invitePolicy: InvitePolicy;
	invitePending: boolean;
	showArchivedGroups: boolean;
	createGroupId: string;
	createGroupDisplayName: string;
	groupActionPendingId: string;
	groupActionPendingKind: GroupActionKind;
	joinReviewPendingId: string;
	joinReviewPendingAction: JoinReviewAction;
	deviceActionPendingId: string;
	deviceActionPendingKind: DeviceActionKind;
	groupRenameDrafts: Map<string, string>;
	deviceRenameDrafts: Map<string, string>;
	groupPreferencesOpen: Set<string>;
	groupPreferencesDrafts: Map<string, GroupPreferencesDraft>;
}

export const ADMIN_TARGET_GROUP_KEY = "codemem-coordinator-admin-target-group";

export const coordinatorAdminState: CoordinatorAdminState = {
	activeSection: "groups",
	inviteGroup: "",
	inviteTtlHours: "24",
	invitePolicy: "auto_admit",
	invitePending: false,
	showArchivedGroups: false,
	createGroupId: "",
	createGroupDisplayName: "",
	groupActionPendingId: "",
	groupActionPendingKind: "",
	joinReviewPendingId: "",
	joinReviewPendingAction: "",
	deviceActionPendingId: "",
	deviceActionPendingKind: "",
	groupRenameDrafts: new Map<string, string>(),
	deviceRenameDrafts: new Map<string, string>(),
	groupPreferencesOpen: new Set<string>(),
	groupPreferencesDrafts: new Map<string, GroupPreferencesDraft>(),
};
