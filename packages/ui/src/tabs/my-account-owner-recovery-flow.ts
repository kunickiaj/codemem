import { useEffect, useRef, useState } from "preact/hooks";
import {
	AccountRequestError,
	type AccountView,
	confirmOwnerRecovery,
	getOwnerRecoveryProfile,
	importOwnerRecoveryReply,
	previewOwnerRecovery,
} from "../lib/api/account";
import type { RecoveryProfileEnvelope } from "../lib/api/owner-recovery-validation";
import {
	matchesRecoveryPreview,
	type RecoveryPreview,
	type RecoveryPreviewRequest,
	type RecoveryResult,
	type RecoverySelection,
	recoveryProfileKey,
	sameGroups,
} from "./account-owner-recovery-types";

function accountProfileKey(view: AccountView): string {
	return JSON.stringify([
		view.local?.identityId,
		view.local?.deviceId,
		view.local?.fingerprint,
		view.coordinator?.origin,
		view.selectedGroupId,
		[...view.groups].sort(),
	]);
}

function recoveryError(error: unknown): string {
	if (
		error instanceof AccountRequestError &&
		error.code === "account_owner_recovery_context_changed"
	)
		return "The profile changed. Close this review and check status before reviewing again.";
	if (error instanceof AccountRequestError && error.code === "account_owner_recovery_busy")
		return "Another account operation is running, possibly in another tab. Codemem runs one at a time. Wait for it to finish, then check status.";
	if (
		error instanceof AccountRequestError &&
		error.code === "account_owner_recovery_storage_unsafe"
	)
		return `Codemem can't save the account owner on this device. ${error.detail ?? "Check that only you can write to ~/.codemem and ~/.codemem/account-owner-associations, then try again."}`;
	return "The coordinator didn't answer, or sent a response this Viewer can't read. Try the preview again. If it keeps failing, ask the coordinator operator to check the coordinator, and keep this profile as it is.";
}

function unknownResult(preview: RecoveryPreview): RecoveryResult {
	return {
		preview,
		groups: preview.groups.map((groupId) => ({
			groupId,
			status: "unknown",
			message: "The approval may already have been sent. Check review status before trying again.",
		})),
	};
}

/** A display-only target for a lost import response, never a consent preview. */
function importStatusTarget(selection: RecoverySelection): RecoveryPreview {
	return {
		...selection,
		requestId: crypto.randomUUID(),
		scope: "historical_included_owner_labels_only",
		approvalDigest: "",
		history: {
			complete: false,
			rows: [],
			operatorHelp: "Check the original operator reply with the coordinator operator.",
		},
		reviewedWeakLabels: [],
		groupPreviews: selection.groups.map((groupId) => ({
			groupId,
			action: "blocked",
			reason: "Reply verification outcome unknown.",
		})),
	};
}

function useRecoveryState() {
	const [open, setOpen] = useState(false);
	const [envelope, setEnvelope] = useState<RecoveryProfileEnvelope | null>(null);
	const [preview, setPreview] = useState<RecoveryPreview | null>(null);
	const [result, setResult] = useState<RecoveryResult | null>(null);
	const [submittedPreview, setSubmittedPreview] = useState<RecoveryPreview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const refs = useRef({
		generation: 0,
		controller: null as AbortController | null,
		pending: false,
		open: false,
		profileKey: "",
		displayContext: null as string | null,
		envelope: null as RecoveryProfileEnvelope | null,
		latestKey: "",
		selectedGroup: undefined as string | undefined,
	});
	return {
		open,
		setOpen,
		envelope,
		setEnvelope,
		preview,
		setPreview,
		result,
		submittedPreview,
		setSubmittedPreview,
		setResult,
		busy,
		setBusy,
		error,
		setError,
		refs,
	};
}
type RecoveryFlow = ReturnType<typeof useRecoveryState>;

function invalidate(flow: RecoveryFlow): void {
	flow.refs.current.generation++;
	flow.refs.current.controller?.abort();
	flow.refs.current.pending = false;
	flow.setBusy(false);
	flow.setPreview(null);
	flow.setError(null);
}

function close(flow: RecoveryFlow): void {
	flow.refs.current.open = false;
	invalidate(flow);
	flow.setOpen(false);
}

function currentRequest(flow: RecoveryFlow, epoch: number, key: string): boolean {
	return (
		flow.refs.current.open &&
		epoch === flow.refs.current.generation &&
		key === flow.refs.current.latestKey
	);
}

async function run<T>(
	flow: RecoveryFlow,
	work: (signal: AbortSignal) => Promise<T>,
	accept: (value: T) => void,
): Promise<void> {
	if (!flow.refs.current.open || flow.refs.current.pending) return;
	const epoch = ++flow.refs.current.generation;
	const key = flow.refs.current.latestKey;
	const controller = new AbortController();
	flow.refs.current.controller?.abort();
	flow.refs.current.controller = controller;
	flow.refs.current.pending = true;
	flow.setBusy(true);
	flow.setError(null);
	try {
		const value = await work(controller.signal);
		if (currentRequest(flow, epoch, key)) accept(value);
	} catch (failure) {
		if (currentRequest(flow, epoch, key)) flow.setError(recoveryError(failure));
	} finally {
		if (epoch === flow.refs.current.generation) {
			flow.refs.current.pending = false;
			flow.setBusy(false);
		}
	}
}

function loadProfile(flow: RecoveryFlow): void {
	invalidate(flow);
	void run(flow, getOwnerRecoveryProfile, (next) => {
		const previous = flow.refs.current.envelope;
		if (previous && recoveryProfileKey(previous.profile) !== recoveryProfileKey(next.profile)) {
			flow.setResult(null);
			flow.setSubmittedPreview(null);
		}
		flow.refs.current.envelope = next;
		flow.setEnvelope(next);
	});
}

function clearProfile(flow: RecoveryFlow): void {
	close(flow);
	flow.setResult(null);
	flow.setSubmittedPreview(null);
	flow.setEnvelope(null);
	flow.refs.current.envelope = null;
}

function useProfileLifetime(flow: RecoveryFlow, view: AccountView | null, selectedGroup?: string) {
	const { refs } = flow;
	const currentKey = view ? accountProfileKey(view) : refs.current.profileKey;
	refs.current.latestKey = JSON.stringify([currentKey, selectedGroup]);
	useEffect(() => {
		const groupChanged = refs.current.selectedGroup !== selectedGroup;
		refs.current.selectedGroup = selectedGroup;
		if (groupChanged) clearProfile(flow);
		if (!view) return;
		const changed = refs.current.profileKey && refs.current.profileKey !== currentKey;
		const displayChanged = refs.current.displayContext !== view.contextId;
		refs.current.profileKey = currentKey;
		refs.current.displayContext = view.contextId;
		if (changed) {
			clearProfile(flow);
		} else if (displayChanged && refs.current.open) {
			// Association display hashes can change without changing the underlying profile.
			// Only a fresh server semantic context decides whether submitted results survive.
			loadProfile(flow);
		}
	}, [currentKey, view?.contextId, selectedGroup]);
	useEffect(
		() => () => {
			refs.current.open = false;
			refs.current.generation++;
			refs.current.controller?.abort();
		},
		[],
	);

	return currentKey;
}

function previewRecovery(flow: RecoveryFlow, request: RecoveryPreviewRequest): void {
	if (flow.refs.current.pending || !flow.refs.current.envelope) return;
	flow.setPreview(null);
	void run(
		flow,
		(signal) => previewOwnerRecovery(request, signal),
		(next) => {
			if (!matchesRecoveryPreview(next, request, request.requestId)) {
				flow.setError(
					"The ownership preview is not current. Request a new preview before approving.",
				);
				return;
			}
			// A new review reads the coordinator's current state, which replaces an earlier
			// result. Status checks, and failed previews, keep the earlier submission.
			if (request.purpose === "review") {
				flow.setResult(null);
				flow.setSubmittedPreview(null);
			}
			flow.setPreview(next);
		},
	);
}

function confirmRecovery(
	flow: RecoveryFlow,
	args: { preview: RecoveryPreview; approvalDigest: string },
	acceptResult: (next: RecoveryResult) => void,
): void {
	const { preview, result, refs } = flow;
	if (
		refs.current.pending ||
		args.preview !== preview ||
		args.approvalDigest !== preview?.approvalDigest ||
		result?.preview === preview
	)
		return;
	flow.setResult(unknownResult(args.preview));
	flow.setSubmittedPreview(args.preview);
	void run(
		flow,
		(signal) => confirmOwnerRecovery(args, signal),
		(next) => {
			if (JSON.stringify(next.preview) !== JSON.stringify(args.preview)) {
				flow.setError(
					"The confirmation response did not match the submitted review. Check review status.",
				);
				return;
			}
			acceptResult(next);
		},
	);
}

function importRecovery(
	flow: RecoveryFlow,
	args: { selection: RecoverySelection; replyText: string },
	acceptResult: (next: RecoveryResult) => void,
): void {
	if (flow.refs.current.pending || !flow.refs.current.envelope) return;
	const target = importStatusTarget(args.selection);
	flow.setResult(unknownResult(target));
	flow.setSubmittedPreview(target);
	void run(
		flow,
		(signal) => importOwnerRecoveryReply(args, signal),
		(next) => {
			if (
				recoveryProfileKey(next.preview.profile) !== recoveryProfileKey(args.selection.profile) ||
				next.preview.existingOwnerId !== args.selection.existingOwnerId ||
				!sameGroups(next.preview.groups, args.selection.groups)
			) {
				flow.setError(
					"The reply verification response did not match the submitted target. Check review status.",
				);
				return;
			}
			acceptResult(next);
		},
	);
}

export function useOwnerRecovery(
	view: AccountView | null,
	refresh: () => Promise<void>,
	selectedGroup?: string,
) {
	const flow = useRecoveryState();
	useProfileLifetime(flow, view, selectedGroup);
	const acceptResult = (next: RecoveryResult) => {
		flow.setResult(next);
		// Fetch actual verified status, never pasted owner metadata.
		if (next.groups.some((group) => group.status === "confirmed")) void refresh();
	};
	return {
		open: flow.open,
		envelope: flow.envelope,
		preview: flow.preview,
		result: flow.result,
		submittedPreview: flow.submittedPreview,
		busy: flow.busy,
		error: flow.error,
		close: () => close(flow),
		show: () => {
			if (flow.refs.current.open) return;
			flow.refs.current.open = true;
			flow.setOpen(true);
			flow.setEnvelope(null);
			loadProfile(flow);
		},
		invalidate: () => invalidate(flow),
		onPreview: (request: RecoveryPreviewRequest) => previewRecovery(flow, request),
		onConfirm: (args: { preview: RecoveryPreview; approvalDigest: string }) =>
			confirmRecovery(flow, args, acceptResult),
		onImportReply: (args: { selection: RecoverySelection; replyText: string }) =>
			importRecovery(flow, args, acceptResult),
	};
}
