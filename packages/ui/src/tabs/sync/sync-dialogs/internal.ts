/* Internal state + helpers for the sync dialog queue. A single
 * in-flight request at a time; consumers resolve the dialog by
 * calling resolveCurrentDialog, and the host component re-renders
 * whenever setHostRequest is wired up. Kept here so the public API
 * file and the body components can both reach the same module
 * singleton without import cycles. */

import type { DialogTone, SyncDialogRequest, SyncDialogResult } from "./types";

let currentRequest: SyncDialogRequest | null = null;
let resolveDialog: ((value: SyncDialogResult) => void) | null = null;
let setHostRequest: ((request: SyncDialogRequest | null) => void) | null = null;

export function getCurrentRequest(): SyncDialogRequest | null {
	return currentRequest;
}

export function setResolveDialog(fn: ((value: SyncDialogResult) => void) | null) {
	resolveDialog = fn;
}

export function setHostRequestSetter(fn: ((request: SyncDialogRequest | null) => void) | null) {
	setHostRequest = fn;
}

export function isHostRequestSetter(
	fn: ((request: SyncDialogRequest | null) => void) | null,
): boolean {
	return setHostRequest === fn;
}

export function fallbackResult(request: SyncDialogRequest | null): SyncDialogResult {
	if (!request) return null;
	if (request.kind === "confirm") return false;
	if (request.kind === "input") return null;
	return { action: "cancel" };
}

export function ensureDialogAvailable(requestKind: SyncDialogRequest["kind"]): boolean {
	if (!currentRequest || !resolveDialog) return true;
	console.warn(
		`Ignored sync ${requestKind} dialog request because another sync dialog is already open.`,
	);
	return false;
}

export function setRequest(nextRequest: SyncDialogRequest | null) {
	currentRequest = nextRequest;
	setHostRequest?.(nextRequest);
}

export function resolveCurrentDialog(value: SyncDialogResult) {
	const resolver = resolveDialog;
	resolveDialog = null;
	setRequest(null);
	resolver?.(value);
}

export function dialogToneClassName(tone: DialogTone | undefined) {
	return tone === "danger" ? "sync-dialog-confirm danger" : "sync-dialog-confirm";
}
