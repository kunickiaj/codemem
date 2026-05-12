export interface SyncSharingReviewItem {
	actorDisplayName: string;
	actorId: string;
	peerName: string;
	privateCount: number;
	scopeLabel: string;
	shareableCount: number;
}

export interface SyncLegacySharedReviewItem {
	groups?: SyncLegacySharedReviewGroup[];
	memoryCount: number;
	scopeId: string;
}

export interface SyncLegacySharedReviewGroup {
	displayProject: string;
	identitySource: string;
	lastUpdatedAt: string | null;
	memoryCount: number;
	suggestedScopeId: string | null;
	suggestionReason: string | null;
	workspaceIdentity: string;
}

type SyncSharingReviewProps = {
	items: SyncSharingReviewItem[];
	legacyReview?: SyncLegacySharedReviewItem | null;
	onLegacyReview?: () => void;
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

function LegacySharedReviewRow({
	item,
	onReview,
}: {
	item: SyncLegacySharedReviewItem;
	onReview: () => void;
}) {
	const groups = item.groups ?? [];
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
				{groups.length > 0 ? (
					<ul className="peer-scope-rejections-list" aria-label="Legacy shared review groups">
						{groups.map((group) => (
							<li key={group.workspaceIdentity}>
								<span className="peer-scope-rejection-label">
									{group.displayProject} · {group.identitySource}
									{group.suggestedScopeId ? ` · suggested ${group.suggestedScopeId}` : ""}
								</span>
								<span className="peer-scope-rejection-count">
									{group.memoryCount.toLocaleString()}
								</span>
								{group.suggestionReason ? (
									<span className="peer-meta">{group.suggestionReason}</span>
								) : null}
							</li>
						))}
					</ul>
				) : null}
			</div>
			<div className="actor-actions">
				<button type="button" className="settings-button" onClick={onReview}>
					Review projects
				</button>
			</div>
		</div>
	);
}

export function SyncSharingReview({
	items,
	legacyReview,
	onLegacyReview,
	onReview,
}: SyncSharingReviewProps) {
	return (
		<>
			{legacyReview ? (
				<LegacySharedReviewRow item={legacyReview} onReview={onLegacyReview ?? onReview} />
			) : null}
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
