import type { TargetedInputEvent } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { PresencePip, type PresenceState } from "../../../components/primitives/presence-pip";
import { RadixSelect } from "../../../components/primitives/radix-select";
import { TextInput } from "../../../components/primitives/text-input";
import { formatTimestamp } from "../../../lib/format";
import { isSyncRedactionEnabled, state } from "../../../lib/state";
import {
	buildActorSelectOptions,
	consumePeerScopeReviewRequest,
	createChipEditor,
	isPeerScopeReviewPending,
	openPeerScopeEditors,
	pickPrimaryAddress,
	redactAddress,
} from "../helpers";
import { PeerScopeCollapsible } from "../peer-scope-collapsible";
import { openSyncConfirmDialog } from "../sync-dialogs";
import {
	derivePeerDirection,
	derivePeerTrustSummary,
	derivePeerUiStatus,
	type PeerDirection,
	type PeerLike,
} from "../view-model";

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

import { renderIntoSyncMount } from "./render-root";
import { SyncEmptyState } from "./sync-empty-state";
import { type SyncActionFeedback, SyncInlineFeedback } from "./sync-inline-feedback";

const DIRECTION_GLYPH: Record<PeerDirection, { glyph: string; label: string } | null> = {
	bidirectional: { glyph: "↕", label: "Bidirectional sync in the last 24 hours" },
	publishing: { glyph: "↑", label: "Publishing only in the last 24 hours" },
	subscribed: { glyph: "↓", label: "Subscribed only in the last 24 hours" },
	none: null,
};

type PeerScopeLike = {
	include?: string[];
	exclude?: string[];
	effective_include?: string[];
	effective_exclude?: string[];
	inherits_global?: boolean;
};

type SyncPeer = PeerLike & {
	actor_display_name?: string;
	addresses?: unknown[];
	claimed_local_actor?: boolean;
	project_scope?: PeerScopeLike;
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
	onResetScope: (peerId: string) => Promise<SyncActionFeedback>;
	onSaveScope: (
		peerId: string,
		include: string[],
		exclude: string[],
	) => Promise<SyncActionFeedback>;
	onSync: (peer: SyncPeer, address: string | undefined) => Promise<SyncActionFeedback | null>;
};

type SyncPeersListProps = Omit<SyncPeerCardProps, "peer"> & {
	peers: SyncPeer[];
};

function listText(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function ExistingElementSlot({ element }: { element: HTMLElement }) {
	const hostRef = useRef<HTMLDivElement | null>(null);

	useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		if (element.parentElement !== host) host.appendChild(element);
		return () => {
			if (element.parentElement === host) {
				host.removeChild(element);
			}
		};
	}, [element]);

	return <div ref={hostRef} />;
}

function SyncPeerCard({
	peer,
	onAssignActor,
	onRemove,
	onRename,
	onResetScope,
	onSaveScope,
	onSync,
}: SyncPeerCardProps) {
	const peerId = String(peer.peer_device_id || "");
	const displayName = peer.name || (peerId ? peerId.slice(0, 8) : "unknown");
	const destructiveLabel = peer.name || peerId || displayName;
	const pendingScopeReview = isPeerScopeReviewPending(peerId);
	const trustSummary = derivePeerTrustSummary(peer);
	const directionHint = DIRECTION_GLYPH[derivePeerDirection(peer)];
	const peerStatus: SyncPeerStatus = peer.status || {};
	const scope = peer.project_scope || {};
	const includeList = listText(scope.include);
	const excludeList = listText(scope.exclude);
	const primaryAddress = pickPrimaryAddress(peer.addresses);
	const peerAddresses = Array.isArray(peer.addresses)
		? Array.from(new Set(peer.addresses.filter(Boolean).map((value) => String(value))))
		: [];
	const addressLine = peerAddresses.length
		? peerAddresses
				.map((address) => (isSyncRedactionEnabled() ? redactAddress(address) : address))
				.join(" · ")
		: "No addresses";
	const assignmentSummary = peer.actor_display_name
		? `This device belongs to ${peer.claimed_local_actor ? "you" : String(peer.actor_display_name)}.`
		: "This device is not assigned to anyone yet.";
	const lastSyncAt = String(peerStatus.last_sync_at || peerStatus.last_sync_at_utc || "");
	const lastPingAt = String(peerStatus.last_ping_at || peerStatus.last_ping_at_utc || "");
	const scopeEditorOpen = openPeerScopeEditors.has(peerId);
	const scopeReviewRequested = consumePeerScopeReviewRequest(peerId);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [scopeHost, setScopeHost] = useState<HTMLDivElement | null>(null);

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
	const [saveScopeBusy, setSaveScopeBusy] = useState(false);
	const [saveScopeLabel, setSaveScopeLabel] = useState("Save scope");
	const [resetScopeBusy, setResetScopeBusy] = useState(false);
	const [resetScopeLabel, setResetScopeLabel] = useState("Reset to global scope");
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

	const includeEditor = useMemo(
		() => createChipEditor(includeList, "Add included project", "All projects"),
		[peerId, includeList.join("|")],
	);
	const excludeEditor = useMemo(
		() => createChipEditor(excludeList, "Add excluded project", "No exclusions"),
		[peerId, excludeList.join("|")],
	);

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
		setSaveScopeBusy(false);
		setSaveScopeLabel("Save scope");
		setResetScopeBusy(false);
		setResetScopeLabel("Reset to global scope");
	}, [displayName, peer.actor_id, peerId, includeList.join("|"), excludeList.join("|")]);

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
		if (!primaryAddress) return;
		if (pendingScopeReview) {
			const proceed = await openSyncConfirmDialog({
				title: `Sync ${displayName} before scope review?`,
				description:
					"This manual sync will use the current effective scope until you finish reviewing and saving the device scope.",
				confirmLabel: "Sync anyway",
				cancelLabel: "Review scope first",
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

	async function saveScope() {
		if (!peerId) return;
		setSaveScopeBusy(true);
		setSaveScopeLabel("Saving…");
		try {
			const nextFeedback = await onSaveScope(
				peerId,
				includeEditor.values(),
				excludeEditor.values(),
			);
			setFeedback(nextFeedback);
			state.syncPeerFeedbackById.set(peerId, nextFeedback);
			setSaveScopeLabel("Save scope");
		} catch {
			setSaveScopeLabel("Retry");
		} finally {
			setSaveScopeBusy(false);
		}
	}

	async function resetScope() {
		if (!peerId) return;
		setResetScopeBusy(true);
		setResetScopeLabel("Resetting…");
		try {
			const nextFeedback = await onResetScope(peerId);
			setFeedback(nextFeedback);
			state.syncPeerFeedbackById.set(peerId, nextFeedback);
			setResetScopeLabel("Reset to global scope");
		} catch {
			setResetScopeLabel("Retry");
		} finally {
			setResetScopeBusy(false);
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

	const toggleExpand = () => setExpandedPeer(isExpanded ? null : peerId);
	const toggleLabel = `${isExpanded ? "Collapse" : "Expand"} device ${displayName}`;

	return (
		<div ref={cardRef} className="peer-card" data-peer-device-id={peerId || undefined}>
			{/* Row head: non-interactive content + a dedicated disclosure
			    button on the right. This avoids burying badges, glyphs, and
			    title attributes inside a button's accessible-name
			    computation (which would produce a 40+ word announcement).
			    Clicking anywhere in the row still toggles the drawer via a
			    background click handler — the button is what assistive tech
			    sees and keyboard users activate. */}
			<div className="device-row-head">
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
					<span className={`badge ${trustSummary.isWarning ? "badge-offline" : "badge-online"}`}>
						{trustSummary.badgeLabel}
					</span>
					{pendingScopeReview ? (
						<span className="badge actor-badge">Needs scope review</span>
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
				<button
					aria-controls={drawerId}
					aria-expanded={isExpanded}
					aria-label={toggleLabel}
					className="device-row-toggle"
					onClick={toggleExpand}
					type="button"
				>
					<span aria-hidden="true" className="device-row-chevron">
						{isExpanded ? "▾" : "▸"}
					</span>
				</button>
			</div>

			{isExpanded ? (
				<section
					aria-label={`Device actions for ${displayName}`}
					className="device-row-drawer"
					id={drawerId}
				>
					<div className="peer-actions">
						<button
							type="button"
							className="settings-button"
							disabled={!primaryAddress || syncBusy}
							onClick={() => void sync()}
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
								Review this device&apos;s sharing rules now if the defaults are too broad.
							</div>
						) : pendingScopeReview ? (
							<div className="peer-meta">Sharing rule review is still pending for this device.</div>
						) : null}

						<div className="peer-scope-summary">Device details</div>
						<div className="peer-addresses">{addressLine}</div>
						<div className="peer-meta">
							{[
								lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : "Sync: never",
								lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : "Ping: never",
							].join(" · ")}
						</div>

						<div className="peer-scope-summary">Who this device belongs to</div>
						<div className="peer-meta">{assignmentSummary}</div>
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

						<div className="peer-scope-summary">Advanced sharing scope</div>
						<div className="peer-meta">
							Review or tighten what this device can share when you need more than the global
							defaults.
						</div>
						<PeerScopeCollapsible
							contentHost={scopeHost}
							initialOpen={scopeEditorOpen}
							onOpenChange={(open) => {
								if (open) openPeerScopeEditors.add(peerId);
								else openPeerScopeEditors.delete(peerId);
							}}
						>
							<div>
								<div className="peer-scope-row">
									<ExistingElementSlot element={includeEditor.element} />
									<ExistingElementSlot element={excludeEditor.element} />
								</div>
								<div className="peer-scope-actions">
									<button
										type="button"
										className="settings-button"
										disabled={saveScopeBusy}
										onClick={() => void saveScope()}
									>
										{saveScopeLabel}
									</button>
									<button
										type="button"
										className="settings-button"
										disabled={resetScopeBusy}
										onClick={() => void resetScope()}
									>
										{resetScopeLabel}
									</button>
								</div>
							</div>
						</PeerScopeCollapsible>
						<SyncInlineFeedback feedback={feedback} />
						<div ref={setScopeHost} />
					</div>
				</section>
			) : null}
		</div>
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
