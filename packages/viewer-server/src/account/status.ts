import {
	type CoordinatorAccountChangeCapabilitiesRead,
	type CoordinatorAccountLinkStatusRead,
	type CoordinatorResolvedAccountOwnerStatusRead,
	type ResolvedAccountOwnerStatus,
	readCoordinatorAccountChangeCapabilities,
	readCoordinatorAccountLinkStatus,
	readCoordinatorResolvedAccountOwnerStatus,
} from "@codemem/core";
import type {
	AccountContext,
	AccountContextReader,
	AccountContextResult,
	AccountSetup,
} from "./context.js";
import {
	type AccountLinkOperationV1,
	type AccountLinkRegistry,
	sameAuthority,
} from "./link-registry.js";
import { associatedOwnerView, ownerUnavailable, readOwnerAssociation } from "./owner-status.js";

export interface AccountStatusOptions {
	registry?: AccountLinkRegistry;
	readContext?: AccountContextReader;
	readRemoteStatus?: typeof readCoordinatorAccountLinkStatus;
	readRemoteOwnerStatus?: typeof readCoordinatorResolvedAccountOwnerStatus;
	readRemoteCapabilities?: typeof readCoordinatorAccountChangeCapabilities;
}
type UnavailableCode = Extract<CoordinatorAccountLinkStatusRead, { kind: "unavailable" }>["code"];
export interface AccountLinkViewV1 {
	version: 1;
	contextId: string | null;
	setup: AccountSetup;
	groups: string[];
	selectedGroupId: string | null;
	local: Pick<
		AccountContext,
		"deviceId" | "fingerprint" | "identityId" | "identityLabel" | "deviceLabel"
	> | null;
	coordinator: { origin: string } | null;
	/** Display target only; local.identityId and all mutation contexts remain the memory actor. */
	accountOwner?: { identityId: string; memoryActorId: string };
	/** Read-only owner evidence, never ordinary account authority or management capabilities. */
	ownerProjection?: {
		kind: "resolved_account_owner";
		status: Extract<ResolvedAccountOwnerStatus, { state: "owner_confirmed" }>;
	};
	remote:
		| { kind: "not_checked" }
		| { kind: "unsupported" }
		| {
				kind: "unavailable";
				code: UnavailableCode | "context_changed" | "account_owner_association_invalid";
		  }
		| {
				kind: "status";
				coordinatorId: string;
				authority: "controller_attestation" | "device_claim" | null;
				identityId: string | null;
				state: "review_required" | "unlinked" | "linked" | "revoked" | "conflict";
				identityMatches: boolean;
				account: { email?: string; displayName?: string; pictureUrl?: string } | null;
		  };
	canLink: boolean;
	managementActions?: { refresh: boolean; disconnect: boolean };
	unlinkTarget?: string;
	blockedReason:
		| null
		| "setup_incomplete"
		| "status_unavailable"
		| "unsupported"
		| "review_required"
		| "already_linked"
		| "revoked"
		| "conflict"
		| "identity_mismatch"
		| "operation_active";
	operation: AccountLinkOperationV1 | null;
	/** Displayed operation's original context, never a mutation target. */
	operationContextId?: string;
	checkedAt: string;
}
type LocalResult = Exclude<AccountContextResult, { error: string }>;
function attachOperation(
	view: AccountLinkViewV1,
	registry?: AccountLinkRegistry,
	operationContextId = view.contextId,
): AccountLinkViewV1 {
	const operation = operationContextId ? (registry?.forContext(operationContextId) ?? null) : null;
	const operationContext =
		operation && operationContextId && operationContextId !== view.contextId
			? { operationContextId }
			: {};
	if (registry?.hasActive())
		return {
			...view,
			...operationContext,
			operation,
			canLink: false,
			blockedReason: "operation_active",
		};
	return { ...view, ...operationContext, operation };
}
export function accountLocalView(result: LocalResult): AccountLinkViewV1 {
	const context = result.context;
	return {
		version: 1,
		contextId: context?.contextId ?? null,
		setup: result.setup,
		groups: result.groups,
		selectedGroupId: result.selectedGroupId,
		coordinator: result.coordinator,
		local: context
			? {
					deviceId: context.deviceId,
					fingerprint: context.fingerprint,
					identityId: context.identityId,
					identityLabel: context.identityLabel,
					deviceLabel: context.deviceLabel,
				}
			: null,
		remote: { kind: "not_checked" },
		canLink: false,
		blockedReason: "setup_incomplete",
		operation: null,
		checkedAt: new Date().toISOString(),
	};
}
function applyRemote(
	view: AccountLinkViewV1,
	remote: CoordinatorAccountLinkStatusRead,
): AccountLinkViewV1 {
	if (remote.kind !== "status")
		return {
			...view,
			remote:
				remote.kind === "unsupported"
					? { kind: "unsupported" }
					: { kind: "unavailable", code: remote.code },
			blockedReason: remote.kind === "unsupported" ? "unsupported" : "status_unavailable",
		};
	const status = remote.status;
	const identityMatches =
		status.identityId !== null && status.identityId === view.local?.identityId;
	let blockedReason: AccountLinkViewV1["blockedReason"] = null;
	if (status.state === "review_required" || status.state === "conflict")
		blockedReason = status.state;
	else if (!identityMatches) blockedReason = "identity_mismatch";
	else if (status.state === "linked") blockedReason = "already_linked";
	else if (status.state === "revoked") blockedReason = "revoked";
	return {
		...view,
		remote: {
			kind: "status",
			coordinatorId: status.coordinatorId,
			authority: status.authority,
			identityId: status.identityId,
			state: status.state,
			identityMatches,
			account: identityMatches && status.state === "linked" ? status.account : null,
		},
		canLink: status.state === "unlinked" && identityMatches,
		blockedReason,
	};
}
export async function readAccountStatus(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	groupId: string | undefined,
	signal: AbortSignal,
	readOptions: { expectedContext?: AccountContext } = {},
): Promise<AccountLinkViewV1 | Extract<AccountContextResult, { error: string }>> {
	const initial = options.readContext(groupId);
	if ("error" in initial) return initial;
	const view = accountLocalView(initial);
	if (initial.setup !== "ready" || !initial.context) return attachOperation(view, options.registry);
	const snapshot = JSON.stringify(initial);
	let remote: CoordinatorAccountLinkStatusRead;
	try {
		const { dbPath, keysDir, groupId, coordinatorUrl, identityId } = initial.context;
		remote = await (options.readRemoteStatus ?? readCoordinatorAccountLinkStatus)({
			dbPath,
			keysDir,
			groupId,
			coordinatorUrl,
			identityId,
			signal,
		});
	} catch {
		remote = { kind: "unavailable", code: "coordinator_unreachable" };
	}
	let fresh: AccountContextResult;
	try {
		fresh = options.readContext(groupId);
	} catch {
		fresh = { error: "account_context_unavailable" };
	}
	const subject = "error" in fresh ? null : fresh.context;
	const tupleChanged =
		remote.kind === "status" &&
		(remote.status.groupId !== subject?.groupId ||
			remote.status.deviceId !== subject?.deviceId ||
			remote.status.fingerprint !== subject?.fingerprint);
	const expectedChanged =
		readOptions.expectedContext !== undefined &&
		(!initial.context || !sameAuthority(readOptions.expectedContext, initial.context));
	if ("error" in fresh || snapshot !== JSON.stringify(fresh) || tupleChanged || expectedChanged) {
		const local =
			"error" in fresh
				? accountLocalView({
						setup: "device_unavailable",
						groups: [],
						selectedGroupId: null,
						coordinator: null,
						context: null,
					})
				: accountLocalView(fresh);
		return attachOperation(
			{
				...local,
				remote: { kind: "unavailable", code: "context_changed" },
				blockedReason: "status_unavailable",
			},
			options.registry,
		);
	}
	return finishAccountStatus(options, initial.context, fresh, remote, signal);
}

async function finishAccountStatus(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	context: AccountContext,
	fresh: LocalResult,
	remote: CoordinatorAccountLinkStatusRead,
	signal: AbortSignal,
): Promise<AccountLinkViewV1> {
	const currentView = applyRemote(accountLocalView(fresh), remote);
	if (remote.kind === "status") {
		const associated = await readAssociatedOwner(options, context, currentView, remote, signal);
		if (associated) return attachOperation(associated, options.registry, context.contextId);
	}
	await attachManagementActions(options, context, currentView, signal);
	if (remote.kind === "status") {
		try {
			if (readOwnerAssociation(context, remote.status.coordinatorId))
				return attachOperation(
					ownerUnavailable(accountLocalView(fresh), "context_changed"),
					options.registry,
				);
		} catch {
			return attachOperation(
				ownerUnavailable(accountLocalView(fresh), "account_owner_association_invalid"),
				options.registry,
			);
		}
	}
	return attachOperation(currentView, options.registry);
}

async function readAssociatedOwner(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	context: AccountContext,
	view: AccountLinkViewV1,
	actorRemote: Extract<CoordinatorAccountLinkStatusRead, { kind: "status" }>,
	signal: AbortSignal,
): Promise<AccountLinkViewV1 | null> {
	const local = { ...view, remote: { kind: "not_checked" as const }, canLink: false };
	try {
		const association = readOwnerAssociation(context, actorRemote.status.coordinatorId);
		if (!association) return null;
		const before = options.readContext(context.groupId);
		if ("error" in before || !before.context || !sameAuthority(context, before.context))
			return ownerUnavailable(local, "context_changed");
		const { dbPath, keysDir, groupId, coordinatorUrl } = context;
		let remote: CoordinatorResolvedAccountOwnerStatusRead;
		try {
			remote = await (options.readRemoteOwnerStatus ?? readCoordinatorResolvedAccountOwnerStatus)({
				dbPath,
				keysDir,
				groupId,
				coordinatorUrl,
				ownerIdentityId: association.ownerIdentityId,
				signal,
			});
		} catch {
			remote = { kind: "unavailable", code: "coordinator_unreachable" };
		}
		const after = options.readContext(context.groupId);
		if (
			signal.aborted ||
			JSON.stringify(before) !== JSON.stringify(after) ||
			JSON.stringify(association) !==
				JSON.stringify(readOwnerAssociation(context, association.coordinatorId))
		)
			return ownerUnavailable(local, "context_changed");
		return associatedOwnerView(local, context, association, remote);
	} catch {
		return ownerUnavailable(local, "account_owner_association_invalid");
	}
}

async function attachManagementActions(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	context: AccountContext,
	view: AccountLinkViewV1,
	signal: AbortSignal,
): Promise<void> {
	if (
		view.remote.kind !== "status" ||
		view.remote.state !== "linked" ||
		!view.remote.identityMatches
	)
		return;
	// Injecting status alone must not unexpectedly make a real signed request in tests.
	const read =
		options.readRemoteCapabilities ??
		(options.readRemoteStatus ? null : readCoordinatorAccountChangeCapabilities);
	if (!read) return;
	let capabilities: CoordinatorAccountChangeCapabilitiesRead | null = null;
	try {
		const { dbPath, keysDir, groupId, coordinatorUrl, identityId } = context;
		capabilities = await read({
			dbPath,
			keysDir,
			groupId,
			coordinatorUrl,
			identityId,
			signal,
		});
	} catch {
		// Capability failure alone is optional; local context must still be checked.
	}
	let fresh: AccountContextResult;
	try {
		fresh = options.readContext(context.groupId);
	} catch {
		fresh = { error: "account_context_unavailable" };
	}
	if (
		signal.aborted ||
		"error" in fresh ||
		fresh.setup !== "ready" ||
		!fresh.context ||
		!sameAuthority(context, fresh.context)
	) {
		view.remote = { kind: "unavailable", code: "context_changed" };
		view.blockedReason = "status_unavailable";
		return;
	}
	if (
		capabilities?.kind !== "capabilities" ||
		capabilities.coordinatorId !== view.remote.coordinatorId
	)
		return;
	view.managementActions = {
		...capabilities.actions,
		disconnect: capabilities.actions.disconnect && !!capabilities.unlinkTarget,
	};
	if (view.managementActions.disconnect) view.unlinkTarget = capabilities.unlinkTarget;
}
