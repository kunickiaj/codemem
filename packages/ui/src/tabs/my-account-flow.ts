import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
	type AccountIntent,
	type AccountOperation,
	AccountRequestError,
	type AccountView,
	cancelAccountLink,
	getAccountBrowserUrl,
	getAccountOperation,
	getAccountStatus,
	startAccountLink,
	validAccountBrowserUrl,
} from "../lib/api/account";

const active = (op: AccountOperation) => op.state === "starting" || op.state === "awaiting_browser";

export function accountOperationCopy(operation?: AccountOperation | null) {
	return {
		connect: { activity: "linking", subject: "Linking", attempt: "link" },
		sign_in: { activity: "sign-in", subject: "Sign-in", attempt: "sign-in" },
		refresh: { activity: "refresh", subject: "Refresh", attempt: "refresh" },
		disconnect: { activity: "unlinking", subject: "Unlinking", attempt: "unlink" },
	}[operation?.intent ?? "connect"];
}

export function unknownAccountOutcome(operation: AccountOperation): string {
	return `We couldn’t confirm whether ${accountOperationCopy(operation).activity} finished. Check status.`;
}

function errorText(error: unknown): string {
	if (error instanceof AccountRequestError) {
		if (error.status === 404) return "Account linking is not available in this Viewer.";
		if (error.code === "account_local_viewer_required")
			return "Start the Viewer on localhost and open it in a browser on the same computer. Remote or SSH-forwarded viewing cannot link an account.";
		if (error.code === "account_context_changed")
			return "The local account context changed. Check status before trying again.";
		if (error.code === "account_link_not_allowed")
			return "This account action is not available for this Identity. Check status.";
		if (error.status === 503)
			return "Account status is unavailable right now. Check status again later.";
	}
	return "We couldn’t confirm the account status. Check status again.";
}

function canBeginLink(
	view: AccountView | null,
	busy: boolean,
	intent: AccountIntent,
	confirmedView?: AccountView,
): view is AccountView & { contextId: string; selectedGroupId: string } {
	if (intent === "disconnect" && (!confirmedView || confirmedView !== view || !view?.unlinkTarget))
		return false;
	if (
		!view ||
		busy ||
		view.operation?.state === "outcome_unknown" ||
		view.blockedReason === "operation_active"
	)
		return false;
	const allowed = {
		connect: view.canLink,
		sign_in: view.canSignIn === true,
		refresh: view.managementActions?.refresh === true,
		disconnect: view.managementActions?.disconnect === true,
	}[intent];
	return Boolean(allowed && view.contextId && view.selectedGroupId);
}
/** An owner-only view's sign-in runs in this device's own context, not the view's. */
function startsFromOwnIdentity(operation: AccountOperation, view: AccountView): boolean {
	return operation.intent === "sign_in" && operation.contextId === view.signIn?.contextId;
}
/** The operation runs in this view's context, or is its owner-only sign-in. */
function ownsOperation(operation: AccountOperation, view: AccountView): boolean {
	return operation.contextId === view.contextId || startsFromOwnIdentity(operation, view);
}
function sameOperationContext(
	operation: AccountOperation,
	view: AccountView,
	intent?: AccountIntent,
): boolean {
	return (
		(operation.contextId === (view.operationContextId ?? view.contextId) ||
			startsFromOwnIdentity(operation, view)) &&
		operation.groupId === view.selectedGroupId &&
		(intent === undefined || (operation.intent ?? "connect") === intent)
	);
}
function isInProgress(error: unknown): boolean {
	return error instanceof AccountRequestError && error.code === "account_link_in_progress";
}

function useFlowState(onViewChange?: (view: AccountView | null) => void) {
	const [group, setGroup] = useState<string | undefined>(undefined);
	const [view, setViewState] = useState<AccountView | null>(null);
	// Notify in the same call that changes the view so a parent never shows
	// account data after this card has cleared it (a passive effect would lag).
	const onViewChangeRef = useRef(onViewChange);
	onViewChangeRef.current = onViewChange;
	const setView = useCallback((next: AccountView | null) => {
		setViewState(next);
		onViewChangeRef.current?.(next);
	}, []);
	const [operation, setOperation] = useState<AccountOperation | null>(null);
	const [pendingOperation, setPendingOperation] = useState<AccountOperation | null>(null);
	const [message, setMessage] = useState("Checking account status…");
	const [busy, setBusy] = useState(false);
	const [fallback, setFallback] = useState(false);
	const refs = useRef({
		privateUrl: null as string | null,
		popup: null as Window | null,
		authWindow: null as {
			window: Window;
			operationId: string;
			contextId: string;
			groupId: string;
			intent: AccountIntent;
			succeeded: boolean;
		} | null,
		delivered: null as string | null,
		generation: 0,
		starting: false,
		cancelling: false,
		controller: null as AbortController | null,
	});
	return {
		group,
		setGroup,
		view,
		setView,
		operation,
		setOperation,
		pendingOperation,
		setPendingOperation,
		message,
		setMessage,
		busy,
		setBusy,
		fallback,
		setFallback,
		refs,
	};
}
type Flow = ReturnType<typeof useFlowState>;

function closeReservedPopup(flow: Flow): void {
	const target = flow.refs.current.popup;
	flow.refs.current.popup = null;
	try {
		target?.close();
	} catch {
		// Browser may already have closed the reserved blank tab.
	}
}

function reset(flow: Flow): void {
	flow.refs.current.generation++;
	flow.refs.current.starting = false;
	flow.refs.current.cancelling = false;
	flow.refs.current.controller?.abort();
	flow.refs.current.controller = null;
	flow.refs.current.privateUrl = null;
	closeReservedPopup(flow);
	// Keep delivery suppressed across uncertain status and cancellation replies.
	flow.setFallback(false);
}

function rememberOperation(flow: Flow, excludeOperationId?: string): void {
	if (flow.operation && active(flow.operation) && flow.operation.operationId !== excludeOperationId)
		flow.setPendingOperation(flow.operation);
}

function operationMissing(error: unknown): boolean {
	return error instanceof AccountRequestError && error.code === "account_operation_not_found";
}

function previousOutcomeNotice(operation: AccountOperation): string | undefined {
	const { attempt } = accountOperationCopy(operation);
	switch (operation.state) {
		case "succeeded":
			return `The earlier ${attempt} finished for its original Identity. Check status there to confirm.`;
		case "cancelled":
			return `Cancellation of the earlier ${attempt} was reported. Check status for its original Identity to confirm the account state.`;
		case "failed":
			return `The earlier ${attempt} failed for its original Identity.`;
		case "outcome_unknown":
			return `We couldn’t confirm how the earlier ${attempt} ended. Check status for its original Identity.`;
		default:
			return undefined;
	}
}

async function checkExpiredPendingOperation(
	flow: Flow,
	options: { epoch: number; signal: AbortSignal },
): Promise<string | undefined> {
	const pending = flow.pendingOperation;
	if (!pending || Date.parse(pending.deadlineAt) > Date.now()) return;
	try {
		const result = await getAccountOperation(pending.operationId, options.signal);
		if (options.signal.aborted || options.epoch !== flow.refs.current.generation) return;
		rememberAuthWindowSuccess(flow, result.operation);
		if (active(result.operation)) {
			flow.setPendingOperation(result.operation);
			return;
		}
		flow.setPendingOperation(null);
		return previousOutcomeNotice(result.operation);
	} catch (error) {
		if (options.signal.aborted || options.epoch !== flow.refs.current.generation) return;
		if (operationMissing(error)) {
			flow.setPendingOperation(null);
			return "The earlier link attempt is no longer available. Check status for its original Identity.";
		}
		return "The earlier link outcome could not be checked. Check status again.";
	}
}

function closeCompletedAuthWindow(flow: Flow, result: AccountView): void {
	const authWindow = flow.refs.current.authWindow;
	if (
		result.remote.kind === "status" &&
		result.remote.identityMatches &&
		authWindow &&
		result.remote.state === (authWindow.intent === "disconnect" ? "unlinked" : "linked") &&
		authWindow.contextId === result.contextId &&
		authWindow.groupId === result.selectedGroupId &&
		authWindow.succeeded
	) {
		flow.refs.current.authWindow = null;
		try {
			authWindow.window.close();
		} catch {
			// Isolated browser windows may need to be closed manually.
		}
	}
}

function showStatus(
	flow: Flow,
	result: AccountView,
	options: { notice?: string; previousNotice?: string; excludeOperationId?: string },
): void {
	rememberAuthWindowSuccess(flow, result.operation);
	closeCompletedAuthWindow(flow, result);
	const verifiedLinked =
		result.remote.kind === "status" &&
		result.remote.state === "linked" &&
		result.remote.identityMatches;
	flow.setView(result);
	if (
		result.operation &&
		(!active(result.operation) ||
			(!verifiedLinked && sameOperationContext(result.operation, result)))
	) {
		const candidate = result.operation;
		flow.setPendingOperation((previous) =>
			previous?.operationId === candidate.operationId ? null : previous,
		);
	}
	flow.setOperation(
		(!verifiedLinked ||
			result.operation?.contextId !== result.contextId ||
			(result.operation?.intent !== undefined && result.operation.intent !== "connect") ||
			result.operation?.state === "outcome_unknown" ||
			activeOperation(result.operation)) &&
			result.operation &&
			sameOperationContext(result.operation, result) &&
			result.operation.operationId !== options.excludeOperationId
			? result.operation
			: null,
	);
	flow.setMessage(options.previousNotice ?? (verifiedLinked ? "" : (options.notice ?? "")));
}

async function refresh(
	flow: Flow,
	options: {
		groupId?: string;
		notice?: string;
		previousNotice?: string;
		excludeOperationId?: string;
		terminalOperationId?: string;
		checkExpiredPending?: boolean;
	} = {},
): Promise<void> {
	rememberOperation(flow, options.terminalOperationId);
	reset(flow);
	const epoch = flow.refs.current.generation;
	const abort = new AbortController();
	flow.refs.current.controller = abort;
	flow.setBusy(true);
	flow.setView(null);
	flow.setOperation(null);
	flow.setMessage("Checking account status…");
	let previousNotice = options.previousNotice;
	try {
		if (options.checkExpiredPending) {
			previousNotice =
				(await checkExpiredPendingOperation(flow, { epoch, signal: abort.signal })) ??
				previousNotice;
			if (epoch !== flow.refs.current.generation) return;
		}
		const groupId = "groupId" in options ? options.groupId : flow.group;
		const result = await loadStatus(flow, groupId, epoch, abort.signal);
		if (epoch !== flow.refs.current.generation) return;
		showStatus(flow, result, { ...options, previousNotice });
	} catch (error) {
		if (epoch === flow.refs.current.generation) {
			let message = errorText(error);
			if (previousNotice) message = `${previousNotice} ${message}`;
			flow.setMessage(message);
		}
	} finally {
		if (epoch === flow.refs.current.generation) flow.setBusy(false);
	}
}

async function loadStatus(
	flow: Flow,
	groupId: string | undefined,
	epoch: number,
	signal: AbortSignal,
): Promise<AccountView> {
	try {
		return await getAccountStatus(groupId, signal);
	} catch (error) {
		if (
			epoch !== flow.refs.current.generation ||
			!groupId ||
			!(error instanceof AccountRequestError) ||
			error.code !== "account_group_not_configured"
		)
			throw error;
		flow.setGroup(undefined);
		// A single default lookup can discover changed configuration, including zero groups.
		return getAccountStatus(undefined, signal);
	}
}

function useStatusEffect(flow: Flow): void {
	useEffect(() => {
		void refresh(flow, { groupId: flow.group });
		return () => reset(flow);
	}, []);
}

function selectGroup(flow: Flow, groupId: string | undefined): void {
	flow.setGroup(groupId);
	void refresh(flow, { groupId });
}

async function adoptConflict(
	flow: Flow,
	operationId: string,
	epoch: number,
	currentView: AccountView,
): Promise<boolean> {
	try {
		const { operation: candidate, current } = await getAccountOperation(
			operationId,
			flow.refs.current.controller?.signal,
		);
		if (epoch === flow.refs.current.generation) rememberAuthWindowSuccess(flow, candidate);
		if (
			epoch !== flow.refs.current.generation ||
			!current ||
			!sameOperationContext(candidate, currentView)
		)
			return false;
		if (!active(candidate)) {
			await refresh(flow, { excludeOperationId: candidate.operationId });
			return true;
		}
		flow.setOperation(candidate);
		flow.setMessage(
			`${accountOperationCopy(candidate).subject} is already in progress for this Identity.`,
		);
		return true;
	} catch {
		if (epoch === flow.refs.current.generation) {
			// An unavailable operation GET does not invalidate fresh status for this context.
			await refresh(flow, { groupId: currentView.selectedGroupId ?? undefined });
		}
		return true;
	}
}

async function startFailure(
	flow: Flow,
	error: unknown,
	epoch: number,
	currentView: AccountView,
): Promise<void> {
	if (epoch !== flow.refs.current.generation) return;
	if (error instanceof AccountRequestError && isInProgress(error) && error.operationId) {
		if (await adoptConflict(flow, error.operationId, epoch, currentView)) return;
	}
	if (epoch !== flow.refs.current.generation) return;
	void refresh(flow, {
		groupId: currentView.selectedGroupId ?? undefined,
		previousNotice:
			error instanceof AccountRequestError && error.code === "account_context_changed"
				? errorText(error)
				: undefined,
		excludeOperationId:
			isInProgress(error) && error instanceof AccountRequestError ? error.operationId : undefined,
		notice: isInProgress(error)
			? "Another account link is in progress. Check status."
			: errorText(error),
	});
}

function activeOperation(operation: AccountOperation | null): boolean {
	return operation !== null && active(operation);
}

function reservePopup(intent: AccountIntent): Window | null {
	if (intent === "disconnect") return null;
	const opened = window.open("about:blank", "_blank");
	if (opened) opened.opener = null;
	return opened;
}
type StartTarget = {
	contextId: string;
	coordinatorId: string;
	authority: "controller_attestation" | "device_claim" | null;
};

/**
 * The context and coordinator an operation starts against: the owner-only
 * view's sign-in target, or this Identity's checked status.
 */
function startTarget(view: AccountView, intent: AccountIntent): StartTarget | null {
	const signIn = intent === "sign_in" ? view.signIn : undefined;
	if (signIn) return signIn;
	const remote = view.remote;
	if (
		remote.kind !== "status" ||
		!expectedRemoteStates(intent).includes(remote.state) ||
		!remote.identityMatches ||
		(remote.authority !== "controller_attestation" &&
			remote.authority !== "device_claim" &&
			!(intent === "sign_in" && remote.authority === null)) ||
		!view.contextId
	)
		return null;
	return {
		contextId: view.contextId,
		coordinatorId: remote.coordinatorId,
		authority: remote.authority,
	};
}

/**
 * Linking starts from an unlinked Identity and account changes from a linked
 * one. Sign-in also starts from a linked Identity this device has no proof for.
 */
function expectedRemoteStates(intent: AccountIntent): string[] {
	if (intent === "sign_in") return ["unlinked", "linked"];
	return intent === "connect" ? ["unlinked"] : ["linked"];
}
const WAITING_MESSAGES = {
	disconnect: "Unlinking Google account…",
	sign_in:
		"Waiting for Google sign-in. If the account belongs to another Identity, you’ll confirm before this device switches.",
	connect:
		"Waiting for Google sign-in. This links your account to this Identity; it does not grant sharing access.",
	refresh:
		"Waiting for Google sign-in to refresh your account. Keep this Viewer open on the same computer.",
};
async function link(
	flow: Flow,
	intent: AccountIntent = "connect",
	confirmedView?: AccountView,
): Promise<void> {
	const { view, busy } = flow;
	if (
		flow.refs.current.starting ||
		flow.pendingOperation ||
		!canBeginLink(view, busy, intent, confirmedView)
	)
		return;
	const target = startTarget(view, intent);
	if (!target) return;
	flow.refs.current.starting = true;
	const epoch = flow.refs.current.generation;
	let opened: Window | null = null;
	flow.setBusy(true);
	flow.setMessage(
		intent === "disconnect" ? "Unlinking Google account…" : "Starting Google sign-in…",
	);
	try {
		// Reserve the popup in the click gesture; never navigate the Viewer itself.
		opened = reservePopup(intent);
		flow.refs.current.popup = opened;
		const result = await startAccountLink(
			view.selectedGroupId,
			target.contextId,
			{
				authority: target.authority,
				coordinatorId: target.coordinatorId,
				intent,
				...(intent === "disconnect" ? { expectedLinkId: view.unlinkTarget } : {}),
			},
			flow.refs.current.controller?.signal,
		);
		if (epoch !== flow.refs.current.generation) {
			opened?.close();
			return;
		}
		if (
			result.operation.contextId !== target.contextId ||
			!sameOperationContext(result.operation, view, intent)
		) {
			opened?.close();
			void refresh(flow);
			return;
		}
		flow.setOperation(result.operation);
		flow.setMessage(WAITING_MESSAGES[intent]);
	} catch (error) {
		opened?.close();
		await startFailure(flow, error, epoch, view);
	} finally {
		if (epoch === flow.refs.current.generation) {
			flow.refs.current.starting = false;
			flow.setBusy(false);
		}
	}
}

function deliverBrowserUrl(
	flow: Flow,
	operation: AccountOperation,
	view: AccountView,
	epoch: number,
	signal: AbortSignal,
): void {
	void getAccountBrowserUrl(operation.operationId, signal)
		.then(({ url }) => {
			if (signal.aborted || epoch !== flow.refs.current.generation) return;
			if (!validAccountBrowserUrl(url, view.coordinator?.origin ?? "", operation.intent)) {
				closeReservedPopup(flow);
				flow.setMessage(
					`Google sign-in could not be opened. Cancel ${accountOperationCopy(operation).activity}, or wait for status to update.`,
				);
				return;
			}
			const target = flow.refs.current.popup;
			flow.refs.current.popup = null;
			if (target && !target.closed) {
				target.location.replace(url);
				flow.refs.current.authWindow = {
					window: target,
					operationId: operation.operationId,
					contextId: operation.contextId,
					groupId: operation.groupId,
					intent: operation.intent ?? "connect",
					succeeded: false,
				};
				return;
			}
			flow.refs.current.privateUrl = url;
			flow.setFallback(true);
			flow.setMessage("Select Open Google sign-in to continue in a new tab on this computer.");
		})
		.catch(() => {
			if (signal.aborted || epoch !== flow.refs.current.generation) return;
			closeReservedPopup(flow);
			flow.setMessage(
				`Google sign-in could not be opened. Cancel ${accountOperationCopy(operation).activity}, or wait for status to update.`,
			);
		});
}

function useBrowserDelivery(flow: Flow): void {
	const { operation, view } = flow;
	useLayoutEffect(() => {
		if (
			operation?.intent === "disconnect" ||
			operation?.state !== "awaiting_browser" ||
			!operation.browserUrlAvailable ||
			!view?.coordinator ||
			flow.refs.current.delivered === operation.operationId
		)
			return;
		// Displaying an original-context operation must not deliver its browser handoff here.
		if (!ownsOperation(operation, view) || !sameOperationContext(operation, view)) return;
		flow.refs.current.delivered = operation.operationId;
		const abort = new AbortController();
		deliverBrowserUrl(flow, operation, view, flow.refs.current.generation, abort.signal);
		return () => abort.abort();
	}, [operation?.operationId, operation?.state, operation?.browserUrlAvailable, view?.contextId]);
}

function openFallback(flow: Flow): void {
	const url = flow.refs.current.privateUrl;
	if (
		!url ||
		!flow.view?.coordinator ||
		!validAccountBrowserUrl(url, flow.view.coordinator.origin, flow.operation?.intent)
	)
		return;
	// Keep a close handle without exposing the Viewer through window.opener.
	const target = window.open("about:blank", "_blank");
	if (!target) return;
	target.opener = null;
	target.location.replace(url);
	flow.refs.current.privateUrl = null;
	flow.setFallback(false);
	if (flow.operation)
		flow.refs.current.authWindow = {
			window: target,
			operationId: flow.operation.operationId,
			contextId: flow.operation.contextId,
			groupId: flow.operation.groupId,
			intent: flow.operation.intent ?? "connect",
			succeeded: false,
		};
}

async function poll(
	flow: Flow,
	operation: AccountOperation,
	currentView: AccountView | null,
	epoch: number,
	signal: AbortSignal,
): Promise<void> {
	try {
		const result = await getAccountOperation(operation.operationId, signal);
		if (epoch !== flow.refs.current.generation) return;
		rememberAuthWindowSuccess(flow, result.operation);
		showPolledOperation(flow, result, currentView);
	} catch (error) {
		if (signal.aborted || epoch !== flow.refs.current.generation) return;
		reset(flow);
		flow.refs.current.delivered = operation.operationId;
		flow.setView(null);
		flow.setOperation(null);
		flow.setPendingOperation(operationMissing(error) ? null : { ...operation });
		flow.setMessage(unknownAccountOutcome(operation));
	}
}

function rememberAuthWindowSuccess(flow: Flow, operation?: AccountOperation | null): void {
	if (!operation) return;
	const target = flow.refs.current.authWindow;
	if (
		target?.operationId === operation.operationId &&
		target.contextId === operation.contextId &&
		target.groupId === operation.groupId &&
		target.intent === (operation.intent ?? "connect") &&
		operation.state === "succeeded"
	)
		target.succeeded = true;
}

function showPolledOperation(
	flow: Flow,
	result: { operation: AccountOperation; current: boolean },
	currentView: AccountView | null,
): void {
	const terminal = !active(result.operation);
	if (!currentView) {
		flow.setPendingOperation(terminal ? null : result.operation);
		if (terminal || result.current)
			void refresh(flow, { previousNotice: previousOutcomeNotice(result.operation) });
		return;
	}
	if (!result.current || !sameOperationContext(result.operation, currentView)) {
		flow.refs.current.delivered = result.operation.operationId;
		if (terminal) flow.setPendingOperation(null);
		void refresh(flow, {
			terminalOperationId: terminal ? result.operation.operationId : undefined,
			previousNotice: previousOutcomeNotice(result.operation),
		});
		return;
	}
	flow.setOperation(result.operation);
	if (!terminal) return;
	flow.setPendingOperation(null);
	// Fetch verified status, not the callback's claimed account data.
	void refresh(flow, {
		terminalOperationId: result.operation.operationId,
		notice:
			result.operation.state === "outcome_unknown" ? unknownAccountOutcome(result.operation) : "",
	});
}

function useOperationPolling(flow: Flow): void {
	const { operation, pendingOperation, view, busy } = flow;
	useEffect(() => {
		const candidate = operation ?? pendingOperation;
		if (!candidate || busy || !active(candidate)) return;
		if (operation && (!view || !sameOperationContext(operation, view))) return;
		// Past the server deadline, retain explicit cancellation/status actions, not endless retries.
		if (!operation && !(Date.parse(candidate.deadlineAt) > Date.now())) return;
		const epoch = flow.refs.current.generation;
		const abort = new AbortController();
		const timer = window.setTimeout(
			() => void poll(flow, candidate, operation ? view : null, epoch, abort.signal),
			1000,
		);
		return () => {
			window.clearTimeout(timer);
			abort.abort();
		};
	}, [operation, pendingOperation, view?.contextId, busy]);
}

function showCancellation(flow: Flow, result: AccountOperation): void {
	if (!flow.view || !sameOperationContext(result, flow.view)) {
		if (!active(result)) flow.setPendingOperation(null);
		void refresh(flow, {
			terminalOperationId: !active(result) ? result.operationId : undefined,
			previousNotice: previousOutcomeNotice(result),
		});
		return;
	}
	flow.setOperation(result);
	flow.setMessage("Cancellation is pending. Check status to confirm.");
	if (!active(result))
		void refresh(flow, {
			terminalOperationId: result.operationId,
			notice: result.state === "outcome_unknown" ? unknownAccountOutcome(result) : "",
		});
}

async function cancel(
	flow: Flow,
	options: { operation: AccountOperation | null; previous: boolean },
): Promise<void> {
	const { operation, previous } = options;
	if (flow.refs.current.cancelling || !operation || flow.busy || !active(operation)) return;
	reset(flow);
	flow.refs.current.cancelling = true;
	// A pending cancellation must not start a fresh browser delivery for this operation.
	flow.refs.current.delivered = operation.operationId;
	const abort = new AbortController();
	flow.refs.current.controller = abort;
	const epoch = flow.refs.current.generation;
	flow.setBusy(true);
	flow.setMessage("Requesting cancellation…");
	try {
		const result = await cancelAccountLink(operation.operationId, abort.signal);
		if (epoch !== flow.refs.current.generation) return;
		rememberAuthWindowSuccess(flow, result.operation);
		if (previous) {
			flow.setPendingOperation(active(result.operation) ? result.operation : null);
			flow.setMessage("Cancellation is pending. Check status to confirm.");
			if (!active(result.operation))
				void refresh(flow, { previousNotice: previousOutcomeNotice(result.operation) });
		} else showCancellation(flow, result.operation);
	} catch (error) {
		if (epoch === flow.refs.current.generation)
			showCancellationFailure(flow, operation, error, { previous });
	} finally {
		if (epoch === flow.refs.current.generation) {
			flow.refs.current.cancelling = false;
			flow.setBusy(false);
		}
	}
}

function showCancellationFailure(
	flow: Flow,
	operation: AccountOperation,
	error: unknown,
	options: { previous: boolean },
): void {
	if (operationMissing(error)) {
		flow.setPendingOperation(null);
		void refresh(flow, {
			excludeOperationId: operation.operationId,
			terminalOperationId: operation.operationId,
		});
		return;
	}
	// Restart polling in this generation without requesting another browser URL.
	if (options.previous) flow.setPendingOperation({ ...operation });
	else flow.setOperation({ ...operation });
	flow.setMessage(
		`Cancellation could not be confirmed. ${accountOperationCopy(operation).subject} may still finish; you can try cancellation again.`,
	);
}

export function useMyAccount(onViewChange?: (view: AccountView | null) => void) {
	const flow = useFlowState(onViewChange);
	useStatusEffect(flow);
	useBrowserDelivery(flow);
	useOperationPolling(flow);
	const select = (groupId: string | undefined) => selectGroup(flow, groupId);
	return {
		group: flow.group,
		selectGroup: select,
		setGroup: select,
		view: flow.view,
		operation: flow.operation,
		pendingOperation: flow.pendingOperation,
		message: flow.message,
		busy: flow.busy,
		fallback: flow.fallback,
		refresh: (options?: { groupId?: string; notice?: string }) =>
			refresh(flow, { ...options, checkExpiredPending: true }),
		link: () => link(flow),
		signIn: () => link(flow, "sign_in"),
		change: (intent: "refresh" | "disconnect", confirmedView?: AccountView) =>
			link(flow, intent, confirmedView),
		openFallback: () => openFallback(flow),
		cancel: () => cancel(flow, { operation: flow.operation, previous: false }),
		cancelPrevious: () => cancel(flow, { operation: flow.pendingOperation, previous: true }),
	};
}
