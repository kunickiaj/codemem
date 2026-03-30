export interface SyncSharingReviewItem {
  actorDisplayName: string;
  actorId: string;
  peerName: string;
  privateCount: number;
  scopeLabel: string;
  shareableCount: number;
}

type SyncSharingReviewProps = {
  items: SyncSharingReviewItem[];
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
          {item.shareableCount} share by default · {item.privateCount} marked Only me · {item.scopeLabel}
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

export function SyncSharingReview({ items, onReview }: SyncSharingReviewProps) {
  return (
    <>
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
