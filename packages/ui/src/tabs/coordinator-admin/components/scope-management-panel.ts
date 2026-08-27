import { Fragment, h } from "preact";
import { RadixSwitch } from "../../../components/primitives/radix-switch";
import { TextInput } from "../../../components/primitives/text-input";
import * as api from "../../../lib/api";
import { showGlobalNotice } from "../../../lib/notice";
import type { CachedCoordinatorAdminDevice } from "../../../lib/state";
import { state } from "../../../lib/state";
import { openSyncConfirmDialog } from "../../sync/sync-dialogs";
import {
	type CoordinatorAdminScopeMemberView,
	type CoordinatorAdminScopeView,
	coordinatorAdminDevicesForGroup,
	deriveScopeMembershipDeviceRows,
	scopeManagementReadinessMessage,
	spaceAccessDeviceCopy,
	spaceCardCopy,
	spaceRevokeMemberTitle,
} from "../data/scope-management";
import { coordinatorAdminState, type GroupScopeManagementDraft } from "../data/state";
import type { CoordinatorAdminSummary } from "../data/summary";

interface ScopeManagementPanelDeps {
	groupId: string;
	ready: boolean;
	summary: CoordinatorAdminSummary;
	renderShell: () => void;
}

function emptyScopeDraft(): GroupScopeManagementDraft {
	return {
		loaded: false,
		loading: false,
		error: "",
		includeInactive: false,
		devicesLoaded: false,
		scopes: [],
		membersByScope: new Map<string, CoordinatorAdminScopeMemberView[]>(),
		devices: [],
		createScopeId: "",
		createLabel: "",
		createKind: "team",
		actionPendingKey: "",
		actionPendingKind: "",
	};
}

function payloadItems<T>(payload: unknown): T[] {
	if (!payload || typeof payload !== "object") return [];
	const items = (payload as { items?: unknown }).items;
	return Array.isArray(items) ? (items as T[]) : [];
}

function draftFor(groupId: string): GroupScopeManagementDraft {
	let draft = coordinatorAdminState.groupScopeManagementDrafts.get(groupId);
	if (!draft) {
		draft = emptyScopeDraft();
		coordinatorAdminState.groupScopeManagementDrafts.set(groupId, draft);
	}
	return draft;
}

function setDraft(groupId: string, draft: GroupScopeManagementDraft): void {
	coordinatorAdminState.groupScopeManagementDrafts.set(groupId, draft);
}

export function safeSpaceOperationError(cause: unknown, fallback: string): string {
	const message = cause instanceof Error ? cause.message : "";
	if (message.includes("group_archived") || message.includes("Group is archived")) {
		return "Restore this legacy coordinator group before changing Space access.";
	}
	if (message.includes("group_not_found") || message.includes("Group not found")) {
		return "This legacy coordinator group no longer exists. Refresh Advanced administration.";
	}
	if (message.includes("scope_not_found") || message.includes("Scope not found")) {
		return "This Space no longer exists. Refresh legacy Spaces before retrying.";
	}
	if (message.includes("scope_not_active") || message.includes("Scope is not active")) {
		return "Restore this legacy Space before changing its access.";
	}
	if (message.includes("scopeId already exists")) {
		return "A Space already uses that ID. Choose a different Space ID or refresh legacy Spaces. Sharing policy is unchanged.";
	}
	if (
		message.includes("device_not_enrolled_for_scope_group") ||
		message.includes("device must be enrolled")
	) {
		return "This device is no longer enrolled in the legacy coordinator group. Refresh devices before retrying.";
	}
	if (message.includes("membership_not_found")) {
		return "This device no longer has access to the Space. Refresh legacy Spaces.";
	}
	return fallback;
}

async function loadGroupScopeManagement(
	groupId: string,
	renderShell: () => void,
	includeInactive = draftFor(groupId).includeInactive,
): Promise<void> {
	const current = draftFor(groupId);
	setDraft(groupId, { ...current, loading: true, error: "", includeInactive });
	renderShell();
	try {
		const [scopesPayload, devicesPayload] = await Promise.all([
			api.loadCoordinatorAdminScopes(groupId, includeInactive),
			api.loadCoordinatorAdminDevices(groupId, true),
		]);
		const scopes = payloadItems<CoordinatorAdminScopeView>(scopesPayload);
		const devices = payloadItems<CachedCoordinatorAdminDevice>(devicesPayload);
		const memberEntries = await Promise.all(
			scopes.map(async (scope) => {
				const scopeId = String(scope.scope_id || "").trim();
				if (!scopeId) return [scopeId, [] as CoordinatorAdminScopeMemberView[]] as const;
				const payload = await api.loadCoordinatorAdminScopeMembers(groupId, scopeId, true);
				return [scopeId, payloadItems<CoordinatorAdminScopeMemberView>(payload)] as const;
			}),
		);
		setDraft(groupId, {
			...draftFor(groupId),
			loaded: true,
			loading: false,
			error: "",
			includeInactive,
			devicesLoaded: true,
			scopes,
			devices,
			membersByScope: new Map(memberEntries.filter(([scopeId]) => scopeId.length > 0)),
			actionPendingKey: "",
			actionPendingKind: "",
		});
	} catch {
		setDraft(groupId, {
			...draftFor(groupId),
			loaded: true,
			loading: false,
			error: "Legacy Spaces are unavailable. Check coordinator recovery status and retry.",
		});
	}
	renderShell();
}

export function openGroupScopeManagement(groupId: string, renderShell: () => void): void {
	coordinatorAdminState.groupScopeManagementOpen.add(groupId);
	draftFor(groupId);
	renderShell();
	void loadGroupScopeManagement(groupId, renderShell);
}

export function closeGroupScopeManagement(groupId: string, renderShell: () => void): void {
	coordinatorAdminState.groupScopeManagementOpen.delete(groupId);
	coordinatorAdminState.groupScopeManagementDrafts.delete(groupId);
	renderShell();
}

async function createScope(groupId: string, renderShell: () => void): Promise<void> {
	const draft = draftFor(groupId);
	if (draft.actionPendingKey) return;
	const scopeId = draft.createScopeId.trim();
	const label = draft.createLabel.trim();
	const kind = draft.createKind.trim() || "team";
	if (!scopeId || !label) {
		showGlobalNotice("Enter a Space id and label before creating a Space.", "warning");
		return;
	}
	setDraft(groupId, {
		...draft,
		actionPendingKey: `create:${scopeId}`,
		actionPendingKind: "create",
		error: "",
	});
	renderShell();
	try {
		await api.createCoordinatorAdminScope(groupId, {
			scope_id: scopeId,
			label,
			kind,
		});
		const latest = draftFor(groupId);
		setDraft(groupId, {
			...latest,
			createScopeId: "",
			createLabel: "",
			createKind: "team",
			actionPendingKey: "",
			actionPendingKind: "",
		});
		showGlobalNotice("Space created. Grant devices explicitly before data can sync.");
		await loadGroupScopeManagement(groupId, renderShell, latest.includeInactive);
	} catch (cause) {
		setDraft(groupId, {
			...draftFor(groupId),
			actionPendingKey: "",
			actionPendingKind: "",
			error: safeSpaceOperationError(
				cause,
				"Could not create the legacy Space. Sharing policy is unchanged; retry after coordinator recovery.",
			),
		});
		renderShell();
	}
}

async function grantMember(
	groupId: string,
	scopeId: string,
	deviceId: string,
	renderShell: () => void,
): Promise<void> {
	const draft = draftFor(groupId);
	const key = `grant:${scopeId}:${deviceId}`;
	if (draft.actionPendingKey) return;
	setDraft(groupId, { ...draft, actionPendingKey: key, actionPendingKind: "grant", error: "" });
	renderShell();
	try {
		await api.grantCoordinatorAdminScopeMember(groupId, scopeId, {
			device_id: deviceId,
			role: "member",
		});
		showGlobalNotice("Device granted access to the Space.");
		await loadGroupScopeManagement(groupId, renderShell, draft.includeInactive);
	} catch (cause) {
		setDraft(groupId, {
			...draftFor(groupId),
			actionPendingKey: "",
			actionPendingKind: "",
			error: safeSpaceOperationError(
				cause,
				"Could not grant legacy Space transport access. Sharing policy is unchanged; retry after coordinator recovery.",
			),
		});
		renderShell();
	}
}

async function revokeMember(
	groupId: string,
	scope: CoordinatorAdminScopeView,
	deviceId: string,
	displayName: string,
	renderShell: () => void,
): Promise<void> {
	const scopeId = String(scope.scope_id || "").trim();
	if (!scopeId) return;
	const confirmed = await openSyncConfirmDialog({
		title: spaceRevokeMemberTitle(scope, displayName, deviceId),
		description:
			"Revocation blocks future sync for this Space. It does not remove data already copied to the revoked device; offline devices, backups, copied databases, malicious peers, or old versions may retain data.",
		confirmLabel: "Revoke membership",
		cancelLabel: "Keep membership",
		tone: "danger",
	});
	if (!confirmed) return;
	const draft = draftFor(groupId);
	const key = `revoke:${scopeId}:${deviceId}`;
	if (draft.actionPendingKey) return;
	setDraft(groupId, { ...draft, actionPendingKey: key, actionPendingKind: "revoke", error: "" });
	renderShell();
	try {
		await api.revokeCoordinatorAdminScopeMember(groupId, scopeId, deviceId);
		showGlobalNotice("Space access revoked. Future sync is blocked for that device.");
		await loadGroupScopeManagement(groupId, renderShell, draft.includeInactive);
	} catch (cause) {
		setDraft(groupId, {
			...draftFor(groupId),
			actionPendingKey: "",
			actionPendingKind: "",
			error: safeSpaceOperationError(
				cause,
				"Could not revoke legacy Space transport access. Sharing policy is unchanged; retry after coordinator recovery.",
			),
		});
		renderShell();
	}
}

function renderMembershipRows(
	groupId: string,
	scope: CoordinatorAdminScopeView,
	draft: GroupScopeManagementDraft,
	ready: boolean,
	renderShell: () => void,
) {
	const scopeId = String(scope.scope_id || "").trim();
	const devices = coordinatorAdminDevicesForGroup(
		draft.devices,
		state.lastCoordinatorAdminDevices,
		groupId,
		draft.devicesLoaded,
	);
	const rows = deriveScopeMembershipDeviceRows(devices, draft.membersByScope.get(scopeId) ?? []);
	if (!rows.length) {
		return h(
			"div",
			{ class: "peer-submeta coordinator-admin-empty-state" },
			"No devices are enrolled in this coordinator group yet. Enroll a device before granting this Space.",
		);
	}
	return h(
		"div",
		{ class: "coordinator-admin-scope-member-list" },
		rows.map((row) => {
			const pendingKey = `${draft.actionPendingKind}:${scopeId}:${row.deviceId}`;
			const pending = draft.actionPendingKey === pendingKey;
			const canGrant = row.enabled && row.status !== "active";
			const canRevoke = row.status === "active";
			const copy = spaceAccessDeviceCopy(row);
			return h(
				"div",
				{ class: "coordinator-admin-scope-member-row", key: row.deviceId },
				h(
					"div",
					{ class: "coordinator-admin-scope-member-copy" },
					h("strong", null, row.displayName),
					h("span", null, copy.detail),
					h("span", { class: "peer-meta" }, copy.advancedDetail),
					row.enabled ? null : h("span", null, "Device is disabled in this coordinator group."),
				),
				h(
					"div",
					{ class: "peer-actions" },
					canGrant
						? h(
								"button",
								{
									class: "settings-button",
									disabled: !ready || Boolean(draft.actionPendingKey),
									onClick: () => void grantMember(groupId, scopeId, row.deviceId, renderShell),
									type: "button",
								},
								pending && draft.actionPendingKind === "grant" ? "Granting…" : "Grant access",
							)
						: null,
					canRevoke
						? h(
								"button",
								{
									class: "settings-button danger",
									disabled: !ready || Boolean(draft.actionPendingKey),
									onClick: () =>
										void revokeMember(groupId, scope, row.deviceId, row.displayName, renderShell),
									type: "button",
								},
								pending && draft.actionPendingKind === "revoke" ? "Revoking…" : "Revoke access",
							)
						: null,
				),
			);
		}),
	);
}

function renderScopeCard(
	groupId: string,
	scope: CoordinatorAdminScopeView,
	draft: GroupScopeManagementDraft,
	ready: boolean,
	renderShell: () => void,
) {
	const scopeId = String(scope.scope_id || "").trim();
	const copy = spaceCardCopy(scope);
	return h(
		"div",
		{
			class: "peer-card peer-card--padded coordinator-admin-scope-card",
			key: scopeId || copy.title,
		},
		h("div", { class: "peer-title" }, h("strong", null, copy.title)),
		h("div", { class: "peer-submeta" }, copy.summary),
		h("div", { class: "peer-meta" }, copy.advancedDetail),
		h(
			"div",
			{ class: "peer-submeta" },
			"Devices below are enrolled in the coordinator group; only active Space members can sync this transport boundary.",
		),
		renderMembershipRows(groupId, scope, draft, ready, renderShell),
	);
}

export function renderGroupScopeManagementPanel(deps: ScopeManagementPanelDeps) {
	const { groupId, ready, summary, renderShell } = deps;
	const draft = coordinatorAdminState.groupScopeManagementDrafts.get(groupId);
	if (!draft) return null;
	const readinessMessage = scopeManagementReadinessMessage(summary);
	if (readinessMessage) {
		return h("div", { class: "peer-meta coordinator-admin-inline-warning" }, readinessMessage);
	}
	if (!draft.loaded) {
		return h("div", { class: "peer-submeta" }, "Loading Spaces…");
	}
	const disabled = !ready || Boolean(draft.actionPendingKey) || draft.loading;
	return h(
		Fragment,
		null,
		h("h4", { class: "coordinator-admin-drawer-title" }, "Spaces"),
		h(
			"div",
			{ class: "peer-submeta" },
			"Coordinator groups discover and enroll devices. Spaces are technical transport boundaries here. These controls do not manage policy Team membership or Project access in Sharing.",
		),
		h(
			"label",
			{ class: "coordinator-admin-inline-filter" },
			h(
				"span",
				{ class: "section-meta", id: `coord-admin-domain-inactive-${groupId}` },
				"Show inactive Spaces",
			),
			h(RadixSwitch, {
				"aria-labelledby": `coord-admin-domain-inactive-${groupId}`,
				checked: draft.includeInactive,
				className: "coordinator-admin-switch",
				disabled,
				onCheckedChange: (checked: boolean) => {
					void loadGroupScopeManagement(groupId, renderShell, checked);
				},
				thumbClassName: "coordinator-admin-switch-thumb",
			}),
		),
		h(
			"form",
			{
				class: "coordinator-admin-form",
				onSubmit: (event: Event) => {
					event.preventDefault();
					if (disabled) return;
					void createScope(groupId, renderShell);
				},
			},
			h(
				"div",
				{ class: "coordinator-admin-form-grid" },
				h(
					"label",
					{ class: "coordinator-admin-field" },
					h("span", null, "New Space id"),
					h(TextInput, {
						class: "peer-scope-input",
						disabled,
						onInput: (event) => {
							const current = draftFor(groupId);
							setDraft(groupId, {
								...current,
								createScopeId: String((event.currentTarget as HTMLInputElement).value || ""),
							});
						},
						placeholder: "acme-work",
						type: "text",
						value: draft.createScopeId,
					}),
				),
				h(
					"label",
					{ class: "coordinator-admin-field" },
					h("span", null, "Label"),
					h(TextInput, {
						class: "peer-scope-input",
						disabled,
						onInput: (event) => {
							const current = draftFor(groupId);
							setDraft(groupId, {
								...current,
								createLabel: String((event.currentTarget as HTMLInputElement).value || ""),
							});
						},
						placeholder: "Acme Work",
						type: "text",
						value: draft.createLabel,
					}),
				),
				h(
					"label",
					{ class: "coordinator-admin-field" },
					h("span", null, "Kind"),
					h(TextInput, {
						class: "peer-scope-input",
						disabled,
						onInput: (event) => {
							const current = draftFor(groupId);
							setDraft(groupId, {
								...current,
								createKind: String((event.currentTarget as HTMLInputElement).value || ""),
							});
						},
						placeholder: "team",
						type: "text",
						value: draft.createKind,
					}),
				),
			),
			h(
				"div",
				{ class: "peer-actions" },
				h(
					"button",
					{
						class: "settings-button",
						disabled,
						type: "submit",
					},
					draft.actionPendingKind === "create" ? "Creating…" : "Create Space",
				),
				h(
					"button",
					{
						class: "settings-button",
						disabled,
						onClick: () =>
							void loadGroupScopeManagement(groupId, renderShell, draft.includeInactive),
						type: "button",
					},
					draft.loading ? "Refreshing…" : "Refresh",
				),
			),
		),
		draft.error ? h("div", { class: "peer-submeta coordinator-admin-error" }, draft.error) : null,
		draft.scopes.length
			? h(
					"div",
					{ class: "coordinator-admin-scope-card-list" },
					draft.scopes.map((scope) => renderScopeCard(groupId, scope, draft, ready, renderShell)),
				)
			: h(
					"div",
					{ class: "peer-meta coordinator-admin-empty-state" },
					"No Spaces are defined for this coordinator group yet. Create a Space only for legacy transport or recovery, then grant specific devices. Sharing policy remains separate.",
				),
	);
}
