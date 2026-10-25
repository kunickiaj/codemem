import { useRef } from "preact/hooks";
import { RadixDialog, RadixDialogTitle } from "../components/primitives/radix-dialog";
import type { AccountView } from "../lib/api/account";
import { AccountOwnerRecovery } from "./account-owner-recovery";
import { useOwnerRecovery } from "./my-account-owner-recovery-flow";

function needsRecovery(view: AccountView | null): boolean {
	if (!view?.local || view.setup !== "ready") return false;
	if (["review_required", "conflict", "identity_mismatch"].includes(view.blockedReason ?? ""))
		return true;
	if (view.remote.kind === "unavailable")
		return view.remote.code === "account_owner_association_invalid";
	return (
		view.remote.kind === "status" &&
		(view.remote.state === "review_required" ||
			view.remote.state === "conflict" ||
			!view.remote.identityMatches)
	);
}

export function MyAccountOwnerRecovery({
	view,
	refresh,
	selectedGroup,
}: {
	view: AccountView | null;
	refresh: () => Promise<void>;
	selectedGroup?: string;
}) {
	const flow = useOwnerRecovery(view, refresh, selectedGroup);
	const trigger = useRef<HTMLButtonElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	const loading = flow.open && !flow.envelope;
	return (
		<>
			{needsRecovery(view) || flow.open || flow.result ? (
				<button ref={trigger} type="button" className="settings-button" onClick={flow.show}>
					Review account ownership
				</button>
			) : null}
			<RadixDialog
				open={loading}
				onOpenChange={(open) => {
					if (!open) flow.close();
				}}
				contentId="owner-recovery-loading"
				overlayId="owner-recovery-loading-overlay"
				contentClassName="modal"
				overlayClassName="modal-backdrop"
				ariaLabelledby="owner-recovery-loading-title"
				ariaDescribedby="owner-recovery-loading-description"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					cancel.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (!flow.open && trigger.current?.isConnected) trigger.current.focus();
				}}
			>
				<div className="modal-card" aria-busy={flow.busy}>
					<div className="modal-header">
						<RadixDialogTitle id="owner-recovery-loading-title">
							Review account ownership
						</RadixDialogTitle>
					</div>
					<div className="modal-body">
						<p id="owner-recovery-loading-description" role="status">
							Checking the current server recovery profile…
						</p>
						{flow.error ? <p role="alert">{flow.error}</p> : null}
					</div>
					<div className="modal-footer">
						<button ref={cancel} type="button" className="settings-button" onClick={flow.close}>
							Cancel
						</button>
					</div>
				</div>
			</RadixDialog>
			{flow.envelope ? (
				<AccountOwnerRecovery
					open={flow.open}
					profile={flow.envelope.profile}
					candidates={flow.envelope.candidates}
					reviewAccess={flow.envelope.reviewAccess}
					preview={flow.preview}
					result={flow.result}
					submittedPreview={flow.submittedPreview}
					busy={flow.busy}
					error={flow.error}
					returnFocus={trigger}
					onClose={flow.close}
					onPreview={flow.onPreview}
					onConfirm={flow.onConfirm}
					onSelectionChange={flow.invalidate}
					onCopyRequest={async ({ text }) => {
						await navigator.clipboard.writeText(text);
					}}
					onImportReply={flow.onImportReply}
				/>
			) : null}
		</>
	);
}
