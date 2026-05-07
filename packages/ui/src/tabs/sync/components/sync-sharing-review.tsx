export interface SyncSharingReviewItem {
	actorDisplayName: string;
	actorId: string;
	peerName: string;
	privateCount: number;
	scopeLabel: string;
	shareableCount: number;
}

export interface SyncLegacySharedReviewItem {
	memoryCount: number;
	scopeId: string;
}

type SyncSharingReviewProps = {
	items: SyncSharingReviewItem[];
	legacyReview?: SyncLegacySharedReviewItem | null;
	onReview: () => void;
};

function SharingReviewRow({
	item,
	onReview,
}: {
	item: SyncSharingReviewItem;
	onReview: () => void;
}) {
	return (
		<div className="actor-row">
			<div className="actor-details">
				<div className="actor-title">
					<strong>{item.peerName}</strong>
					<span className="badge actor-badge">person: {item.actorDisplayName || item.actorId}</span>
				</div>
				<div className="peer-meta">
					{item.shareableCount} share by default · {item.privateCount} marked Only me ·{" "}
					{item.scopeLabel}
				</div>
			</div>
			<div className="actor-actions">
				<button type="button" className="settings-button" onClick={onReview}>
					Review my memories in Feed
				</button>
			</div>
		</div>
	);
}

function LegacySharedReviewRow({ item }: { item: SyncLegacySharedReviewItem }) {
	return (
		<div className="actor-row">
			<div className="actor-details">
				<div className="actor-title">
					<strong>Legacy shared review</strong>
					<span className="badge badge-offline">Needs review</span>
				</div>
				<div className="peer-meta">
					{item.memoryCount.toLocaleString()} historical shared memories are in {item.scopeId}. 0.30
					placed ambiguous older shared data there conservatively; review mappings before promoting
					it. Remapping or revocation does not erase data already copied to peers.
				</div>
			</div>
		</div>
	);
}

export function SyncSharingReview({ items, legacyReview, onReview }: SyncSharingReviewProps) {
	return (
		<>
			{legacyReview ? <LegacySharedReviewRow item={legacyReview} /> : null}
			{items.map((item) => (
				<SharingReviewRow
					key={`${item.peerName}:${item.actorId}:${item.scopeLabel}`}
					item={item}
					onReview={onReview}
				/>
			))}
		</>
	);
}
