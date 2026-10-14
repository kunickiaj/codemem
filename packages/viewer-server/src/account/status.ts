import {
	type CoordinatorAccountLinkStatusRead,
	readCoordinatorAccountLinkStatus,
} from "@codemem/core";
import type {
	AccountContext,
	AccountContextReader,
	AccountContextResult,
	AccountSetup,
} from "./context.js";
import type { AccountLinkOperationV1, AccountLinkRegistry } from "./link-registry.js";

export interface AccountStatusOptions {
	registry?: AccountLinkRegistry;
	readContext?: AccountContextReader;
	readRemoteStatus?: typeof readCoordinatorAccountLinkStatus;
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
	remote:
		| { kind: "not_checked" }
		| { kind: "unsupported" }
		| { kind: "unavailable"; code: UnavailableCode | "context_changed" }
		| {
				kind: "status";
				coordinatorId: string;
				identityId: string | null;
				state: "review_required" | "unlinked" | "linked" | "revoked" | "conflict";
				identityMatches: boolean;
				account: { email?: string; displayName?: string } | null;
		  };
	canLink: boolean;
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
	checkedAt: string;
}
type LocalResult = Exclude<AccountContextResult, { error: string }>;
function attachOperation(
	view: AccountLinkViewV1,
	registry?: AccountLinkRegistry,
): AccountLinkViewV1 {
	const operation = view.contextId ? (registry?.forContext(view.contextId) ?? null) : null;
	if (registry?.hasActive())
		return { ...view, operation, canLink: false, blockedReason: "operation_active" };
	return { ...view, operation };
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
): Promise<AccountLinkViewV1 | Extract<AccountContextResult, { error: string }>> {
	const initial = options.readContext(groupId);
	if ("error" in initial) return initial;
	const view = accountLocalView(initial);
	if (initial.setup !== "ready" || !initial.context) return attachOperation(view, options.registry);
	const snapshot = JSON.stringify(initial);
	let remote: CoordinatorAccountLinkStatusRead;
	try {
		const { dbPath, keysDir, groupId, coordinatorUrl } = initial.context;
		remote = await (options.readRemoteStatus ?? readCoordinatorAccountLinkStatus)({
			dbPath,
			keysDir,
			groupId,
			coordinatorUrl,
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
	if ("error" in fresh || snapshot !== JSON.stringify(fresh) || tupleChanged) {
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
	return attachOperation(applyRemote(accountLocalView(fresh), remote), options.registry);
}
