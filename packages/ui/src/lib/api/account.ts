import type {
	RecoveryPreview,
	RecoveryPreviewRequest,
	RecoveryResult,
	RecoverySelection,
} from "../../tabs/account-owner-recovery-types";
import {
	type RecoveryProfileEnvelope,
	validRecoveryEnvelope,
	validRecoveryPreview,
	validRecoveryResult,
} from "./owner-recovery-validation";

export type AccountIntent = "connect" | "refresh" | "disconnect" | "sign_in";
export type AccountOperation = {
	intent?: AccountIntent;
	operationId: string;
	groupId: string;
	contextId: string;
	state: "starting" | "awaiting_browser" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
	failure:
		| null
		| "review_required"
		| "link_conflict"
		| "link_stopped"
		| "link_expired"
		| "request_failed"
		| "schema_upgrade_required"
		| "invalid_response"
		| "device_unavailable"
		| "identity_mismatch"
		| "context_changed"
		| "configuration_invalid"
		| "shutting_down"
		| "cancellation_unconfirmed"
		| "receiver_close_failed"
		| "account_not_linked"
		| "already_this_identity"
		| "current_identity_linked"
		| "device_already_bound"
		| "daily_limit"
		| "sign_in_unavailable"
		| "switch_pending"
		| "bind_unconfirmed";
	browserUrlAvailable: boolean;
	startedAt: string;
	deadlineAt: string;
	finishedAt: string | null;
};

export type AccountView = {
	version: 1;
	contextId: string | null;
	setup:
		| "ready"
		| "coordinator_not_configured"
		| "coordinator_url_invalid"
		| "group_selection_required"
		| "device_unavailable"
		| "identity_unavailable";
	groups: string[];
	selectedGroupId: string | null;
	local: null | {
		deviceId: string;
		fingerprint: string;
		identityId: string;
		identityLabel?: string;
		deviceLabel?: string;
	};
	coordinator: null | { origin: string };
	/** Read-only account display target, separate from local.identityId (the memory actor). */
	accountOwner?: { identityId: string; memoryActorId: string; displayName?: string };
	ownerProjection?: {
		kind: "resolved_account_owner";
		status: {
			version: 1;
			coordinatorId: string;
			groupId: string;
			deviceId: string;
			fingerprint: string;
			state: "owner_confirmed";
			ownerIdentity: string;
			profileState: "linked" | "account_unlinked" | "unavailable";
			profile: null | { email?: string; displayName?: string; pictureUrl?: string };
		};
	};
	remote:
		| { kind: "not_checked" }
		| { kind: "unsupported" }
		| { kind: "unavailable"; code: string }
		| {
				kind: "status";
				coordinatorId: string;
				authority: "controller_attestation" | "device_claim" | null;
				identityId: string | null;
				state: "review_required" | "unlinked" | "linked" | "revoked" | "conflict";
				identityMatches: boolean;
				account: null | { email?: string; displayName?: string; pictureUrl?: string };
		  };
	canLink: boolean;
	/** Sign in with Google: links this Identity, or switches the device to the account's. */
	canSignIn?: boolean;
	/** Sign-in start fields for the owner-only view, whose contextId is not a mutation context. */
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
	operation: AccountOperation | null;
	/** Displayed operation's original context, never a mutation target. */
	operationContextId?: string;
	checkedAt: string;
};

const ACCOUNT_ERROR_CODES = new Set([
	"account_owner_recovery_invalid",
	"account_owner_recovery_busy",
	"account_owner_recovery_context_changed",
	"account_owner_recovery_unavailable",
	"account_owner_recovery_storage_unsafe",
	"account_local_viewer_required",
	"account_request_rejected",
	"account_csrf_invalid",
	"account_invalid_request",
	"account_group_not_configured",
	"account_context_unavailable",
	"account_internal_error",
	"account_context_changed",
	"account_link_in_progress",
	"account_link_not_allowed",
	"account_status_unavailable",
	"account_shutting_down",
	"account_operation_not_found",
	"account_browser_url_unavailable",
	"session_unavailable",
	"invalid_response",
	"request_failed",
]);

function safeCode(value: unknown, fallback: string): string {
	return typeof value === "string" && ACCOUNT_ERROR_CODES.has(value) ? value : fallback;
}

function safeOperationId(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)
		? value
		: undefined;
}

function safeDetail(value: unknown): string | undefined {
	return typeof value === "string" && /^[\x20-\x7e]{1,512}$/.test(value) ? value : undefined;
}

async function responseError(response: Response, fallback: string): Promise<AccountRequestError> {
	const payload = (await response.json().catch(() => null)) as {
		error?: unknown;
		operationId?: unknown;
		detail?: unknown;
	} | null;
	return new AccountRequestError(
		response.status,
		safeCode(payload?.error, fallback),
		safeOperationId(payload?.operationId),
		typeof payload?.detail === "string" ? payload.detail : undefined,
	);
}

export class AccountRequestError extends Error {
	readonly code: string;
	readonly operationId?: string;
	/** Local Viewer guidance, such as the command that fixes an unsafe state directory. */
	readonly detail?: string;
	constructor(
		public readonly status: number,
		code: string,
		operationId?: string,
		detail?: string,
	) {
		const safe = safeCode(code, "request_failed");
		super(safe);
		this.code = safe;
		this.operationId = safeOperationId(operationId);
		this.detail = safeDetail(detail);
	}
}

let csrfToken: string | null = null;
async function session(signal?: AbortSignal): Promise<string> {
	const response = await fetch("/api/account/session", {
		signal,
		redirect: "error",
		cache: "no-store",
		credentials: "same-origin",
	});
	if (!response.ok) throw await responseError(response, "session_unavailable");
	const payload = (await response.json().catch(() => {
		throw new AccountRequestError(0, "invalid_response");
	})) as { csrfToken?: unknown };
	if (typeof payload?.csrfToken !== "string" || !payload.csrfToken)
		throw new AccountRequestError(0, "invalid_response");
	csrfToken = payload.csrfToken;
	return csrfToken;
}

type RecoveryConfirmation = { preview: RecoveryPreview; approvalDigest: string };
type RecoveryImport = { selection: RecoverySelection; replyText: string };
type AccountJsonBody =
	| Record<string, string>
	| RecoveryPreviewRequest
	| RecoveryConfirmation
	| RecoveryImport;

async function request<T>(
	path: string,
	options: { method?: "POST"; body?: AccountJsonBody; signal?: AbortSignal } = {},
): Promise<T> {
	const send = (token: string) =>
		fetch(path, {
			method: options.method ?? "GET",
			redirect: "error",
			signal: options.signal,
			cache: "no-store",
			credentials: "same-origin",
			headers: {
				"X-Codemem-Account-Csrf": token,
				...(options.method ? { "Content-Type": "application/json" } : {}),
			},
			...(options.method ? { body: JSON.stringify(options.body ?? {}) } : {}),
		});
	let response = await send(csrfToken ?? (await session(options.signal)));
	if (response.status === 403) {
		const payload = (await response
			.clone()
			.json()
			.catch(() => null)) as { error?: unknown } | null;
		if (payload?.error === "account_csrf_invalid") {
			csrfToken = null;
			response = await send(await session(options.signal));
		}
	}
	if (!response.ok) throw await responseError(response, "request_failed");
	return (await response.json().catch(() => {
		throw new AccountRequestError(0, "invalid_response");
	})) as T;
}

export function getAccountStatus(groupId?: string, signal?: AbortSignal): Promise<AccountView> {
	return request(
		`/api/account/link-status${groupId ? `?group_id=${encodeURIComponent(groupId)}` : ""}`,
		{ signal },
	);
}

function checkedRecovery<T>(value: unknown, validate: (value: unknown) => value is T): T {
	if (!validate(value)) throw new AccountRequestError(0, "invalid_response");
	return value;
}
export async function getOwnerRecoveryProfile(
	signal?: AbortSignal,
): Promise<RecoveryProfileEnvelope> {
	return checkedRecovery(
		await request("/api/account/owner-recovery", { signal }),
		validRecoveryEnvelope,
	);
}
export async function previewOwnerRecovery(
	body: RecoveryPreviewRequest,
	signal?: AbortSignal,
): Promise<RecoveryPreview> {
	return checkedRecovery(
		await request("/api/account/owner-recovery/preview", { method: "POST", body, signal }),
		validRecoveryPreview,
	);
}
export async function confirmOwnerRecovery(
	body: RecoveryConfirmation,
	signal?: AbortSignal,
): Promise<RecoveryResult> {
	return checkedRecovery(
		await request("/api/account/owner-recovery/confirm", { method: "POST", body, signal }),
		validRecoveryResult,
	);
}
export async function importOwnerRecoveryReply(
	body: RecoveryImport,
	signal?: AbortSignal,
): Promise<RecoveryResult> {
	return checkedRecovery(
		await request("/api/account/owner-recovery/import", { method: "POST", body, signal }),
		validRecoveryResult,
	);
}
export function startAccountLink(
	groupId: string,
	contextId: string,
	checked: {
		authority: "controller_attestation" | "device_claim";
		coordinatorId: string;
		intent?: AccountIntent;
		expectedLinkId?: string;
	},
	signal?: AbortSignal,
): Promise<{ version: 1; operation: AccountOperation }> {
	return request("/api/account/link-operations", {
		method: "POST",
		body: { groupId, contextId, ...checked },
		signal,
	});
}
export function getAccountOperation(
	id: string,
	signal?: AbortSignal,
): Promise<{ version: 1; operation: AccountOperation; current: boolean }> {
	return request(`/api/account/link-operations/${encodeURIComponent(id)}`, { signal });
}
export function getAccountBrowserUrl(
	id: string,
	signal?: AbortSignal,
): Promise<{ version: 1; url: string }> {
	return request(`/api/account/link-operations/${encodeURIComponent(id)}/browser-url`, {
		method: "POST",
		signal,
	});
}
export function cancelAccountLink(
	id: string,
	signal?: AbortSignal,
): Promise<{ version: 1; operation: AccountOperation }> {
	return request(`/api/account/link-operations/${encodeURIComponent(id)}/cancel`, {
		method: "POST",
		signal,
	});
}

const BROWSER_PATHS: Record<AccountIntent, string> = {
	connect: "/auth/link/start",
	sign_in: "/auth/rebind/start",
	refresh: "/auth/account/change/start",
	disconnect: "/auth/account/change/start",
};

export function validAccountBrowserUrl(
	value: string,
	origin: string,
	intent: AccountIntent = "connect",
): boolean {
	try {
		const url = new URL(value);
		const secure = url.protocol === "https:";
		const localHttp =
			url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
		return (
			(secure || localHttp) &&
			url.origin === origin &&
			url.pathname === BROWSER_PATHS[intent] &&
			!url.username &&
			!url.password &&
			!url.hash
		);
	} catch {
		return false;
	}
}

/** Mirrors the coordinator's conservative Google avatar policy; never fetch arbitrary URLs. */
export function validAccountPictureUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2048 || /[\p{Cc}\p{Cf}\p{Cs}\\#]/u.test(value))
		return false;
	try {
		const url = new URL(value);
		return (
			url.href === value &&
			url.protocol === "https:" &&
			url.hostname === "lh3.googleusercontent.com" &&
			!url.username &&
			!url.password &&
			!url.port
		);
	} catch {
		return false;
	}
}
