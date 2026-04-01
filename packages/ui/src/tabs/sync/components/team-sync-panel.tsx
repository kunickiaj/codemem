import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { UiSyncAttentionItem } from '../view-model';

export interface TeamSyncStatusSummary {
  badgeClassName: string;
  presenceLabel: string;
  metricsText: string;
}

export interface TeamSyncDiscoveredRow {
  actionMessage: string | null;
  actionLabel: string | null;
  approvalBadgeLabel: string | null;
  availabilityLabel: string;
  deviceId: string;
  displayName: string;
  displayTitle: string | null;
  fingerprint: string;
  mode: 'accept' | 'ambiguous' | 'conflict' | 'none' | 'paired' | 'scope-pending' | 'stale';
  note: string;
  pairedMessage: string | null;
  connectionLabel: string;
}

export interface TeamSyncPendingJoinRequest {
  displayName: string;
  requestId: string;
}

type TeamSyncPanelProps = {
  actionItems: UiSyncAttentionItem[];
  children?: ComponentChildren;
  discoveredListMount: HTMLElement | null;
  discoveredRows: TeamSyncDiscoveredRow[];
  joinRequestsMount: HTMLElement | null;
  listMount: HTMLElement;
  onApproveJoinRequest: (request: TeamSyncPendingJoinRequest) => Promise<void>;
  onAttentionAction: (item: UiSyncAttentionItem) => Promise<void>;
  onDenyJoinRequest: (request: TeamSyncPendingJoinRequest) => Promise<void>;
  onInspectConflict: (row: TeamSyncDiscoveredRow) => void;
  onRemoveConflict: (row: TeamSyncDiscoveredRow) => Promise<void>;
  onReviewDiscoveredDevice: (row: TeamSyncDiscoveredRow) => Promise<void>;
  pendingJoinRequests: TeamSyncPendingJoinRequest[];
  presenceStatus: string;
  statusSummary: TeamSyncStatusSummary;
};

function AttentionRow({
  item,
  onAction,
}: {
  item: UiSyncAttentionItem;
  onAction: (item: UiSyncAttentionItem) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="sync-action">
      <div className="sync-action-text">
        {item.title}
        <span className="sync-action-command">{item.summary}</span>
      </div>
      <button
        type="button"
        className="settings-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onAction(item);
          } finally {
            setBusy(false);
          }
        }}
      >
        {item.actionLabel || 'Review'}
      </button>
    </div>
  );
}


function PendingJoinRequestRow({
  request,
  onApprove,
  onDeny,
}: {
  request: TeamSyncPendingJoinRequest;
  onApprove: (request: TeamSyncPendingJoinRequest) => Promise<void>;
  onDeny: (request: TeamSyncPendingJoinRequest) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<'approve' | 'deny' | null>(null);
  const [approveLabel, setApproveLabel] = useState('Approve');
  const [denyLabel, setDenyLabel] = useState('Deny');

  return (
    <div className="actor-row">
      <div className="actor-details">
        <div className="actor-title">{request.displayName}</div>
        <div className="peer-meta">request: {request.requestId}</div>
      </div>
      <div className="actor-actions">
        <button
          type="button"
          className="settings-button"
          disabled={busyAction !== null}
          onClick={async () => {
            setBusyAction('approve');
            setApproveLabel('Approving…');
            try {
              await onApprove(request);
              setApproveLabel('Approve');
            } catch {
              setApproveLabel('Retry');
            } finally {
              setBusyAction(null);
            }
          }}
        >
          {approveLabel}
        </button>
        <button
          type="button"
          className="settings-button"
          disabled={busyAction !== null}
          onClick={async () => {
            setBusyAction('deny');
            setDenyLabel('Denying…');
            try {
              await onDeny(request);
              setDenyLabel('Deny');
            } catch {
              setDenyLabel('Retry deny');
            } finally {
              setBusyAction(null);
            }
          }}
        >
          {denyLabel}
        </button>
      </div>
    </div>
  );
}

function DiscoveredDeviceRow({
  row,
  onInspectConflict,
  onRemoveConflict,
  onReview,
}: {
  row: TeamSyncDiscoveredRow;
  onInspectConflict: (row: TeamSyncDiscoveredRow) => void;
  onRemoveConflict: (row: TeamSyncDiscoveredRow) => Promise<void>;
  onReview: (row: TeamSyncDiscoveredRow) => Promise<void>;
}) {
  const [busy, setBusy] = useState<'remove' | 'review' | null>(null);
  const [reviewLabel, setReviewLabel] = useState(row.actionLabel || 'Review device');
  const [removeLabel, setRemoveLabel] = useState('Remove broken device record');

  return (
    <div className="actor-row" data-discovered-device-id={row.deviceId}>
      <div className="actor-details">
        <div className="actor-title">
          <strong title={row.displayTitle || undefined}>{row.displayName}</strong>
          <span className={`badge actor-badge${row.availabilityLabel === 'Offline' ? '' : ' local'}`}>
            {row.availabilityLabel}
          </span>
          <span className="badge actor-badge">{row.connectionLabel}</span>
          {row.approvalBadgeLabel ? (
            <span className="badge actor-badge">{row.approvalBadgeLabel}</span>
          ) : null}
        </div>
        <div className="peer-meta">{row.note}</div>
      </div>
      <div className="actor-actions">
        {row.mode === 'accept' ? (
          <button
            type="button"
            className="settings-button"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('review');
              setReviewLabel('Opening…');
              try {
                await onReview(row);
                setReviewLabel(row.actionLabel || 'Review device');
              } catch {
                setReviewLabel('Retry review');
              } finally {
                setBusy(null);
              }
            }}
          >
            {reviewLabel}
          </button>
        ) : null}
        {row.mode === 'stale' || row.mode === 'ambiguous' || row.mode === 'scope-pending' ? (
          <div className="peer-meta">{row.actionMessage}</div>
        ) : null}
        {row.mode === 'paired' && row.pairedMessage ? (
          <div className="peer-meta">{row.pairedMessage}</div>
        ) : null}
        {row.mode === 'conflict' ? (
          <>
            <button
              type="button"
              className="settings-button"
              disabled={busy !== null}
              onClick={() => onInspectConflict(row)}
            >
              Open device details
            </button>
            <button
              type="button"
              className="settings-button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('remove');
                setRemoveLabel('Removing…');
                try {
                  await onRemoveConflict(row);
                  setRemoveLabel('Remove broken device record');
                } catch {
                  setRemoveLabel('Retry remove');
                } finally {
                  setBusy(null);
                }
              }}
            >
              {removeLabel}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ActionContent(props: TeamSyncPanelProps) {
  const hasAttentionItems = props.actionItems.length > 0;

  return (
    <>
      {hasAttentionItems ? <div className="sync-action-text">Needs attention</div> : null}
      {hasAttentionItems
        ? props.actionItems.slice(0, 4).map((item) => (
            <AttentionRow key={item.id} item={item} onAction={props.onAttentionAction} />
          ))
        : null}
      {!hasAttentionItems && props.presenceStatus === 'posted' ? (
        <div className="sync-action">
          <div className="sync-action-text">
            No immediate issues
            <span className="sync-action-command">
              Your devices and team records do not currently need review.
            </span>
          </div>
        </div>
      ) : null}
      {!hasAttentionItems && props.presenceStatus === 'not_enrolled' ? (
        <div className="sync-action">
          <div className="sync-action-text">
            This device still needs team enrollment
            <span className="sync-action-command">
              Import an invite or ask your admin to enroll this device before expecting sync activity here.
            </span>
          </div>
        </div>
      ) : null}
      {props.children}
    </>
  );
}

function TeamStatusPortal({
  mount,
  statusSummary,
}: {
  mount: HTMLElement;
  statusSummary: TeamSyncStatusSummary;
}) {
  return createPortal(
    <div className="sync-team-summary">
      <div className="sync-team-status-row">
        <span className="sync-team-status-label">Status</span>
        <span className={statusSummary.badgeClassName}>{statusSummary.presenceLabel}</span>
      </div>
      <div className="sync-team-metrics">{statusSummary.metricsText}</div>
    </div>,
    mount,
  );
}

function DiscoveredPortal({
  mount,
  rows,
  onInspectConflict,
  onRemoveConflict,
  onReview,
}: {
  mount: HTMLElement | null;
  rows: TeamSyncDiscoveredRow[];
  onInspectConflict: (row: TeamSyncDiscoveredRow) => void;
  onRemoveConflict: (row: TeamSyncDiscoveredRow) => Promise<void>;
  onReview: (row: TeamSyncDiscoveredRow) => Promise<void>;
}) {
  if (!mount) return null;
  return createPortal(
    <>
      {rows.map((row) => (
        <DiscoveredDeviceRow
          key={row.deviceId}
          row={row}
          onInspectConflict={onInspectConflict}
          onRemoveConflict={onRemoveConflict}
          onReview={onReview}
        />
      ))}
    </>,
    mount,
  );
}

function PendingRequestsPortal({
  mount,
  requests,
  onApprove,
  onDeny,
}: {
  mount: HTMLElement | null;
  requests: TeamSyncPendingJoinRequest[];
  onApprove: (request: TeamSyncPendingJoinRequest) => Promise<void>;
  onDeny: (request: TeamSyncPendingJoinRequest) => Promise<void>;
}) {
  if (!mount || !requests.length) return null;
  return createPortal(
    <>
      <div className="peer-meta">
        {requests.length} pending join request{requests.length === 1 ? '' : 's'}
      </div>
      {requests.map((request) => (
        <PendingJoinRequestRow
          key={request.requestId}
          request={request}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      ))}
    </>,
    mount,
  );
}

export function TeamSyncPanel(props: TeamSyncPanelProps) {
  return (
    <>
      <ActionContent {...props} />
      <TeamStatusPortal mount={props.listMount} statusSummary={props.statusSummary} />
      <PendingRequestsPortal
        mount={props.joinRequestsMount}
        requests={props.pendingJoinRequests}
        onApprove={props.onApproveJoinRequest}
        onDeny={props.onDenyJoinRequest}
      />
      <DiscoveredPortal
        mount={props.discoveredListMount}
        rows={props.discoveredRows}
        onInspectConflict={props.onInspectConflict}
        onRemoveConflict={props.onRemoveConflict}
        onReview={props.onReviewDiscoveredDevice}
      />
    </>
  );
}
