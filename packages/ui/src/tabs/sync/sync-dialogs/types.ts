/* Request/result shapes for the sync dialog queue. Each request is
 * tagged by `kind` so the host can pick the right body renderer, and
 * SyncDialogResult is the union of all possible resolver payloads
 * (boolean for confirm, string|null for input, union for duplicate
 * person flow). */

export type DialogTone = "default" | "danger";

export type ConfirmDialogRequest = {
	kind: "confirm";
	autoFocusAction?: "cancel" | "confirm";
	cancelLabel?: string;
	confirmLabel?: string;
	description: string;
	tone?: DialogTone;
	title: string;
};

export type InputDialogRequest = {
	kind: "input";
	cancelLabel?: string;
	confirmLabel?: string;
	description: string;
	initialValue?: string;
	placeholder?: string;
	title: string;
	validate?: (value: string) => string | null;
};

export type DuplicatePersonActorOption = {
	actorId: string;
	isLocal?: boolean;
	label: string;
};

export type DuplicatePersonDialogResult =
	| { action: "cancel" }
	| { action: "different-people" }
	| { action: "merge"; primaryActorId: string; secondaryActorId: string };

export type DuplicatePersonDialogRequest = {
	actors: DuplicatePersonActorOption[];
	kind: "duplicate-person";
	summary: string;
	title: string;
};

export type SyncDialogRequest =
	| ConfirmDialogRequest
	| InputDialogRequest
	| DuplicatePersonDialogRequest;

export type SyncDialogResult = boolean | string | null | DuplicatePersonDialogResult;
