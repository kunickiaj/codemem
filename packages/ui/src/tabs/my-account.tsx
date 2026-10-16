import type { AccountOperation, AccountView } from "../lib/api/account";
import { useMyAccount } from "./my-account-flow";

const SCHEMA_UPGRADE_MESSAGE =
	"The coordinator needs a database schema upgrade before Google linking can work. Ask the person who runs it to back up and upgrade the coordinator. Normal device sync is still available.";

const FAILURE_MESSAGES: Partial<Record<NonNullable<AccountOperation["failure"]>, string>> = {
	schema_upgrade_required: SCHEMA_UPGRADE_MESSAGE,
	link_stopped: "Linking stopped. Check status before trying again.",
	link_conflict:
		"Account linking conflicts with an existing or revoked link. Ask the coordinator operator; this action cannot replace links or move Identities.",
};

const UNAVAILABLE_MESSAGES = new Map<string, string>([
	[
		"coordinator_incompatible",
		"The coordinator rejected this Viewer’s Google-linking request. Ask the person who runs the coordinator to update it, then check status.",
	],
	[
		"coordinator_unreachable",
		"Can’t reach the coordinator. Check your connection and the coordinator address, then check status again.",
	],
	[
		"coordinator_unavailable",
		"The coordinator service is unavailable. Wait a moment, then check status. If it keeps failing, ask the person who runs it to check the service.",
	],
	[
		"coordinator_rejected",
		"The coordinator rejected this device’s request. Check the selected group and coordinator, or ask the person who runs it to check this device’s enrollment.",
	],
	["rate_limited", "Too many status requests. Wait a moment, then check status again."],
	[
		"device_unavailable",
		"This Viewer can’t read the existing device identity or key. Check that you opened the correct Codemem profile.",
	],
	["coordinator_auth_schema_upgrade_required", SCHEMA_UPGRADE_MESSAGE],
	[
		"context_changed",
		"The selected profile or group changed during the check. Check status again for the current selection.",
	],
	[
		"invalid_response",
		"The coordinator returned an unexpected account-linking response. Ask the person who runs it to check that the coordinator and Viewer are up to date.",
	],
]);

function remoteSummary(view: AccountView): string {
	if (view.setup === "group_selection_required")
		return "Choose a group to check this Identity’s account status.";
	if (view.setup !== "ready")
		return "Account linking is not ready for this local Identity. Check the Viewer’s coordinator and device setup.";
	if (view.remote.kind === "unsupported")
		return "Google linking is not available on this coordinator. Ask the person who runs it to enable or update its Google-linking service.";
	if (view.remote.kind === "unavailable")
		return (
			UNAVAILABLE_MESSAGES.get(view.remote.code) ??
			"Google linking is unavailable. Check the selected coordinator, or ask the person who runs it for help."
		);
	if (view.remote.kind === "not_checked")
		return "Choose Check status to see whether you can link Google.";
	if (view.remote.state === "review_required")
		return "This profile can’t link Google yet. Check the selected profile and group. If they’re correct, ask the person who runs the coordinator to check this device.";
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
	if (!view)
		return "Google-linking status could not be loaded. Check that the Viewer is running, then check status again.";
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

function DeviceLinkRecovery({ view }: { view: AccountView | null }) {
	if (view?.remote.kind !== "status" || view.remote.state !== "review_required") return null;
	return (
		<details className="recipient-policy-management-details">
			<summary>What to check before linking</summary>
			<ol>
				<li>Check that the Viewer shows the profile, group and coordinator you intended to use.</li>
				<li>
					If those are correct, ask the person who runs the coordinator to check that this device is
					enabled and whether an existing account link blocks it.
				</li>
				<li>
					After the issue is resolved, choose <strong>Check status</strong> before trying to link.
				</li>
			</ol>
			<p className="small">
				Do not reset the profile or create another Identity to bypass this refusal.
			</p>
		</details>
	);
}

function AccountActions({ flow }: { flow: ReturnType<typeof useMyAccount> }) {
	const { view, operation, pendingOperation, busy, fallback } = flow;
	const running = operation?.state === "starting" || operation?.state === "awaiting_browser";
	return (
		<div className="peer-actions">
			{view && !running ? (
				<button
					className="settings-save"
					type="button"
					disabled={busy || !view.canLink || Boolean(pendingOperation)}
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
			{pendingOperation && !running ? (
				<button
					className="settings-button"
					type="button"
					disabled={busy}
					onClick={() => void flow.cancelPrevious()}
				>
					Cancel previous link
				</button>
			) : null}
			<button
				className="settings-button"
				type="button"
				disabled={busy || running}
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
			{flow.pendingOperation ? (
				<p className="small">
					An earlier link may still finish for its original Identity. Its current account context is
					unverified and may differ from the Identity shown here. Cancel previous link requests
					cancellation of that earlier attempt. Check status to confirm.
				</p>
			) : null}
			{view?.local ? (
				<p className="small">
					Codemem Identity: {view.local.identityLabel || view.local.identityId}
					{" · "}Device: {view.local.deviceLabel || view.local.deviceId}
					{view.coordinator ? <> · Coordinator: {view.coordinator.origin}</> : null}
				</p>
			) : null}
			<DeviceLinkRecovery view={view} />
			<AccountActions flow={flow} />
		</section>
	);
}
