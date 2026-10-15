import type { AccountOperation, AccountView } from "../lib/api/account";
import { useMyAccount } from "./my-account-flow";

const FAILURE_MESSAGES: Partial<Record<NonNullable<AccountOperation["failure"]>, string>> = {
	link_stopped: "Linking stopped. Check status before trying again.",
	link_conflict:
		"Account linking conflicts with an existing or revoked link. Ask the coordinator operator; this action cannot replace links or move Identities.",
};

function remoteSummary(view: AccountView): string {
	if (view.setup === "group_selection_required")
		return "Choose a group to check this Identity’s account status.";
	if (view.setup !== "ready")
		return "Account linking is not ready for this local Identity. Check the Viewer’s coordinator and device setup.";
	if (view.remote.kind === "unsupported")
		return "This coordinator does not support Google account linking.";
	if (view.remote.kind === "unavailable" || view.remote.kind === "not_checked")
		return "Account status could not be verified. Check status again; this does not mean the Identity is unlinked.";
	if (view.remote.state === "review_required")
		return `An operator must review this device before linking. Reuse the exact database, config, coordinator and environment settings (including the keys directory) used to start this Viewer. Example only, with those same selections: codemem coordinator review-device-owner ${view.selectedGroupId ?? "<group>"}. Review the preview before confirming. Confirmation defaults to No; linking does not grant sharing access.`;
	if (view.remote.state === "conflict")
		return "This Identity has a conflicting account link. An operator must resolve it; linking here cannot replace or merge accounts.";
	if (!view.remote.identityMatches)
		return "The coordinator Identity does not match this local Identity. Linking is unavailable.";
	if (view.remote.state === "revoked")
		return "This Identity’s account link was revoked. Linking here cannot restore or replace it.";
	if (view.remote.state === "linked")
		return "This Google account is linked to the local Codemem Identity. Linking does not change sharing access.";
	if (view.blockedReason === "operation_active")
		return "Another account link is running in this Viewer. Check status after it finishes.";
	return "No Google account is linked to this Identity. Linking will not move the Identity or grant sharing access.";
}

function accountSummary(view: AccountView | null, operation: AccountOperation | null): string {
	if (!view) return "Account status is unavailable. This does not mean the Identity is unlinked.";
	if (operation?.state === "starting") return "Preparing Google sign-in…";
	if (operation?.state === "awaiting_browser")
		return "Waiting for Google sign-in. Keep this Viewer open on the same computer.";
	if (operation?.state === "outcome_unknown")
		return "We couldn’t confirm whether linking finished. Check status.";
	if (operation?.state === "failed")
		return (
			FAILURE_MESSAGES[operation.failure ?? "request_failed"] ??
			"Linking did not finish. Check status before trying again."
		);
	if (operation?.state === "cancelled")
		return "Cancellation was reported. Check status to confirm the account state.";
	return remoteSummary(view);
}

function currentBlockGuidance(view: AccountView | null, operation: AccountOperation | null) {
	if (
		!view ||
		!operation ||
		!["failed", "cancelled", "outcome_unknown"].includes(operation.state) ||
		view.remote.kind !== "status"
	)
		return null;
	const { state, identityMatches } = view.remote;
	if (["review_required", "conflict", "revoked"].includes(state) || !identityMatches)
		return remoteSummary(view);
	return null;
}

function VerifiedAccount({ view }: { view: AccountView }) {
	if (
		view.remote.kind !== "status" ||
		view.remote.state !== "linked" ||
		!view.remote.identityMatches ||
		!view.remote.account
	)
		return null;
	const { displayName, email } = view.remote.account;
	return (
		<div className="recipient-policy-sharing-identity-rows">
			<strong>{displayName || email || "Google account linked"}</strong>
			{displayName && email ? <p className="small">{email}</p> : null}
		</div>
	);
}

function AccountActions({ flow }: { flow: ReturnType<typeof useMyAccount> }) {
	const { view, operation, busy, fallback } = flow;
	const running = operation?.state === "starting" || operation?.state === "awaiting_browser";
	return (
		<div className="peer-actions">
			{view && !running ? (
				<button
					className="settings-save"
					type="button"
					disabled={busy || !view.canLink}
					onClick={() => void flow.link()}
				>
					Link Google account
				</button>
			) : null}
			{fallback && running ? (
				<button className="settings-save" type="button" onClick={flow.openFallback}>
					Open Google sign-in
				</button>
			) : null}
			{running ? (
				<button
					className="settings-button"
					type="button"
					disabled={busy}
					onClick={() => void flow.cancel()}
				>
					Cancel linking
				</button>
			) : null}
			<button
				className="settings-button"
				type="button"
				disabled={busy}
				onClick={() => void flow.refresh()}
			>
				Check status
			</button>
		</div>
	);
}

/** Independent card; the Sharing mount is added in the integration slice. */
export function MyAccount() {
	const flow = useMyAccount();
	const { view, operation, message } = flow;
	const selectedGroup = flow.group ?? view?.selectedGroupId ?? "";
	const guidance = currentBlockGuidance(view, operation);
	const groupLocked =
		flow.busy || operation?.state === "starting" || operation?.state === "awaiting_browser";
	return (
		<section
			className="peer-card peer-card--padded recipient-policy-sharing-card"
			aria-labelledby="my-account-heading"
		>
			<div className="recipient-policy-sharing-card-header">
				<div className="peer-title recipient-policy-sharing-card-title">
					<h3 id="my-account-heading">My Account</h3>
				</div>
			</div>
			{view && view.groups.length > 1 ? (
				<div className="peer-scope">
					<label htmlFor="my-account-group">Group</label>
					<select
						id="my-account-group"
						value={selectedGroup}
						disabled={groupLocked}
						onChange={(event) => {
							if (event.currentTarget.disabled) return;
							flow.selectGroup(event.currentTarget.value || undefined);
						}}
					>
						<option value="">Choose a group</option>
						{view.groups.map((id) => (
							<option key={id} value={id}>
								{id}
							</option>
						))}
					</select>
				</div>
			) : null}
			{view ? <VerifiedAccount view={view} /> : null}
			<p role="status" aria-live="polite">
				{message || accountSummary(view, operation)}
			</p>
			{guidance ? <p className="small">{guidance}</p> : null}
			{view?.local ? (
				<p className="small">
					Codemem Identity: {view.local.identityLabel || view.local.identityId}
					{" · "}Device: {view.local.deviceLabel || view.local.deviceId}
					{view.coordinator ? <> · Coordinator: {view.coordinator.origin}</> : null}
				</p>
			) : null}
			<AccountActions flow={flow} />
		</section>
	);
}
