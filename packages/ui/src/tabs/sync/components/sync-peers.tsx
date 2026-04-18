import type { TargetedInputEvent } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
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
import { derivePeerTrustSummary, type PeerLike } from "../view-model";
import { renderIntoSyncMount } from "./render-root";
import { SyncEmptyState } from "./sync-empty-state";
import { type SyncActionFeedback, SyncInlineFeedback } from "./sync-inline-feedback";

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

function _summaryText(prefix: string, values: string[], emptyLabel: string): string {
	return `${prefix}: ${values.join(", ") || emptyLabel}`;
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
	const peerStatus: SyncPeerStatus = peer.status || {};
	const scope = peer.project_scope || {};
	const includeList = listText(scope.include);
	const excludeList = listText(scope.exclude);
	const _effectiveInclude = listText(scope.effective_include);
	const _effectiveExclude = listText(scope.effective_exclude);
	const _inheritsGlobal = Boolean(scope.inherits_global);
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

	return (
		<div ref={cardRef} className="peer-card" data-peer-device-id={peerId || undefined}>
			<div className="peer-title">
				<div>
					<strong title={peerId || undefined}>{displayName}</strong>
					<div className="peer-meta">
						<span className={`badge ${trustSummary.isWarning ? "badge-offline" : "badge-online"}`}>
							{trustSummary.badgeLabel}
						</span>
						{pendingScopeReview ? (
							<span className="badge actor-badge">Needs scope review</span>
						) : null}
					</div>
				</div>

				<div className="peer-actions">
					<button
						type="button"
						className="settings-button"
						disabled={!primaryAddress || syncBusy}
						onClick={() => void sync()}
					>
						{syncBusy ? "Syncing…" : "Sync now"}
					</button>
					<TextInput
						aria-label={`Friendly name for ${displayName}`}
						className="peer-scope-input"
						data-device-name-input={peerId || undefined}
						disabled={renameBusy}
						placeholder="Friendly device name"
						type="text"
						value={renameValue}
						onInput={(event: TargetedInputEvent<HTMLInputElement>) =>
							setRenameValue(event.currentTarget.value)
						}
					/>
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
					Review or tighten what this device can share when you need more than the global defaults.
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
							? "Turn on sync in Settings → Device Sync first, then use Show pairing in Advanced diagnostics to connect another device."
							: "Use Show pairing in Advanced diagnostics, run the command on the other device, then come back here to name it and decide who it belongs to."
					}
					title="No devices connected here yet."
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
