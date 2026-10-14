import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
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

function errorText(error: unknown): string {
	if (error instanceof AccountRequestError) {
		if (error.status === 404) return "Account linking is not available in this Viewer.";
		if (error.code === "account_local_viewer_required")
			return "Start the Viewer on localhost and open it in a browser on the same computer. Remote or SSH-forwarded viewing cannot link an account.";
		if (error.code === "account_context_changed")
			return "The local account context changed. Check status before trying again.";
		if (error.code === "account_link_not_allowed")
			return "Linking is not available for this Identity. Check status.";
		if (error.status === 503)
			return "Account status is unavailable right now. Check status again later.";
	}
	return "We couldn’t confirm the account status. Check status again.";
}

function canBeginLink(
	view: AccountView | null,
	busy: boolean,
): view is AccountView & { contextId: string; selectedGroupId: string } {
	return Boolean(view?.canLink && view.contextId && view.selectedGroupId && !busy);
}
function sameOperationContext(operation: AccountOperation, view: AccountView): boolean {
	return operation.contextId === view.contextId && operation.groupId === view.selectedGroupId;
}
function isInProgress(error: unknown): boolean {
	return error instanceof AccountRequestError && error.code === "account_link_in_progress";
}

function useFlowState() {
	const [group, setGroup] = useState<string | undefined>(undefined);
	const [view, setView] = useState<AccountView | null>(null);
	const [operation, setOperation] = useState<AccountOperation | null>(null);
	const [message, setMessage] = useState("Checking account status…");
	const [busy, setBusy] = useState(false);
	const [fallback, setFallback] = useState(false);
	const refs = useRef({
		privateUrl: null as string | null,
		popup: null as Window | null,
		delivered: null as string | null,
		generation: 0,
		controller: null as AbortController | null,
	});
	return {
		group,
		setGroup,
		view,
		setView,
		operation,
		setOperation,
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
	flow.refs.current.controller?.abort();
	flow.refs.current.controller = null;
	flow.refs.current.privateUrl = null;
	closeReservedPopup(flow);
	flow.refs.current.delivered = null;
	flow.setFallback(false);
}

function showStatus(
	flow: Flow,
	result: AccountView,
	options: { notice?: string; excludeOperationId?: string },
): void {
	const verifiedLinked =
		result.remote.kind === "status" &&
		result.remote.state === "linked" &&
		result.remote.identityMatches;
	flow.setView(result);
	flow.setOperation(
		!verifiedLinked &&
			result.operation &&
			sameOperationContext(result.operation, result) &&
			result.operation.operationId !== options.excludeOperationId
			? result.operation
			: null,
	);
	flow.setMessage(verifiedLinked ? "" : (options.notice ?? ""));
}

async function refresh(
	flow: Flow,
	options: { groupId?: string; notice?: string; excludeOperationId?: string } = {},
): Promise<void> {
	reset(flow);
	const epoch = flow.refs.current.generation;
	const abort = new AbortController();
	flow.refs.current.controller = abort;
	flow.setBusy(true);
	flow.setView(null);
	flow.setOperation(null);
	flow.setMessage("Checking account status…");
	try {
		const result = await getAccountStatus(options.groupId ?? flow.group, abort.signal);
		if (epoch !== flow.refs.current.generation) return;
		showStatus(flow, result, options);
	} catch (error) {
		if (epoch === flow.refs.current.generation) flow.setMessage(errorText(error));
	} finally {
		if (epoch === flow.refs.current.generation) flow.setBusy(false);
	}
}

function useStatusEffect(flow: Flow): void {
	useEffect(() => {
		void refresh(flow, { groupId: flow.group });
		return () => reset(flow);
	}, [flow.group]);
}

function selectGroup(flow: Flow, groupId: string | undefined): void {
	reset(flow);
	flow.setView(null);
	flow.setOperation(null);
	flow.setGroup(groupId);
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
		if (
			epoch !== flow.refs.current.generation ||
			!current ||
			!sameOperationContext(candidate, currentView)
		)
			return false;
		flow.setOperation(candidate);
		flow.setMessage("Linking is already in progress for this Identity.");
		return true;
	} catch {
		return false;
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
		excludeOperationId:
			isInProgress(error) && error instanceof AccountRequestError ? error.operationId : undefined,
		notice: isInProgress(error)
			? "Another account link is in progress. Check status."
			: errorText(error),
	});
}

async function link(flow: Flow): Promise<void> {
	const { view, busy } = flow;
	if (!canBeginLink(view, busy)) return;
	// Reserve the popup in the click gesture; never navigate the Viewer itself.
	const opened = window.open("about:blank", "_blank");
	if (opened) opened.opener = null;
	flow.refs.current.popup = opened;
	const epoch = flow.refs.current.generation;
	flow.setBusy(true);
	flow.setMessage("Starting Google sign-in…");
	try {
		const result = await startAccountLink(
			view.selectedGroupId,
			view.contextId,
			flow.refs.current.controller?.signal,
		);
		if (epoch !== flow.refs.current.generation) {
			opened?.close();
			return;
		}
		if (!sameOperationContext(result.operation, view)) {
			opened?.close();
			void refresh(flow);
			return;
		}
		flow.setOperation(result.operation);
		flow.setMessage(
			"Waiting for Google sign-in. This links your account to this Identity; it does not grant sharing access.",
		);
	} catch (error) {
		opened?.close();
		await startFailure(flow, error, epoch, view);
	} finally {
		if (epoch === flow.refs.current.generation) flow.setBusy(false);
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
			if (!validAccountBrowserUrl(url, view.coordinator?.origin ?? "")) {
				closeReservedPopup(flow);
				flow.setMessage("Google sign-in could not be opened. Check status.");
				return;
			}
			const target = flow.refs.current.popup;
			flow.refs.current.popup = null;
			if (target && !target.closed) {
				target.location.replace(url);
				return;
			}
			flow.refs.current.privateUrl = url;
			flow.setFallback(true);
			flow.setMessage("Select Open Google sign-in to continue in a new tab on this computer.");
		})
		.catch(() => {
			if (signal.aborted || epoch !== flow.refs.current.generation) return;
			closeReservedPopup(flow);
			flow.setMessage("Google sign-in could not be opened. Check status.");
		});
}

function useBrowserDelivery(flow: Flow): void {
	const { operation, view } = flow;
	useLayoutEffect(() => {
		if (
			operation?.state !== "awaiting_browser" ||
			!operation.browserUrlAvailable ||
			!view?.coordinator ||
			flow.refs.current.delivered === operation.operationId
		)
			return;
		if (!sameOperationContext(operation, view)) return;
		flow.refs.current.delivered = operation.operationId;
		const abort = new AbortController();
		deliverBrowserUrl(flow, operation, view, flow.refs.current.generation, abort.signal);
		return () => abort.abort();
	}, [operation?.operationId, operation?.state, operation?.browserUrlAvailable, view?.contextId]);
}

function openFallback(flow: Flow): void {
	const url = flow.refs.current.privateUrl;
	flow.refs.current.privateUrl = null;
	flow.setFallback(false);
	if (!url || !flow.view?.coordinator || !validAccountBrowserUrl(url, flow.view.coordinator.origin))
		return;
	// With noopener browsers may return null even after opening the new tab.
	window.open(url, "_blank", "noopener,noreferrer");
}

async function poll(
	flow: Flow,
	operationId: string,
	currentView: AccountView,
	epoch: number,
	signal: AbortSignal,
): Promise<void> {
	try {
		const result = await getAccountOperation(operationId, signal);
		if (epoch !== flow.refs.current.generation) return;
		if (!result.current || !sameOperationContext(result.operation, currentView)) {
			void refresh(flow);
			return;
		}
		flow.setOperation(result.operation);
		if (!active(result.operation)) {
			flow.refs.current.privateUrl = null;
			flow.setFallback(false);
			// Fetch verified status, not the callback's claimed account data.
			void refresh(flow, {
				notice:
					result.operation.state === "outcome_unknown"
						? "We couldn’t confirm whether linking finished. Check status."
						: "",
			});
		}
	} catch {
		if (signal.aborted) return;
		if (epoch === flow.refs.current.generation) {
			reset(flow);
			flow.setView(null);
			flow.setOperation(null);
			flow.setMessage("We couldn’t confirm whether linking finished. Check status.");
		}
	}
}

function useOperationPolling(flow: Flow): void {
	const { operation, view } = flow;
	useEffect(() => {
		if (!operation || !view || !active(operation) || !sameOperationContext(operation, view)) return;
		const epoch = flow.refs.current.generation;
		const abort = new AbortController();
		const timer = window.setTimeout(
			() => void poll(flow, operation.operationId, view, epoch, abort.signal),
			1000,
		);
		return () => {
			window.clearTimeout(timer);
			abort.abort();
		};
	}, [operation, view?.contextId]);
}

function showCancellation(flow: Flow, result: AccountOperation): void {
	if (!flow.view || !sameOperationContext(result, flow.view)) {
		void refresh(flow);
		return;
	}
	flow.setOperation(result);
	flow.setMessage("Cancellation is pending. Check status to confirm.");
	if (!active(result))
		void refresh(flow, {
			notice:
				result.state === "outcome_unknown"
					? "We couldn’t confirm whether linking finished. Check status."
					: "",
		});
}

async function cancel(flow: Flow): Promise<void> {
	const { operation, busy } = flow;
	if (!operation || busy || !active(operation)) return;
	reset(flow);
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
		showCancellation(flow, result.operation);
	} catch {
		if (epoch === flow.refs.current.generation)
			flow.setMessage(
				"Cancellation could not be confirmed. Check status; linking may still finish.",
			);
	} finally {
		if (epoch === flow.refs.current.generation) flow.setBusy(false);
	}
}

export function useMyAccount() {
	const flow = useFlowState();
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
		message: flow.message,
		busy: flow.busy,
		fallback: flow.fallback,
		refresh: (options?: { groupId?: string; notice?: string }) => refresh(flow, options),
		link: () => link(flow),
		openFallback: () => openFallback(flow),
		cancel: () => cancel(flow),
	};
}
