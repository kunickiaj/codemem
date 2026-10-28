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
	/** The local People name for an Identity, so My Account and Sharing name it the same way. */
	identityName?: (identityId: string) => string | undefined;
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
	accountOwner?: { identityId: string; memoryActorId: string; displayName?: string };
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
	/** "Sign in with Google": may link this Identity or switch the device to the account's. */
	canSignIn?: boolean;
	/**
	 * Where sign-in starts when this view is the owner-only projection, whose
	 * own contextId is not a mutation context: this device's own Identity.
	 */
	signIn?: {
		contextId: string;
		coordinatorId: string;
		authority: "controller_attestation" | "device_claim" | null;
	};
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
/**
 * The owner-only state offers sign-in when the owner's Google account is
 * linked and this device is unlinked or still needs enrollment review.
 * Rebind verifies the Google account before switching the device's Identity.
 */
function withOwnerSignIn(
	owner: AccountLinkViewV1,
	own: AccountLinkViewV1,
	context: AccountContext,
	remote: Extract<CoordinatorAccountLinkStatusRead, { kind: "status" }>,
): AccountLinkViewV1 {
	if (
		owner.ownerProjection?.status.profileState !== "linked" ||
		own.remote.kind !== "status" ||
		(own.remote.state !== "review_required" &&
			!(own.canSignIn === true && own.remote.state === "unlinked"))
	)
		return owner;
	return {
		...owner,
		canSignIn: true,
		signIn: {
			contextId: context.contextId,
			coordinatorId: remote.status.coordinatorId,
			authority: remote.status.authority,
		},
	};
}

function attachOperation(
	input: AccountLinkViewV1,
	registry?: AccountLinkRegistry,
	operationContextId = input.contextId,
): AccountLinkViewV1 {
	// Without a rebind runner there is no sign-in; the UI keeps the link action.
	const { canSignIn, signIn, ...rest } = input;
	const view: AccountLinkViewV1 = registry?.supportsSignIn?.() ? input : rest;
	void canSignIn;
	void signIn;
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
			...("canSignIn" in view ? { canSignIn: false } : {}),
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
		canSignIn: false,
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
		canSignIn: identityMatches && signInState(status),
		blockedReason,
	};
}
/** Sign-in starts unlinked, or linked when this device has no proof of its own (a self-bind). */
function signInState(status: { state: string; account: unknown }): boolean {
	return status.state === "unlinked" || (status.state === "linked" && !status.account);
}
type AccountStatusResult = AccountLinkViewV1 | Extract<AccountContextResult, { error: string }>;

type ReadOptions = {
	expectedContext?: AccountContext;
	/** Sign-in checks this device's own Identity, not an owner-only projection. */
	ownIdentityOnly?: boolean;
};

export async function readAccountStatus(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	groupId: string | undefined,
	signal: AbortSignal,
	readOptions: ReadOptions = {},
): Promise<AccountStatusResult> {
	const initial = options.readContext(groupId);
	if ("error" in initial) return initial;
	if (
		groupId === undefined &&
		readOptions.expectedContext === undefined &&
		initial.setup === "group_selection_required" &&
		initial.groups.length > 0
	)
		return withPeopleNames(
			options,
			await readFirstUsableGroupStatus(options, initial.groups, signal),
		);
	return withPeopleNames(
		options,
		await readStatusFromContext(options, initial, groupId, signal, readOptions),
	);
}

/**
 * Names come from the local People list at view time. They stay out of the
 * context, so renaming someone in Sharing cannot abort an account operation.
 */
function withPeopleNames(
	options: AccountStatusOptions,
	result: AccountStatusResult,
): AccountStatusResult {
	if ("error" in result) return result;
	const name = (identityId: string) => {
		try {
			return options.identityName?.(identityId) || undefined;
		} catch {
			return undefined;
		}
	};
	let view = result;
	const localName = view.local ? name(view.local.identityId) : undefined;
	if (view.local && localName)
		view = { ...view, local: { ...view.local, identityLabel: localName } };
	const ownerName = view.accountOwner ? name(view.accountOwner.identityId) : undefined;
	if (view.accountOwner && ownerName)
		view = { ...view, accountOwner: { ...view.accountOwner, displayName: ownerName } };
	return view;
}

/** 2: use this group. 1: review, keep looking. 0: this enrollment was refused. -1: stop. */
function usableStatusRank(result: AccountStatusResult): number {
	if ("error" in result) return -1;
	if (result.ownerProjection) return 2;
	if (result.remote.kind === "status") return result.remote.state === "review_required" ? 1 : 2;
	// Only a refusal of this device's enrollment says another group might work.
	// Outages, rate limits, and version problems apply to the whole coordinator.
	if (result.remote.kind === "unavailable" && result.remote.code === "coordinator_rejected")
		return 0;
	return -1;
}

/**
 * Account status is per coordinator, and the group only picks which enrollment
 * signs the request. Try configured groups in order and keep the first one
 * whose enrollment the coordinator accepts, preferring a decided status over
 * review. Each attempt is a full signed read with its own context checks.
 */
async function readFirstUsableGroupStatus(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	groups: readonly string[],
	signal: AbortSignal,
): Promise<AccountStatusResult> {
	let best: AccountStatusResult | null = null;
	for (const groupId of groups) {
		if (signal.aborted) break;
		const result = await readGroupAccountStatus(options, groupId, signal);
		const rank = usableStatusRank(result);
		if (rank === 2) return result;
		if (rank === -1) return best && usableStatusRank(best) === 1 ? best : result;
		if (!best || rank > usableStatusRank(best)) best = result;
	}
	return best ?? readGroupAccountStatus(options, undefined, signal);
}

async function readGroupAccountStatus(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	groupId: string | undefined,
	signal: AbortSignal,
): Promise<AccountStatusResult> {
	const initial = options.readContext(groupId);
	if ("error" in initial) return initial;
	return readStatusFromContext(options, initial, groupId, signal);
}

async function readStatusFromContext(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	initial: LocalResult,
	groupId: string | undefined,
	signal: AbortSignal,
	readOptions: ReadOptions = {},
): Promise<AccountStatusResult> {
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
	return finishAccountStatus(options, initial.context, fresh, remote, {
		signal,
		ownIdentityOnly: readOptions.ownIdentityOnly === true,
	});
}

async function finishAccountStatus(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	context: AccountContext,
	fresh: LocalResult,
	remote: CoordinatorAccountLinkStatusRead,
	read: { signal: AbortSignal; ownIdentityOnly: boolean },
): Promise<AccountLinkViewV1> {
	const { signal } = read;
	const currentView = applyRemote(accountLocalView(fresh), remote);
	if (remote.kind === "status") {
		const associated = await readAssociatedOwner(options, context, currentView, remote, signal);
		if (associated) {
			const owner = withOwnerSignIn(associated, currentView, context, remote);
			// Sign-in starts from this device's own view only where the owner view offers it.
			if (read.ownIdentityOnly && owner.signIn?.contextId === context.contextId)
				return attachOperation({ ...currentView, canSignIn: true }, options.registry);
			return attachOperation(owner, options.registry, context.contextId);
		}
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
	const local = {
		...view,
		remote: { kind: "not_checked" as const },
		canLink: false,
		canSignIn: false,
	};
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
