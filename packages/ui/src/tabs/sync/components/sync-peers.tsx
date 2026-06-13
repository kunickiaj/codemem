import * as Collapsible from "@radix-ui/react-collapsible";
import type { TargetedInputEvent } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { PresencePip, type PresenceState } from "../../../components/primitives/presence-pip";
import { RadixSelect } from "../../../components/primitives/radix-select";
import { TextInput } from "../../../components/primitives/text-input";
import { formatTimestamp } from "../../../lib/format";
import { isSyncRedactionEnabled, state } from "../../../lib/state";
import {
	buildActorSelectOptions,
	clearPeerScopeReview,
	consumePeerScopeReviewRequest,
	isPeerScopeReviewPending,
	pickPrimaryAddress,
	redactAddress,
} from "../helpers";
import { openSyncConfirmDialog } from "../sync-dialogs";
import {
	derivePeerAuthorizedDomainsView,
	derivePeerDirection,
	derivePeerGrantRoleMismatchView,
	derivePeerProjectNarrowingView,
	derivePeerScopeRejectionsView,
	derivePeerScopeSyncView,
	derivePeerTrustSummary,
	derivePeerUiStatus,
	type PeerClaimedLocalActorScopeLike,
	type PeerDirection,
	type PeerLike,
	type PeerPerScopeSyncLike,
	type PeerProjectScopeLike,
	type PeerScopeRejectionsSummary,
} from "../view-model";
import { renderIntoSyncMount } from "./render-root";
import { SyncEmptyState } from "./sync-empty-state";
import { type SyncActionFeedback, SyncInlineFeedback } from "./sync-inline-feedback";

/* Lucide `chevron-right` inlined so Radix Collapsible can rotate it via
 * CSS on open without depending on the viewer's CDN lucide bootstrap
 * (which replaces `<i data-lucide=".." />` placeholders after mount —
 * unreliable inside a portal that mounts after that sweep runs). */
function ChevronRightIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="2"
			viewBox="0 0 24 24"
			xmlns="http://www.w3.org/2000/svg"
		>
			<title>Chevron</title>
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}

/* Map the view-model's UI-status vocabulary to the PresencePip state
 * matrix defined in docs/plans/2026-04-23-sync-tab-redesign.md. */
function presenceForPeer(peer: PeerLike): PresenceState {
	switch (derivePeerUiStatus(peer)) {
		case "connected":
			return "online";
		case "offline":
			return "offline";
		case "needs-repair":
			return "attention";
		default:
			return "unknown";
	}
}

/* Module-level expand state — only one device drawer open at a time.
 * The row component subscribes via a tick counter in local state so
 * React re-renders when the global pointer changes. */
let expandedPeerId: string | null = null;
let expandTickCounter = 0;
const expandListeners = new Set<(tick: number) => void>();

function setExpandedPeer(peerId: string | null): void {
	if (expandedPeerId === peerId) return;
	expandedPeerId = peerId;
	expandTickCounter += 1;
	for (const listener of expandListeners) listener(expandTickCounter);
}

function useExpandedPeer(): string | null {
	const [, setTick] = useState(0);
	useEffect(() => {
		expandListeners.add(setTick);
		return () => {
			expandListeners.delete(setTick);
		};
	}, []);
	return expandedPeerId;
}

const DIRECTION_GLYPH: Record<PeerDirection, { glyph: string; label: string } | null> = {
	bidirectional: { glyph: "↕", label: "Bidirectional sync in the last 24 hours" },
	publishing: { glyph: "↑", label: "Publishing only in the last 24 hours" },
	subscribed: { glyph: "↓", label: "Subscribed only in the last 24 hours" },
	none: null,
};

type SyncPeer = PeerLike & {
	actor_display_name?: string;
	address_count?: number;
	addresses?: unknown[];
	claimed_local_actor?: boolean;
	claimed_local_actor_scope?: PeerClaimedLocalActorScopeLike | null;
	per_scope_sync?: PeerPerScopeSyncLike[];
	project_scope?: PeerProjectScopeLike;
	scope_rejections?: PeerScopeRejectionsSummary;
	discovered_via_coordinator_id?: string | null;
	discovered_via_group_id?: string | null;
};

type SyncPeerStatus = NonNullable<SyncPeer["status"]> & {
	last_ping_at?: string;
	last_ping_at_utc?: string;
	last_sync_at?: string;
	last_sync_at_utc?: string;
};

type SyncPeerCardProps = {
	peer: SyncPeer;
	onAssignActor: (peerId: string, actorId: string | null) => Promise<SyncActionFeedback>;
	onRemove: (peerId: string, label: string) => Promise<SyncActionFeedback>;
	onRename: (peerId: string, name: string) => Promise<SyncActionFeedback>;
	onSync: (peer: SyncPeer, address: string | undefined) => Promise<SyncActionFeedback | null>;
};

type SyncPeersListProps = Omit<SyncPeerCardProps, "peer"> & {
	peers: SyncPeer[];
};

function claimedLocalActorScopeMessage(
	scope: PeerClaimedLocalActorScopeLike | null | undefined,
): string {
	if (!scope) {
		return "Private same-person sync is limited to an allowed personal Space; team or org Spaces do not carry your private memories.";
	}
	if (scope.authorized) {
		return "Private same-person sync is limited to your personal Space. Team and org Spaces do not carry your private memories.";
	}
	return "Private same-person sync is blocked until this device is granted an allowed personal Space.";
}

function openTeamsAccessManagement(): void {
	window.location.hash = "coordinator-admin";
}

export function canManageSpacesInTeams(status = state.lastCoordinatorAdminStatus): boolean {
	return status?.readiness === "ready" && status.has_admin_secret === true;
}

function SyncPeerCard({ peer, onAssignActor, onRemove, onRename, onSync }: SyncPeerCardProps) {
	const peerId = String(peer.peer_device_id || "");
	const displayName = peer.name || (peerId ? peerId.slice(0, 8) : "unknown");
	const destructiveLabel = peer.name || peerId || displayName;
	const trustSummary = derivePeerTrustSummary(peer);
	const directionHint = DIRECTION_GLYPH[derivePeerDirection(peer)];
	const peerStatus: SyncPeerStatus = peer.status || {};
	const authorizedDomains = derivePeerAuthorizedDomainsView(peer);
	const rawPendingScopeReview = isPeerScopeReviewPending(peerId);
	const pendingScopeReview = rawPendingScopeReview && authorizedDomains.total === 0;
	const grantRoleMismatch = derivePeerGrantRoleMismatchView(peer);
	const scopeRejections = derivePeerScopeRejectionsView(peer);
	const scopeSync = derivePeerScopeSyncView(peer);
	const scope = peer.project_scope || {};
	const projectNarrowing = derivePeerProjectNarrowingView(scope);
	const primaryAddress = pickPrimaryAddress(peer.addresses);
	const peerAddresses = Array.isArray(peer.addresses)
		? Array.from(new Set(peer.addresses.filter(Boolean).map((value) => String(value))))
		: [];
	const rawHiddenAddressCount = Number(peer.address_count ?? 0);
	const hiddenAddressCount =
		Number.isFinite(rawHiddenAddressCount) && rawHiddenAddressCount > 0 ? rawHiddenAddressCount : 0;
	const addressLine = peerAddresses.length
		? peerAddresses
				.map((address) => (isSyncRedactionEnabled() ? redactAddress(address) : address))
				.join(" · ")
		: hiddenAddressCount > 0
			? `${hiddenAddressCount} ${hiddenAddressCount === 1 ? "address" : "addresses"} hidden`
			: "No addresses";
	const assignmentSummary = peer.actor_display_name
		? `This device belongs to ${peer.claimed_local_actor ? "you" : String(peer.actor_display_name)}.`
		: "This device is not assigned to anyone yet.";
	const lastSyncAt = String(peerStatus.last_sync_at || peerStatus.last_sync_at_utc || "");
	const lastPingAt = String(peerStatus.last_ping_at || peerStatus.last_ping_at_utc || "");
	const discoverySummary = peer.discovered_via_group_id
		? `Discovery: seen through Team ${peer.discovered_via_group_id}. Discovery helps find devices; Space access above decides data access.`
		: peer.discovered_via_coordinator_id
			? `Discovery: seen through coordinator ${peer.discovered_via_coordinator_id}. Discovery helps find devices; Space access above decides data access.`
			: null;
	const scopeReviewRequested = consumePeerScopeReviewRequest(peerId);
	const cardRef = useRef<HTMLDivElement | null>(null);

	const [renameValue, setRenameValue] = useState(displayName);
	const [feedback, setFeedback] = useState<SyncActionFeedback | null>(
		() => state.syncPeerFeedbackById.get(peerId) ?? null,
	);
	const [renameBusy, setRenameBusy] = useState(false);
	const [renameLabel, setRenameLabel] = useState("Save name");
	const [syncBusy, setSyncBusy] = useState(false);
	const [removeBusy, setRemoveBusy] = useState(false);
	const [removeLabel, setRemoveLabel] = useState("Remove device");
	const [selectedActorId, setSelectedActorId] = useState(String(peer.actor_id || ""));
	const [applyActorBusy, setApplyActorBusy] = useState(false);
	const [applyActorLabel, setApplyActorLabel] = useState("Save assignment");
	const actorSelectOptions = useMemo(() => {
		const options = buildActorSelectOptions(selectedActorId);
		const hasSelected = options.some((option) => option.value === selectedActorId);
		if (selectedActorId && !hasSelected) {
			options.push({
				value: selectedActorId,
				label: peer.claimed_local_actor
					? "You"
					: String(peer.actor_display_name || "Current assignment"),
			});
		}
		return options;
	}, [
		peer.actor_display_name,
		peer.claimed_local_actor,
		selectedActorId,
		state.lastSyncActors,
		state.lastSyncPeers,
		state.lastSyncViewModel,
	]);

	useEffect(() => {
		if (rawPendingScopeReview && authorizedDomains.total > 0) clearPeerScopeReview(peerId);
	}, [authorizedDomains.total, peerId, rawPendingScopeReview]);

	useEffect(() => {
		setRenameValue(displayName);
		setFeedback(state.syncPeerFeedbackById.get(peerId) ?? null);
		setRenameBusy(false);
		setRenameLabel("Save name");
		setSyncBusy(false);
		setRemoveBusy(false);
		setRemoveLabel("Remove device");
		setSelectedActorId(String(peer.actor_id || ""));
		setApplyActorBusy(false);
		setApplyActorLabel("Save assignment");
	}, [displayName, peer.actor_id, peerId]);

	useEffect(() => {
		if (!scopeReviewRequested || !cardRef.current) return;
		queueMicrotask(() =>
			cardRef.current?.scrollIntoView({
				block: "center",
				behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			}),
		);
	}, [scopeReviewRequested]);

	async function rename() {
		if (!peerId) return;
		const nextName = renameValue.trim();
		if (!nextName) {
			const warning = {
				message: "Enter a friendly name for this device.",
				tone: "warning",
			} satisfies SyncActionFeedback;
			setFeedback(warning);
			state.syncPeerFeedbackById.set(peerId, warning);
			const input = document.querySelector(
				`[data-device-name-input="${CSS.escape(peerId)}"]`,
			) as HTMLInputElement | null;
			input?.focus();
			return;
		}
		setRenameBusy(true);
		setRenameLabel("Saving…");
		try {
			const nextFeedback = await onRename(peerId, nextName);
			setFeedback(nextFeedback);
			state.syncPeerFeedbackById.set(peerId, nextFeedback);
			setRenameLabel("Save name");
		} catch {
			setRenameLabel("Retry");
		} finally {
			setRenameBusy(false);
		}
	}

	async function sync() {
		if (pendingScopeReview) {
			const canReviewInTeams = canManageSpacesInTeams();
			const proceed = await openSyncConfirmDialog({
				title: `Sync ${displayName} before advanced rule review?`,
				description: canReviewInTeams
					? "This manual sync will use the current Space access and advanced filters until you review them in Teams."
					: "This manual sync will use the current Space access and advanced filters until a coordinator or manager reviews them in Teams.",
				confirmLabel: "Sync anyway",
				cancelLabel: canReviewInTeams ? "Review in Teams first" : "Cancel",
			});
			if (!proceed) return;
		}
		setSyncBusy(true);
		try {
			const nextFeedback = await onSync(peer, primaryAddress);
			setFeedback(nextFeedback);
			if (nextFeedback) state.syncPeerFeedbackById.set(peerId, nextFeedback);
		} finally {
			setSyncBusy(false);
		}
	}

	async function remove() {
		if (!peerId) return;
		const confirmed = await openSyncConfirmDialog({
			title: `Remove device ${destructiveLabel}?`,
			description: "This removes the local record for this paired device on this machine.",
			confirmLabel: "Remove device",
			cancelLabel: "Keep device",
			tone: "danger",
		});
		if (!confirmed) return;
		setRemoveBusy(true);
		setRemoveLabel("Removing…");
		let ok = false;
		try {
			await onRemove(peerId, destructiveLabel);
			ok = true;
		} catch {
			setRemoveLabel("Retry remove");
		} finally {
			setRemoveBusy(false);
			if (ok) setRemoveLabel("Remove device");
		}
	}

	async function savePerson() {
		if (!peerId) return;
		setApplyActorBusy(true);
		setApplyActorLabel("Saving…");
		try {
			const nextFeedback = await onAssignActor(peerId, selectedActorId || null);
			setFeedback(nextFeedback);
			state.syncPeerFeedbackById.set(peerId, nextFeedback);
			setApplyActorLabel("Save assignment");
		} catch {
			setApplyActorLabel("Retry");
		} finally {
			setApplyActorBusy(false);
		}
	}

	const currentExpandedId = useExpandedPeer();
	const isExpanded = currentExpandedId === peerId && peerId !== "";
	const drawerId = `device-drawer-${peerId || "unknown"}`;
	// Presence is derived strictly from the server-side peer state. The
	// Sync-now button carries its own in-flight affordance (label + spinner);
	// we do not flip the pip to "syncing" locally because no backend signal
	// keeps the state honest for global sync fan-out or background sync.
	// Reintroduce a "syncing" state only when peer-level in-flight shows up
	// in SyncPeerStatusLike.
	const presenceState: PresenceState = presenceForPeer(peer);
	const syncMetaText = lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : "Sync: never";
	const canManageSpaces = canManageSpacesInTeams();

	const toggleLabel = `${isExpanded ? "Collapse" : "Expand"} device ${displayName}`;
	// Read module-level state directly (not the stale closure value of
	// `isExpanded`) when handling the close callback. When another row
	// takes over, Radix fires this row's onOpenChange(false) after the
	// module-level pointer has already moved — we must NOT clobber it.
	const handleOpenChange = (open: boolean) => {
		if (open) setExpandedPeer(peerId);
		else if (expandedPeerId === peerId) setExpandedPeer(null);
	};

	return (
		<Collapsible.Root asChild open={isExpanded} onOpenChange={handleOpenChange}>
			<div ref={cardRef} className="peer-card" data-peer-device-id={peerId || undefined}>
				{/* Row head IS the Collapsible trigger — the whole band is
				    clickable for a smoother expand/collapse. The chevron is
				    a visual indicator driven by `data-state`, not a separate
				    interactive element. */}
				<Collapsible.Trigger asChild>
					<button
						aria-label={toggleLabel}
						className="device-row-head device-row-head--trigger"
						type="button"
					>
						<PresencePip state={presenceState} />
						<span className="device-row-name" title={peerId || undefined}>
							{displayName}
						</span>
						{directionHint ? (
							<span
								aria-label={directionHint.label}
								className="peer-direction"
								role="img"
								title={directionHint.label}
							>
								{directionHint.glyph}
							</span>
						) : null}
						<span className="device-row-chips">
							<span
								className={`badge ${trustSummary.isWarning ? "badge-offline" : "badge-online"}`}
							>
								{trustSummary.badgeLabel}
							</span>
							{pendingScopeReview ? (
								<span className="badge actor-badge">Review advanced rules</span>
							) : null}
							<span
								className={`badge ${authorizedDomains.isWarning ? "badge-offline" : "actor-badge"}`}
								title="Spaces are the hard access boundary; advanced filters only narrow inside them."
							>
								{authorizedDomains.badgeLabel}
							</span>
							{scopeRejections.badgeLabel ? (
								<span
									className="badge badge-offline"
									title="Inbound ops rejected by the sharing-domain scope gate. Expand for reason codes."
								>
									{scopeRejections.badgeLabel}
								</span>
							) : null}
							{grantRoleMismatch.badgeLabel ? (
								<span
									className="badge badge-offline"
									title="Review whether explicit Space access matches this device's intended role."
								>
									{grantRoleMismatch.badgeLabel}
								</span>
							) : null}
							{peer.discovered_via_group_id ? (
								<span
									className="badge actor-badge"
									title={`Discovered through coordinator group ${peer.discovered_via_group_id}`}
								>
									{`via ${peer.discovered_via_group_id}`}
								</span>
							) : null}
						</span>
						<span className="device-row-meta">{syncMetaText}</span>
						<span aria-hidden="true" className="device-row-chevron">
							<ChevronRightIcon />
						</span>
					</button>
				</Collapsible.Trigger>

				<Collapsible.Content
					aria-label={`Device actions for ${displayName}`}
					className="device-row-drawer"
					id={drawerId}
				>
					<div className="peer-actions">
						<button
							type="button"
							className="settings-button"
							disabled={syncBusy}
							onClick={() => void sync()}
							title={
								primaryAddress
									? undefined
									: "Address details are hidden; sync will target this device by ID."
							}
						>
							{syncBusy ? "Syncing…" : "Sync now"}
						</button>
						<div className="sync-labeled-field">
							<label
								className="sync-labeled-field-caption"
								htmlFor={`device-name-${peerId || "unknown"}`}
							>
								Device name
							</label>
							<TextInput
								aria-label={`Friendly name for ${displayName}`}
								className="peer-scope-input"
								data-device-name-input={peerId || undefined}
								disabled={renameBusy}
								id={`device-name-${peerId || "unknown"}`}
								placeholder="Friendly device name"
								type="text"
								value={renameValue}
								onInput={(event: TargetedInputEvent<HTMLInputElement>) =>
									setRenameValue(event.currentTarget.value)
								}
							/>
						</div>
						<button
							type="button"
							className="settings-button"
							disabled={renameBusy}
							onClick={() => void rename()}
						>
							{renameLabel}
						</button>
						<button
							type="button"
							className="settings-button danger"
							disabled={removeBusy}
							onClick={() => void remove()}
						>
							{removeLabel}
						</button>
					</div>

					<div className="peer-scope">
						{scopeReviewRequested ? (
							<div className="peer-meta">
								{canManageSpaces
									? "Review this device's Space access and advanced rules in Teams if the defaults are too broad."
									: "A coordinator or manager can review this device's Space access and advanced rules in Teams if the defaults are too broad."}
							</div>
						) : pendingScopeReview ? (
							<div className="peer-meta">
								Advanced rule review is still pending for this device.
							</div>
						) : null}

						<div className="peer-scope-summary">Device details</div>
						<div className="peer-addresses">{addressLine}</div>
						{discoverySummary ? <div className="peer-meta">{discoverySummary}</div> : null}
						<div className="peer-meta">
							{[
								lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : "Sync: never",
								lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : "Ping: never",
							].join(" · ")}
						</div>

						<div className="peer-scope-summary">Space access</div>
						<div className="peer-meta">
							{authorizedDomains.total > 0
								? "These Spaces are the hard access boundary for this device."
								: authorizedDomains.emptyMessage}
						</div>
						{authorizedDomains.domains.length > 0 ? (
							<ul className="peer-scope-chips" aria-label="Authorized Spaces">
								{authorizedDomains.domains.map((domain) => (
									<li className="peer-scope-chip" key={domain.scopeId} title={domain.detail}>
										{domain.label}
									</li>
								))}
							</ul>
						) : null}
						{grantRoleMismatch.isVisible ? (
							<div className="settings-note" role="status">
								<strong>{grantRoleMismatch.title}</strong>
								<div>{grantRoleMismatch.message}</div>
								<div>{grantRoleMismatch.detail}</div>
							</div>
						) : null}
						<div className="peer-meta">{projectNarrowing.note}</div>

						<div className="peer-scope-summary">Space sync progress</div>
						<div className="peer-meta">
							{scopeSync.total > 0
								? "Per-Space progress for this device. Open details to see technical identifiers."
								: scopeSync.emptyMessage}
						</div>
						{scopeSync.rows.length > 0 ? (
							<ul className="peer-scope-rejections-list" aria-label="Per-Space sync progress">
								{scopeSync.rows.map((row) => (
									<li key={row.scopeId} title={row.detail}>
										<span className="peer-scope-rejection-label">{row.label}</span>
										<span
											className={`badge ${row.status === "received" ? "badge-online" : "actor-badge"}`}
										>
											{row.badgeLabel}
										</span>
									</li>
								))}
							</ul>
						) : null}

						{scopeRejections.total > 0 ? (
							<div
								className="peer-scope-rejections"
								data-peer-rejection-count={scopeRejections.total}
							>
								<div className="peer-scope-summary">Sharing-rule rejections (24h)</div>
								<div className="peer-meta">
									Inbound ops the local fail-closed gate refused. Diagnostics never expose op
									payloads.
								</div>
								<ul className="peer-scope-rejections-list">
									{scopeRejections.reasons.map((entry) => (
										<li key={entry.reason}>
											<span className="peer-scope-rejection-label">{entry.label}</span>
											<span className="peer-scope-rejection-count">
												{entry.count.toLocaleString()}
											</span>
										</li>
									))}
								</ul>
								{scopeRejections.lastAt ? (
									<div className="peer-meta">
										Last rejected {formatTimestamp(scopeRejections.lastAt)}
									</div>
								) : null}
							</div>
						) : null}

						<div className="peer-scope-summary">Who this device belongs to</div>
						<div className="peer-meta">{assignmentSummary}</div>
						{peer.claimed_local_actor ? (
							<div className="peer-meta">
								{claimedLocalActorScopeMessage(peer.claimed_local_actor_scope)}
							</div>
						) : null}
						<div className="peer-actor-row">
							<div className="sync-radix-select-host sync-actor-select-host">
								<RadixSelect
									ariaLabel={`Assigned person for ${displayName}`}
									contentClassName="sync-radix-select-content sync-actor-select-content"
									disabled={applyActorBusy}
									itemClassName="sync-radix-select-item"
									onValueChange={setSelectedActorId}
									options={actorSelectOptions}
									placeholder="No person assigned yet"
									triggerClassName="sync-radix-select-trigger sync-actor-select"
									value={selectedActorId}
									viewportClassName="sync-radix-select-viewport"
								/>
							</div>
							<button
								type="button"
								className="settings-button"
								disabled={applyActorBusy}
								onClick={() => void savePerson()}
							>
								{applyActorLabel}
							</button>
						</div>

						<div className="peer-scope-summary">Advanced sharing rules</div>
						<div className="peer-meta">
							{projectNarrowing.statusLabel}. {projectNarrowing.summary} {projectNarrowing.note}
						</div>
						{canManageSpaces ? (
							<div className="peer-actions">
								<button
									type="button"
									className="settings-button"
									onClick={openTeamsAccessManagement}
								>
									Manage Spaces in Teams
								</button>
							</div>
						) : (
							<div className="peer-meta">
								Space access is managed in Teams by a coordinator or manager.
							</div>
						)}
						<SyncInlineFeedback feedback={feedback} />
					</div>
				</Collapsible.Content>
			</div>
		</Collapsible.Root>
	);
}

function SyncPeersList(props: SyncPeersListProps) {
	const sectionFeedback = state.syncPeersSectionFeedback;
	const syncStatus = state.lastSyncStatus as { daemon_state?: string; enabled?: boolean } | null;
	const syncDisabled = syncStatus?.daemon_state === "disabled" || syncStatus?.enabled === false;
	if (!props.peers.length) {
		return (
			<>
				<SyncInlineFeedback feedback={sectionFeedback} />
				<SyncEmptyState
					detail={
						syncDisabled
							? "Turn on sync in Settings → Device Sync first. Then use Invite a teammate or Paste an invite above to connect another device."
							: "Use Invite a teammate above to share a join code, or Paste an invite to enroll this device on an existing team."
					}
					title="No teammates yet"
				/>
			</>
		);
	}

	return (
		<>
			<SyncInlineFeedback feedback={sectionFeedback} />
			{props.peers.map((peer) => {
				const peerId = String(peer.peer_device_id || peer.name || "unknown-peer");
				return <SyncPeerCard key={peerId} peer={peer} {...props} />;
			})}
		</>
	);
}

export function renderSyncPeersList(mount: HTMLElement, props: SyncPeersListProps) {
	renderIntoSyncMount(mount, <SyncPeersList {...props} />);
}
