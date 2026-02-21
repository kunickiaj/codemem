/* Health tab — system health, stats, session overview. */

import { el, copyToClipboard } from '../lib/dom';
import {
  formatAgeShort,
  formatMultiplier,
  formatPercent,
  formatReductionPercent,
  formatTimestamp,
  parsePercentValue,
  secondsSince,
  titleCase,
} from '../lib/format';
import { state, isDetailsOpen, setDetailsOpen } from '../lib/state';
import * as api from '../lib/api';

type HealthAction = {
  label: string;
  command: string;
  /** If set, show an actionable button that triggers this async function. */
  action?: () => Promise<void>;
  actionLabel?: string;
};

/* ── Health card builder ─────────────────────────────────── */

type HealthCardInput = {
  label: string;
  value: any;
  detail?: string;
  icon?: string;
  className?: string;
  title?: string;
};

function buildHealthCard({ label, value, detail, icon, className, title }: HealthCardInput): HTMLElement {
  const card = el('div', `stat${className ? ` ${className}` : ''}`);
  if (title) { (card as any).title = title; (card as any).style.cursor = 'help'; }
  if (icon) {
    const iconNode = document.createElement('i');
    iconNode.setAttribute('data-lucide', icon);
    iconNode.className = 'stat-icon';
    card.appendChild(iconNode);
  }
  const content = el('div', 'stat-content');
  content.append(el('div', 'value', value), el('div', 'label', label));
  if (detail) content.appendChild(el('div', 'small', detail));
  card.appendChild(content);
  return card;
}

function renderActionList(container: HTMLElement | null, actions: HealthAction[]) {
  if (!container) return;
  container.textContent = '';
  if (!actions.length) { (container as any).hidden = true; return; }
  (container as any).hidden = false;
  actions.slice(0, 3).forEach((item) => {
    const row = el('div', 'health-action');
    const textWrap = el('div', 'health-action-text');
    textWrap.textContent = item.label;
    if (item.command) textWrap.appendChild(el('span', 'health-action-command', item.command));
    const btnWrap = el('div', 'health-action-buttons');
    if (item.action) {
      const actionBtn = el('button', 'settings-button', item.actionLabel || 'Run') as HTMLButtonElement;
      actionBtn.addEventListener('click', async () => {
        actionBtn.disabled = true;
        actionBtn.textContent = 'Running…';
        try { await item.action!(); } catch {}
        actionBtn.disabled = false;
        actionBtn.textContent = item.actionLabel || 'Run';
      });
      btnWrap.appendChild(actionBtn);
    }
    if (item.command) {
      const copyBtn = el('button', 'settings-button health-action-copy', 'Copy') as HTMLButtonElement;
      copyBtn.addEventListener('click', () => copyToClipboard(item.command, copyBtn));
      btnWrap.appendChild(copyBtn);
    }
    row.append(textWrap, btnWrap);
    container.appendChild(row);
  });
}

/* ── Health overview renderer ────────────────────────────── */

export function renderHealthOverview() {
  const healthGrid = document.getElementById('healthGrid');
  const healthMeta = document.getElementById('healthMeta');
  const healthActions = document.getElementById('healthActions');
  const healthDot = document.getElementById('healthDot');
  if (!healthGrid || !healthMeta) return;
  healthGrid.textContent = '';

  const stats = state.lastStatsPayload || {};
  const usagePayload = state.lastUsagePayload || {};
  const raw = state.lastRawEventsPayload && typeof state.lastRawEventsPayload === 'object' ? state.lastRawEventsPayload : {};
  const syncStatus = state.lastSyncStatus || {};
  const reliability = stats.reliability || {};
  const counts = reliability.counts || {};
  const rates = reliability.rates || {};
  const dbStats = stats.database || {};
  const totals = usagePayload.totals_filtered || usagePayload.totals || usagePayload.totals_global || stats.usage?.totals || {};
  const recentPacks = Array.isArray(usagePayload.recent_packs) ? usagePayload.recent_packs : [];
  const lastPackAt = recentPacks.length ? recentPacks[0]?.created_at : null;
  const rawPending = Number(raw.pending || 0);
  const erroredBatches = Number(counts.errored_batches || 0);
  const flushSuccessRate = Number(rates.flush_success_rate ?? 1);
  const droppedRate = Number(rates.dropped_event_rate || 0);
  const reductionLabel = formatReductionPercent(totals.tokens_saved, totals.tokens_read);
  const reductionPercent = parsePercentValue(reductionLabel);
  const tagCoverage = Number(dbStats.tags_coverage || 0);
  const syncState = String(syncStatus.daemon_state || 'unknown');
  const syncStateLabel = syncState === 'offline-peers' ? 'Offline peers' : titleCase(syncState);
  const peerCount = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers.length : 0;
  const syncDisabled = syncState === 'disabled' || syncStatus.enabled === false;
  const syncOfflinePeers = syncState === 'offline-peers';
  const syncNoPeers = !syncDisabled && peerCount === 0;
  const syncCardValue = syncDisabled ? 'Disabled' : syncNoPeers ? 'No peers' : syncStateLabel;
  const lastSyncAt = syncStatus.last_sync_at || syncStatus.last_sync_at_utc || null;
  const syncAgeSeconds = secondsSince(lastSyncAt);
  const packAgeSeconds = secondsSince(lastPackAt);
  const syncLooksStale = syncAgeSeconds !== null && syncAgeSeconds > 7200;
  const hasBacklog = rawPending >= 200;

  // Risk scoring
  let riskScore = 0;
  const drivers: string[] = [];
  if (rawPending >= 1000) { riskScore += 40; drivers.push('high raw-event backlog'); }
  else if (rawPending >= 200) { riskScore += 24; drivers.push('growing raw-event backlog'); }
  if (erroredBatches > 0 && rawPending >= 200) { riskScore += erroredBatches >= 5 ? 10 : 6; drivers.push('batch errors during backlog pressure'); }
  if (flushSuccessRate < 0.95) { riskScore += 20; drivers.push('lower flush success'); }
  if (droppedRate > 0.02) { riskScore += 24; drivers.push('high dropped-event rate'); }
  else if (droppedRate > 0.005) { riskScore += 10; drivers.push('non-trivial dropped-event rate'); }
  if (!syncDisabled && !syncNoPeers) {
    if (syncState === 'error') { riskScore += 36; drivers.push('sync daemon reports errors'); }
    else if (syncState === 'stopped') { riskScore += 22; drivers.push('sync daemon stopped'); }
    else if (syncState === 'degraded') { riskScore += 20; drivers.push('sync daemon degraded'); }
    if (syncOfflinePeers) { riskScore += 4; drivers.push('all peers currently offline'); if (syncLooksStale) { riskScore += 4; drivers.push('offline peers and sync not recent'); } }
    else { if (syncLooksStale) { riskScore += 26; drivers.push('sync looks stale'); } else if (syncAgeSeconds !== null && syncAgeSeconds > 1800) { riskScore += 12; drivers.push('sync not recent'); } }
  }
  if (reductionPercent !== null && reductionPercent < 10) { riskScore += 8; drivers.push('low retrieval reduction'); }
  if (packAgeSeconds !== null && packAgeSeconds > 86400) { riskScore += 12; drivers.push('memory pack activity is old'); }

  let statusLabel = 'Healthy';
  let statusClass = 'status-healthy';
  if (riskScore >= 60) { statusLabel = 'Attention'; statusClass = 'status-attention'; }
  else if (riskScore >= 25) { statusLabel = 'Degraded'; statusClass = 'status-degraded'; }

  // Update header health dot
  if (healthDot) {
    healthDot.className = `health-dot ${statusClass}`;
    healthDot.title = statusLabel;
  }

  const retrievalDetail = `${Number(totals.tokens_saved || 0).toLocaleString()} saved tokens`;
  const pipelineDetail = rawPending > 0 ? 'Queue is actively draining' : 'Queue is clear';
  const syncDetail = syncDisabled ? 'Sync disabled' : syncNoPeers ? 'No peers configured'
    : syncOfflinePeers ? `${peerCount} peers offline · last sync ${formatAgeShort(syncAgeSeconds)} ago`
    : `${peerCount} peers · last sync ${formatAgeShort(syncAgeSeconds)} ago`;
  const freshnessDetail = `last pack ${formatAgeShort(packAgeSeconds)} ago`;

  const cards = [
    buildHealthCard({ label: 'Overall health', value: statusLabel, detail: `Weighted score ${riskScore}`, icon: 'heart-pulse', className: `health-primary ${statusClass}`, title: drivers.length ? `Main signals: ${drivers.join(', ')}` : 'No major risk signals detected' }),
    buildHealthCard({ label: 'Pipeline health', value: `${rawPending.toLocaleString()} pending`, detail: pipelineDetail, icon: 'workflow', title: 'Raw-event queue pressure and flush reliability' }),
    buildHealthCard({ label: 'Retrieval impact', value: reductionLabel, detail: retrievalDetail, icon: 'sparkles', title: 'Reduction from memory reuse across recent usage' }),
    buildHealthCard({ label: 'Sync health', value: syncCardValue, detail: syncDetail, icon: 'refresh-cw', title: 'Daemon state and sync recency' }),
    buildHealthCard({ label: 'Data freshness', value: formatAgeShort(packAgeSeconds), detail: freshnessDetail, icon: 'clock-3', title: 'Recency of last memory pack activity' }),
  ];
  cards.forEach((c) => healthGrid.appendChild(c));

  // Recommendations
  const triggerSync = () => api.triggerSync();
  const recommendations: HealthAction[] = [];
  if (hasBacklog) {
    recommendations.push({ label: 'Pipeline needs attention. Check queue health first.', command: 'uv run codemem raw-events-status' });
    recommendations.push({ label: 'Then retry failed batches for impacted sessions.', command: 'uv run codemem raw-events-retry <opencode_session_id>' });
  } else if (syncState === 'stopped') {
    recommendations.push({ label: 'Sync daemon is stopped. Start the background service.', command: 'uv run codemem sync start' });
  } else if (!syncDisabled && !syncNoPeers && (syncState === 'error' || syncState === 'degraded')) {
    recommendations.push({ label: 'Sync is unhealthy. Restart and run one immediate pass.', command: 'uv run codemem sync restart', action: triggerSync, actionLabel: 'Sync now' });
    recommendations.push({ label: 'Then run doctor to see root cause details.', command: 'uv run codemem sync doctor' });
  } else if (!syncDisabled && !syncNoPeers && syncLooksStale) {
    recommendations.push({ label: 'Sync is stale. Run one immediate sync pass.', command: 'uv run codemem sync once', action: triggerSync, actionLabel: 'Sync now' });
  }
  if (tagCoverage > 0 && tagCoverage < 0.7 && recommendations.length < 2) {
    recommendations.push({ label: 'Tag coverage is low. Preview backfill impact.', command: 'uv run codemem backfill-tags --dry-run' });
  }
  renderActionList(healthActions, recommendations);

  healthMeta.textContent = drivers.length
    ? `Why this status: ${drivers.join(', ')}.`
    : 'Healthy right now. Diagnostics stay available if you want details.';

  if (typeof (globalThis as any).lucide !== 'undefined') (globalThis as any).lucide.createIcons();
}

/* ── Stats renderer ──────────────────────────────────────── */

export function renderStats() {
  const statsGrid = document.getElementById('statsGrid');
  const metaLine = document.getElementById('metaLine');
  if (!statsGrid) return;

  const stats = state.lastStatsPayload || {};
  const usagePayload = state.lastUsagePayload || {};
  const raw = state.lastRawEventsPayload && typeof state.lastRawEventsPayload === 'object' ? state.lastRawEventsPayload : {};
  const db = stats.database || {};
  const project = state.currentProject;
  const totalsGlobal = usagePayload?.totals_global || usagePayload?.totals || stats.usage?.totals || {};
  const totalsFiltered = usagePayload?.totals_filtered || null;
  const isFiltered = !!(project && totalsFiltered);
  const usage = isFiltered ? totalsFiltered : totalsGlobal;
  const rawSessions = Number(raw.sessions || 0);
  const rawPending = Number(raw.pending || 0);

  const globalLineWork = isFiltered ? `\nGlobal: ${Number(totalsGlobal.work_investment_tokens || 0).toLocaleString()} invested` : '';
  const globalLineRead = isFiltered ? `\nGlobal: ${Number(totalsGlobal.tokens_read || 0).toLocaleString()} read` : '';
  const globalLineSaved = isFiltered ? `\nGlobal: ${Number(totalsGlobal.tokens_saved || 0).toLocaleString()} saved` : '';

  const items: Array<{ label: string; value: any; icon: string; tooltip?: string }> = [
    { label: isFiltered ? 'Savings (project)' : 'Savings', value: Number(usage.tokens_saved || 0), tooltip: 'Tokens saved by reusing compressed memories' + globalLineSaved, icon: 'trending-up' },
    { label: isFiltered ? 'Injected (project)' : 'Injected', value: Number(usage.tokens_read || 0), tooltip: 'Tokens injected into context (pack size)' + globalLineRead, icon: 'book-open' },
    { label: isFiltered ? 'Reduction (project)' : 'Reduction', value: formatReductionPercent(usage.tokens_saved, usage.tokens_read), tooltip: `Percent reduction from reuse. Factor: ${formatMultiplier(usage.tokens_saved, usage.tokens_read)}.` + globalLineRead + globalLineSaved, icon: 'percent' },
    { label: isFiltered ? 'Work investment (project)' : 'Work investment', value: Number(usage.work_investment_tokens || 0), tooltip: 'Token cost of unique discovery groups' + globalLineWork, icon: 'pencil' },
    { label: 'Active memories', value: db.active_memory_items || 0, icon: 'check-circle' },
    { label: 'Embedding coverage', value: formatPercent(db.vector_coverage), tooltip: 'Share of active memories with embeddings', icon: 'layers' },
    { label: 'Tag coverage', value: formatPercent(db.tags_coverage), tooltip: 'Share of active memories with tags', icon: 'tag' },
  ];
  if (rawPending > 0) items.push({ label: 'Raw events pending', value: rawPending, tooltip: 'Pending raw events waiting to be flushed', icon: 'activity' });
  else if (rawSessions > 0) items.push({ label: 'Raw sessions', value: rawSessions, tooltip: 'Sessions with pending raw events', icon: 'inbox' });

  statsGrid.textContent = '';
  items.forEach((item) => {
    const stat = el('div', 'stat');
    if (item.tooltip) { (stat as any).title = item.tooltip; (stat as any).style.cursor = 'help'; }
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', item.icon);
    icon.className = 'stat-icon';
    const content = el('div', 'stat-content');
    const displayValue = typeof item.value === 'number' ? item.value.toLocaleString() : item.value == null ? 'n/a' : String(item.value);
    content.append(el('div', 'value', displayValue), el('div', 'label', item.label));
    stat.append(icon, content);
    statsGrid.appendChild(stat);
  });

  if (metaLine) {
    const projectSuffix = project ? ` · project: ${project}` : '';
    metaLine.textContent = `DB: ${db.path || 'unknown'} · ${Math.round((db.size_bytes || 0) / 1024)} KB${projectSuffix}`;
  }
  if (typeof (globalThis as any).lucide !== 'undefined') (globalThis as any).lucide.createIcons();
}

/* ── Session summary renderer ────────────────────────────── */

export function renderSessionSummary() {
  const sessionGrid = document.getElementById('sessionGrid');
  const sessionMeta = document.getElementById('sessionMeta');
  if (!sessionGrid || !sessionMeta) return;
  sessionGrid.textContent = '';

  const usagePayload = state.lastUsagePayload || {};
  const project = state.currentProject;
  const totalsGlobal = usagePayload?.totals_global || usagePayload?.totals || {};
  const totalsFiltered = usagePayload?.totals_filtered || null;
  const isFiltered = !!(project && totalsFiltered);

  const events = Array.isArray(usagePayload?.events) ? usagePayload.events : [];
  const packEvent = events.find((e: any) => e?.event === 'pack') || null;
  const recentPacks = Array.isArray(usagePayload?.recent_packs) ? usagePayload.recent_packs : [];
  const latestPack = recentPacks.length ? recentPacks[0] : null;
  const lastPackAt = latestPack?.created_at || '';
  const packCount = Number(packEvent?.count || 0);
  const packTokens = Number(latestPack?.tokens_read || 0);
  const savedTokens = Number(latestPack?.tokens_saved || 0);
  const reductionPercent = formatReductionPercent(savedTokens, packTokens);

  const packLine = packCount ? `${packCount} packs` : 'No packs yet';
  const lastPackLine = lastPackAt ? `Last pack: ${formatTimestamp(lastPackAt)}` : '';
  const scopeLabel = isFiltered ? 'Project' : 'All projects';
  sessionMeta.textContent = [scopeLabel, packLine, lastPackLine].filter(Boolean).join(' · ');

  const items = [
    { label: 'Last pack savings', value: latestPack ? `${savedTokens.toLocaleString()} (${reductionPercent})` : 'n/a', icon: 'trending-up' },
    { label: 'Last pack size', value: latestPack ? packTokens.toLocaleString() : 'n/a', icon: 'package' },
    { label: 'Packs', value: packCount || 0, icon: 'archive' },
  ];

  items.forEach((item) => {
    const block = el('div', 'stat');
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', item.icon);
    icon.className = 'stat-icon';
    const displayValue = typeof item.value === 'number' ? item.value.toLocaleString() : item.value == null ? 'n/a' : String(item.value);
    const content = el('div', 'stat-content');
    content.append(el('div', 'value', displayValue), el('div', 'label', item.label));
    block.append(icon, content);
    sessionGrid.appendChild(block);
  });

  if (typeof (globalThis as any).lucide !== 'undefined') (globalThis as any).lucide.createIcons();
}

/* ── Data loading ────────────────────────────────────────── */

export async function loadHealthData() {
  const [statsPayload, usagePayload, sessionsPayload, rawEventsPayload] = await Promise.all([
    api.loadStats(),
    api.loadUsage(state.currentProject),
    api.loadSession(state.currentProject),
    api.loadRawEvents(state.currentProject),
  ]);

  state.lastStatsPayload = statsPayload || {};
  state.lastUsagePayload = usagePayload || {};
  state.lastRawEventsPayload = rawEventsPayload || {};

  renderStats();
  renderSessionSummary();
  renderHealthOverview();
}

/* ── Init ────────────────────────────────────────────────── */

export function initHealthTab() {
  // No special init needed beyond data loading.
}
