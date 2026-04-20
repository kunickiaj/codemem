/* Sync dialog queue — public entrypoints for the Sync and
 * coordinator-admin flows to open a single in-flight confirm, input,
 * or duplicate-person dialog. Implementation lives under
 * sync-dialogs/ (types, internal state, and the three render
 * components). */

import { render } from "preact";
import { SyncDialogHost } from "./sync-dialogs/components/sync-dialog-host";
import {
	ensureDialogAvailable,
	fallbackResult,
	setRequest,
	setResolveDialog,
} from "./sync-dialogs/internal";
import type {
	ConfirmDialogRequest,
	DuplicatePersonDialogRequest,
	DuplicatePersonDialogResult,
	InputDialogRequest,
} from "./sync-dialogs/types";

export type { DuplicatePersonActorOption } from "./sync-dialogs/types";

let dialogMount: HTMLElement | null = null;

export function ensureSyncDialogHost() {
	if (dialogMount?.isConnected) return;
	dialogMount = document.getElementById("syncDialogMount") as HTMLElement | null;
	if (!dialogMount) {
		dialogMount = document.createElement("div");
		dialogMount.id = "syncDialogMount";
		document.body.appendChild(dialogMount);
	}
	render(<SyncDialogHost />, dialogMount);
}

export function openSyncConfirmDialog(
	request: Omit<ConfirmDialogRequest, "kind">,
): Promise<boolean> {
	ensureSyncDialogHost();
	if (!ensureDialogAvailable("confirm")) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		setResolveDialog((value) => resolve(Boolean(value)));
		setRequest({ kind: "confirm", ...request });
	});
}

export function openSyncInputDialog(
	request: Omit<InputDialogRequest, "kind">,
): Promise<string | null> {
	ensureSyncDialogHost();
	if (!ensureDialogAvailable("input")) return Promise.resolve(null);
	return new Promise<string | null>((resolve) => {
		setResolveDialog((value) => resolve(typeof value === "string" ? value : null));
		setRequest({ kind: "input", ...request });
	});
}

export function openDuplicatePersonDialog(
	request: Omit<DuplicatePersonDialogRequest, "kind">,
): Promise<DuplicatePersonDialogResult> {
	ensureSyncDialogHost();
	if (!ensureDialogAvailable("duplicate-person")) {
		return Promise.resolve(
			fallbackResult({ kind: "duplicate-person", ...request }) as DuplicatePersonDialogResult,
		);
	}
	return new Promise<DuplicatePersonDialogResult>((resolve) => {
		setResolveDialog((value) =>
			resolve((value as DuplicatePersonDialogResult) || { action: "cancel" }),
		);
		setRequest({ kind: "duplicate-person", ...request });
	});
}
