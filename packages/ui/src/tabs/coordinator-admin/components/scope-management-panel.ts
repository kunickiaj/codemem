import { Fragment, h } from "preact";
import { RadixSwitch } from "../../../components/primitives/radix-switch";
import { TextInput } from "../../../components/primitives/text-input";
import * as api from "../../../lib/api";
import { showGlobalNotice } from "../../../lib/notice";
import type { CachedCoordinatorAdminDevice } from "../../../lib/state";
import { state } from "../../../lib/state";
import { openSyncConfirmDialog } from "../../sync/sync-dialogs";
import { surfacesAreFresh } from "../data/recovery";
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
import { adminSnapshotTargetMatchesCurrent } from "../data/target-group";

interface ScopeManagementPanelDeps {
	groupId: string;
	ready: boolean;
	summary: CoordinatorAdminSummary;
	renderShell: () => void;
}

// Keep opening or refreshing a large coordinator group bounded. Remaining
// membership lists are loaded explicitly from their Space cards.
export const MAX_EAGER_SPACE_MEMBERSHIP_LOADS = 8;

function emptyScopeDraft(): GroupScopeManagementDraft {
	return {
		loaded: false,
		loading: false,
		availability: "unknown",
		error: "",
		includeInactive: false,
		devicesLoaded: false,
		scopes: [],
		membersByScope: new Map<string, CoordinatorAdminScopeMemberView[]>(),
		memberAvailabilityByScope: new Map(),
		devices: [],
		createScopeId: "",
		createLabel: "",
		createKind: "team",
		actionPendingKey: "",
		actionPendingKind: "",
		loadGeneration: 0,
		recoveryAnnouncement: "",
		recoveryFocusPending: false,
		recoveryRetryRequested: false,
	};
}

function payloadItems<T>(payload: unknown): T[] {
	if (!payload || typeof payload !== "object") throw new Error("Invalid list payload");
	const items = (payload as { items?: unknown }).items;
	if (!Array.isArray(items)) throw new Error("Invalid list payload");
	return items as T[];
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

function showRefreshAbortWarning(): void {
	showGlobalNotice(
		"Coordinator data changed or is refreshing. Wait for recovery to finish, then try again.",
		"warning",
	);
}

function scopeMutationStateIsFresh(draft: GroupScopeManagementDraft, scopeId?: string): boolean {
	return (
		draft.availability === "fresh" &&
		!draft.loading &&
		(!scopeId || draft.memberAvailabilityByScope.get(scopeId) === "fresh") &&
		surfacesAreFresh(coordinatorAdminState.recovery, "status", "groups")
	);
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	load: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await load(items[index] as T);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

async function loadGroupScopeManagement(
	groupId: string,
	renderShell: () => void,
	includeInactive = draftFor(groupId).includeInactive,
): Promise<void> {
	const current = draftFor(groupId);
	const generation = current.loadGeneration + 1;
	setDraft(groupId, {
		...current,
		loading: true,
		error: "",
		includeInactive,
		loadGeneration: generation,
		recoveryAnnouncement: current.recoveryRetryRequested ? current.recoveryAnnouncement : "",
	});
	const isCurrent = () =>
		coordinatorAdminState.groupScopeManagementDrafts.get(groupId)?.loadGeneration === generation;
	renderShell();
	try {
		const [scopesPayload, devicesPayload] = await Promise.all([
			api.loadCoordinatorAdminScopes(groupId, includeInactive),
			api.loadCoordinatorAdminDevices(groupId, true),
		]);
		if (!isCurrent()) return;
		const scopes = payloadItems<CoordinatorAdminScopeView>(scopesPayload);
		const devices = payloadItems<CachedCoordinatorAdminDevice>(devicesPayload);
		const eagerScopes = scopes.slice(0, MAX_EAGER_SPACE_MEMBERSHIP_LOADS);
		const memberEntries = await mapWithConcurrency<
			CoordinatorAdminScopeView,
			{ scopeId: string; attempted: true; members?: CoordinatorAdminScopeMemberView[] }
		>(eagerScopes, 4, async (scope) => {
			const scopeId = String(scope.scope_id || "").trim();
			if (!scopeId) {
				return { scopeId, attempted: true, members: [] as CoordinatorAdminScopeMemberView[] };
			}
			try {
				const payload = await api.loadCoordinatorAdminScopeMembers(groupId, scopeId, true);
				return {
					scopeId,
					attempted: true,
					members: payloadItems<CoordinatorAdminScopeMemberView>(payload),
				};
			} catch {
				return { scopeId, attempted: true };
			}
		});
		if (!isCurrent()) return;
		const latest = draftFor(groupId);
		const allMemberEntries: Array<{
			scopeId: string;
			attempted: boolean;
			members?: CoordinatorAdminScopeMemberView[];
		}> = [
			...memberEntries,
			...scopes.slice(MAX_EAGER_SPACE_MEMBERSHIP_LOADS).map((scope) => ({
				scopeId: String(scope.scope_id || "").trim(),
				attempted: false,
			})),
		];
		const membersByScope = new Map<string, CoordinatorAdminScopeMemberView[]>();
		const memberAvailabilityByScope = new Map<
			string,
			"fresh" | "stale" | "unavailable" | "deferred"
		>();
		for (const entry of allMemberEntries) {
			if (!entry.scopeId) continue;
			if (entry.members) {
				membersByScope.set(entry.scopeId, entry.members);
				memberAvailabilityByScope.set(entry.scopeId, "fresh");
				continue;
			}
			const previousMembers = latest.membersByScope.get(entry.scopeId);
			const previousAvailability = latest.memberAvailabilityByScope.get(entry.scopeId);
			if (
				previousMembers &&
				(previousAvailability === "fresh" || previousAvailability === "stale")
			) {
				membersByScope.set(entry.scopeId, previousMembers);
				memberAvailabilityByScope.set(entry.scopeId, "stale");
			} else {
				memberAvailabilityByScope.set(entry.scopeId, entry.attempted ? "unavailable" : "deferred");
			}
		}
		const failedMemberCount = allMemberEntries.filter(
			(entry) => entry.attempted && entry.scopeId && !entry.members,
		).length;
		setDraft(groupId, {
			...latest,
			loaded: true,
			loading: false,
			availability: "fresh",
			recoveryAnnouncement: failedMemberCount ? "" : latest.recoveryAnnouncement,
			error: failedMemberCount
				? `Membership details could not be refreshed for ${failedMemberCount} ${failedMemberCount === 1 ? "Space" : "Spaces"}. Successfully loaded Space data remains available.`
				: "",
			includeInactive,
			devicesLoaded: true,
			scopes,
			devices,
			membersByScope,
			memberAvailabilityByScope,
			actionPendingKey: "",
			actionPendingKind: "",
		});
	} catch {
		if (!isCurrent()) return;
		const latest = draftFor(groupId);
		const hasSnapshot = latest.availability === "fresh" || latest.availability === "stale";
		setDraft(groupId, {
			...latest,
			availability: hasSnapshot ? "stale" : "unavailable",
			loading: false,
			recoveryAnnouncement: "",
			error: hasSnapshot
				? "Legacy Spaces could not be refreshed. Previously loaded Space and membership details are still shown."
				: "Legacy Spaces are unavailable. No empty Space list is being assumed.",
		});
	}
	if (!isCurrent()) return;
	const completed = draftFor(groupId);
	if (
		completed.recoveryRetryRequested &&
		completed.availability === "fresh" &&
		![...completed.memberAvailabilityByScope.values()].some(
			(availability) => availability === "stale" || availability === "unavailable",
		)
	) {
		const deferredMembershipCount = [...completed.memberAvailabilityByScope.values()].filter(
			(availability) => availability === "deferred",
		).length;
		setDraft(groupId, {
			...completed,
			recoveryAnnouncement: deferredMembershipCount
				? `Spaces refreshed. Membership details for ${deferredMembershipCount} ${deferredMembershipCount === 1 ? "Space" : "Spaces"} can be loaded on demand.`
				: "Spaces and membership details refreshed.",
			recoveryFocusPending: true,
			recoveryRetryRequested: false,
		});
	} else if (completed.recoveryRetryRequested) {
		setDraft(groupId, {
			...completed,
			recoveryAnnouncement:
				"Retry finished, but some Space data still needs attention. Retained details remain unchanged.",
			recoveryFocusPending: true,
			recoveryRetryRequested: false,
		});
	}
	renderShell();
	const rendered = draftFor(groupId);
	if (rendered.recoveryFocusPending) {
		setDraft(groupId, { ...rendered, recoveryFocusPending: false });
		queueMicrotask(() =>
			document.getElementById(`coordinatorAdminSpacesStatus-${groupId}`)?.focus(),
		);
	}
}

export function openGroupScopeManagement(groupId: string, renderShell: () => void): void {
	coordinatorAdminState.groupScopeManagementOpen.add(groupId);
	draftFor(groupId);
	renderShell();
	void loadGroupScopeManagement(groupId, renderShell);
}

export function closeGroupScopeManagement(groupId: string, renderShell: () => void): void {
	coordinatorAdminState.groupScopeManagementOpen.delete(groupId);
	renderShell();
}

async function loadSingleScopeMembership(
	groupId: string,
	scopeId: string,
	renderShell: () => void,
): Promise<void> {
	const initial = draftFor(groupId);
	if (!scopeMutationStateIsFresh(initial)) {
		showRefreshAbortWarning();
		return;
	}
	if (initial.actionPendingKey) return;
	const draftGeneration = initial.loadGeneration;
	const coordinatorGeneration = coordinatorAdminState.loadGeneration;
	setDraft(groupId, {
		...initial,
		actionPendingKey: `load:${scopeId}`,
		actionPendingKind: "load",
	});
	renderShell();
	try {
		const payload = await api.loadCoordinatorAdminScopeMembers(groupId, scopeId, true);
		const current = draftFor(groupId);
		if (
			current.loadGeneration !== draftGeneration ||
			coordinatorAdminState.loadGeneration !== coordinatorGeneration ||
			!scopeMutationStateIsFresh(current)
		) {
			if (current.actionPendingKey === `load:${scopeId}`) {
				setDraft(groupId, {
					...current,
					actionPendingKey: "",
					actionPendingKind: "",
				});
				renderShell();
			}
			showRefreshAbortWarning();
			return;
		}
		const membersByScope = new Map(current.membersByScope);
		membersByScope.set(scopeId, payloadItems<CoordinatorAdminScopeMemberView>(payload));
		const memberAvailabilityByScope = new Map(current.memberAvailabilityByScope);
		memberAvailabilityByScope.set(scopeId, "fresh");
		setDraft(groupId, {
			...current,
			membersByScope,
			memberAvailabilityByScope,
			actionPendingKey: "",
			actionPendingKind: "",
			error: "",
		});
	} catch {
		const current = draftFor(groupId);
		if (current.loadGeneration !== draftGeneration) return;
		const memberAvailabilityByScope = new Map(current.memberAvailabilityByScope);
		memberAvailabilityByScope.set(
			scopeId,
			current.membersByScope.has(scopeId) ? "stale" : "unavailable",
		);
		setDraft(groupId, {
			...current,
			memberAvailabilityByScope,
			actionPendingKey: "",
			actionPendingKind: "",
			error: "Membership details could not be loaded. Existing Space data is unchanged.",
		});
	}
	renderShell();
}

async function createScope(groupId: string, renderShell: () => void): Promise<void> {
	const draft = draftFor(groupId);
	if (!scopeMutationStateIsFresh(draft)) {
		showRefreshAbortWarning();
		return;
	}
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
	if (!scopeMutationStateIsFresh(draft, scopeId)) {
		showRefreshAbortWarning();
		return;
	}
	const key = `grant:${scopeId}:${deviceId}`;
	if (draft.actionPendingKey) return;
	setDraft(groupId, { ...draft, actionPendingKey: key, actionPendingKind: "grant", error: "" });
	renderShell();
	try {
		await api.grantCoordinatorAdminScopeMember(groupId, scopeId, {
			device_id: deviceId,
			role: "member",
		});
		const latest = draftFor(groupId);
		setDraft(groupId, { ...latest, actionPendingKey: "", actionPendingKind: "" });
		showGlobalNotice("Device granted access to the Space.");
		await loadGroupScopeManagement(groupId, renderShell, latest.includeInactive);
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
	const draft = draftFor(groupId);
	if (!scopeMutationStateIsFresh(draft, scopeId)) {
		showRefreshAbortWarning();
		return;
	}
	const draftGeneration = draft.loadGeneration;
	const coordinatorGeneration = coordinatorAdminState.loadGeneration;
	const confirmed = await openSyncConfirmDialog({
		title: spaceRevokeMemberTitle(scope, displayName, deviceId),
		description:
			"Revocation blocks future sync for this Space. It does not remove data already copied to the revoked device; offline devices, backups, copied databases, malicious peers, or old versions may retain data.",
		confirmLabel: "Revoke membership",
		cancelLabel: "Keep membership",
		tone: "danger",
	});
	if (!confirmed) return;
	const current = draftFor(groupId);
	const currentScope = current.scopes.find(
		(candidate) => String(candidate.scope_id || "").trim() === scopeId,
	);
	const currentMember = current.membersByScope
		.get(scopeId)
		?.find(
			(member) =>
				String(member.device_id || "") === deviceId &&
				String(member.status || "active") === "active",
		);
	if (
		current.loadGeneration !== draftGeneration ||
		coordinatorAdminState.loadGeneration !== coordinatorGeneration ||
		!scopeMutationStateIsFresh(current, scopeId) ||
		!currentScope ||
		!currentMember ||
		current.actionPendingKey
	) {
		showGlobalNotice(
			"Space membership data changed while confirmation was open. Review current access and try again.",
			"warning",
		);
		return;
	}
	const key = `revoke:${scopeId}:${deviceId}`;
	setDraft(groupId, { ...current, actionPendingKey: key, actionPendingKind: "revoke", error: "" });
	renderShell();
	try {
		await api.revokeCoordinatorAdminScopeMember(groupId, scopeId, deviceId);
		const latest = draftFor(groupId);
		setDraft(groupId, { ...latest, actionPendingKey: "", actionPendingKind: "" });
		showGlobalNotice("Space access revoked. Future sync is blocked for that device.");
		await loadGroupScopeManagement(groupId, renderShell, latest.includeInactive);
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
	const retainedDevices = adminSnapshotTargetMatchesCurrent(
		coordinatorAdminState.devicesSnapshotTarget,
	)
		? state.lastCoordinatorAdminDevices
		: [];
	const devices = coordinatorAdminDevicesForGroup(
		draft.devices,
		retainedDevices,
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
	const memberAvailability = draft.memberAvailabilityByScope.get(scopeId);
	const memberLoadPending = draft.actionPendingKey === `load:${scopeId}`;
	const memberLoadNeeded =
		memberAvailability === "stale" ||
		memberAvailability === "unavailable" ||
		memberAvailability === "deferred";
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
		memberAvailability === "stale"
			? h(
					"div",
					{ class: "peer-submeta coordinator-admin-inline-warning", role: "status" },
					"Membership refresh failed for this Space. Previously loaded memberships are shown and changes are disabled.",
				)
			: memberAvailability === "unavailable"
				? h(
						"div",
						{ class: "peer-submeta coordinator-admin-inline-warning", role: "status" },
						"Membership details are unavailable for this Space. No empty membership list is being assumed.",
					)
				: memberAvailability === "deferred"
					? h(
							"div",
							{ class: "peer-submeta coordinator-admin-inline-warning", role: "status" },
							"Membership details were deferred to keep this large Space list bounded. Load them before changing access.",
						)
					: null,
		memberLoadNeeded
			? h(
					"button",
					{
						class: "settings-button",
						disabled: Boolean(draft.actionPendingKey),
						onClick: () => void loadSingleScopeMembership(groupId, scopeId, renderShell),
						type: "button",
					},
					memberLoadPending
						? "Loading membership…"
						: memberAvailability === "stale"
							? "Refresh membership"
							: "Load membership",
				)
			: null,
		memberAvailability === "unavailable" || memberAvailability === "deferred"
			? null
			: renderMembershipRows(
					groupId,
					scope,
					draft,
					ready && memberAvailability === "fresh",
					renderShell,
				),
	);
}

function renderScopeRecoveryStatus(
	groupId: string,
	draft: GroupScopeManagementDraft,
	renderShell: () => void,
) {
	const memberFailures = [...draft.memberAvailabilityByScope.values()].filter(
		(availability) => availability === "stale" || availability === "unavailable",
	).length;
	const hasFailure =
		draft.availability === "stale" || draft.availability === "unavailable" || memberFailures > 0;
	const retry = () => {
		const current = draftFor(groupId);
		if (current.loading || current.actionPendingKey) return;
		setDraft(groupId, {
			...current,
			recoveryAnnouncement: "Retrying Spaces and membership details…",
			recoveryRetryRequested: true,
		});
		void loadGroupScopeManagement(groupId, renderShell, current.includeInactive);
	};
	return h(
		"div",
		{
			"aria-atomic": "true",
			"aria-live": "polite",
			class: hasFailure
				? "coordinator-admin-inline-warning coordinator-admin-recovery-notice"
				: draft.recoveryAnnouncement
					? "peer-meta coordinator-admin-recovery-status"
					: "coordinator-admin-recovery-status",
			id: `coordinatorAdminSpacesStatus-${groupId}`,
			role: "status",
			tabIndex: -1,
		},
		hasFailure
			? h(
					Fragment,
					null,
					h(
						"div",
						{ class: "coordinator-admin-legacy-notice-copy" },
						h("h4", { class: "coordinator-admin-drawer-title" }, "Spaces need attention"),
						draft.recoveryAnnouncement
							? h("p", { class: "peer-submeta" }, draft.recoveryAnnouncement)
							: null,
						h(
							"p",
							{ class: "peer-submeta" },
							draft.availability === "unavailable"
								? "Current Space data could not be loaded. No empty result is being shown, and no data loss is implied."
								: draft.availability === "stale"
									? "Previously loaded Spaces are shown. Mutations are disabled until a retry succeeds."
									: `Membership details need recovery for ${memberFailures} ${memberFailures === 1 ? "Space" : "Spaces"}. Successfully loaded Spaces remain current.`,
						),
					),
					h(
						"button",
						{
							class: "settings-button",
							disabled: draft.loading || Boolean(draft.actionPendingKey),
							onClick: retry,
							type: "button",
						},
						draft.loading ? "Retrying…" : "Retry",
					),
				)
			: draft.recoveryAnnouncement,
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
	if (draft.availability === "unavailable") {
		return h(
			Fragment,
			null,
			h("h4", { class: "coordinator-admin-drawer-title" }, "Spaces"),
			h(
				"div",
				{ class: "peer-submeta" },
				"Coordinator groups discover and enroll devices. Spaces are technical transport boundaries here. These controls do not manage policy Team membership or Project access in Sharing.",
			),
			renderScopeRecoveryStatus(groupId, draft, renderShell),
		);
	}
	if (!draft.loaded) {
		return h(
			Fragment,
			null,
			h("h4", { class: "coordinator-admin-drawer-title" }, "Spaces"),
			h(
				"div",
				{ class: "peer-submeta" },
				"Coordinator groups discover and enroll devices. Spaces are technical transport boundaries here. These controls do not manage policy Team membership or Project access in Sharing.",
			),
			renderScopeRecoveryStatus(groupId, draft, renderShell),
			h("div", { class: "peer-submeta" }, "Loading Spaces…"),
		);
	}
	const mutationDisabled =
		!ready || draft.availability !== "fresh" || Boolean(draft.actionPendingKey) || draft.loading;
	const refreshDisabled = draft.loading || Boolean(draft.actionPendingKey);
	return h(
		Fragment,
		null,
		h("h4", { class: "coordinator-admin-drawer-title" }, "Spaces"),
		h(
			"div",
			{ class: "peer-submeta" },
			"Coordinator groups discover and enroll devices. Spaces are technical transport boundaries here. These controls do not manage policy Team membership or Project access in Sharing.",
		),
		renderScopeRecoveryStatus(groupId, draft, renderShell),
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
				disabled: refreshDisabled,
				onCheckedChange: (checked: boolean) => {
					if (draftFor(groupId).actionPendingKey) return;
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
					if (mutationDisabled) return;
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
						disabled: mutationDisabled,
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
						disabled: mutationDisabled,
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
						disabled: mutationDisabled,
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
						disabled: mutationDisabled,
						type: "submit",
					},
					draft.actionPendingKind === "create" ? "Creating…" : "Create Space",
				),
				h(
					"button",
					{
						class: "settings-button",
						disabled: refreshDisabled,
						onClick: () => {
							if (draftFor(groupId).actionPendingKey) return;
							void loadGroupScopeManagement(groupId, renderShell, draft.includeInactive);
						},
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
					draft.scopes.map((scope) =>
						renderScopeCard(
							groupId,
							scope,
							draft,
							ready && draft.availability === "fresh" && !draft.loading,
							renderShell,
						),
					),
				)
			: h(
					"div",
					{ class: "peer-meta coordinator-admin-empty-state" },
					"No Spaces are defined for this coordinator group yet. Create a Space only for legacy transport or recovery, then grant specific devices. Sharing policy remains separate.",
				),
	);
}
