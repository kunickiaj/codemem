/* Feed tab — memory feed rendering, filtering, search. */

import { el, highlightText } from '../lib/dom';
import {
  formatDate,
  formatFileList,
  formatRelativeTime,
  formatTagLabel,
  normalize,
  parseJsonArray,
  toTitleLabel,
} from '../lib/format';
import { state, setFeedTypeFilter, FEED_FILTERS, type FeedFilter } from '../lib/state';
import * as api from '../lib/api';

/* ── Helpers ─────────────────────────────────────────────── */

function mergeMetadata(metadata: any): any {
  if (!metadata || typeof metadata !== 'object') return {};
  const importMeta = metadata.import_metadata;
  if (importMeta && typeof importMeta === 'object') {
    return { ...importMeta, ...metadata };
  }
  return metadata;
}

function extractFactsFromBody(text: any): string[] {
  if (!text) return [];
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[-*\u2022]\s+/.test(l) || /^\d+\./.test(l));
  if (!bullets.length) return [];
  return bullets.map((l) => l.replace(/^[-*\u2022]\s+/, '').replace(/^\d+\.\s+/, ''));
}

function sentenceFacts(text: string, limit = 6): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const parts = collapsed.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  const facts: string[] = [];
  for (const part of parts) {
    if (part.length < 18) continue;
    facts.push(part);
    if (facts.length >= limit) break;
  }
  return facts;
}

function isLowSignalObservation(item: any): boolean {
  const title = normalize(item.title);
  const body = normalize(item.body_text);
  if (!title && !body) return true;
  const combined = body || title;
  if (combined.length < 10) return true;
  if (title && body && title === body && combined.length < 40) return true;
  const lead = title.charAt(0);
  if ((lead === '\u2514' || lead === '\u203a') && combined.length < 40) return true;
  if (title.startsWith('list ') && combined.length < 20) return true;
  if (combined === 'ls' || combined === 'list ls') return true;
  return false;
}

function itemSignature(item: any): string {
  return String(item.id ?? item.memory_id ?? item.observation_id ?? item.session_id ?? item.created_at_utc ?? item.created_at ?? '');
}

function itemKey(item: any): string {
  return `${String(item.kind || '').toLowerCase()}:${itemSignature(item)}`;
}

type ItemViewMode = 'summary' | 'facts' | 'narrative';

const OBSERVATION_PAGE_SIZE = 20;
const SUMMARY_PAGE_SIZE = 50;
const FEED_SCROLL_THRESHOLD_PX = 560;

let lastFeedProject = '';
let observationOffset = 0;
let summaryOffset = 0;
let observationHasMore = true;
let summaryHasMore = true;
let loadMoreInFlight = false;
let feedScrollHandlerBound = false;

function resetPagination(project: string) {
  lastFeedProject = project;
  observationOffset = 0;
  summaryOffset = 0;
  observationHasMore = true;
  summaryHasMore = true;
}

function isNearFeedBottom(): boolean {
  const root = document.documentElement;
  const height = Math.max(root.scrollHeight, document.body.scrollHeight);
  return window.innerHeight + window.scrollY >= height - FEED_SCROLL_THRESHOLD_PX;
}

function pageHasMore(payload: any, count: number, limit: number): boolean {
  const value = payload?.pagination?.has_more;
  if (typeof value === 'boolean') return value;
  return count >= limit;
}

function pageNextOffset(payload: any, count: number): number {
  const value = payload?.pagination?.next_offset;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return count;
}

function hasMorePages(): boolean {
  return observationHasMore || summaryHasMore;
}

function mergeFeedItems(currentItems: any[], incomingItems: any[]): any[] {
  const byKey = new Map<string, any>();
  currentItems.forEach((item) => byKey.set(itemKey(item), item));
  incomingItems.forEach((item) => byKey.set(itemKey(item), item));
  return Array.from(byKey.values()).sort((a, b) => {
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
}

/* ── Summary object extraction ───────────────────────────── */

function getSummaryObject(item: any): Record<string, any> | null {
  const preferredKeys = ['request', 'outcome', 'plan', 'completed', 'learned', 'investigated', 'next', 'next_steps', 'notes'];
  const looksLikeSummary = (v: any) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    return preferredKeys.some((k) => typeof v[k] === 'string' && v[k].trim().length > 0);
  };
  if (item?.summary && typeof item.summary === 'object' && !Array.isArray(item.summary)) return item.summary;
  if (item?.summary?.summary && typeof item.summary.summary === 'object') return item.summary.summary;
  const metadata = item?.metadata_json;
  if (looksLikeSummary(metadata)) return metadata;
  if (looksLikeSummary(metadata?.summary)) return metadata.summary;
  return null;
}

function getFactsList(item: any): string[] {
  const summary = getSummaryObject(item);
  if (summary) {
    const preferred = ['request', 'outcome', 'plan', 'completed', 'learned', 'investigated', 'next', 'next_steps', 'notes'];
    const keys = Object.keys(summary);
    const remaining = keys.filter((k) => !preferred.includes(k)).sort();
    const ordered = [...preferred.filter((k) => keys.includes(k)), ...remaining];
    const facts: string[] = [];
    ordered.forEach((key) => {
      const content = String(summary[key] || '').trim();
      if (!content) return;
      const bullets = extractFactsFromBody(content);
      if (bullets.length) {
        bullets.forEach((b) => facts.push(`${toTitleLabel(key)}: ${b}`.trim()));
        return;
      }
      facts.push(`${toTitleLabel(key)}: ${content}`.trim());
    });
    return facts;
  }
  return extractFactsFromBody(String(item?.body_text || ''));
}

/* ── Observation view helpers ────────────────────────────── */

function observationViewData(item: any) {
  const metadata = mergeMetadata(item?.metadata_json);
  const summary = String(item?.subtitle || item?.body_text || '').trim();
  const narrative = String(item?.narrative || metadata?.narrative || '').trim();
  const normSummary = normalize(summary);
  const normNarrative = normalize(narrative);
  const narrativeDistinct = Boolean(narrative) && normNarrative !== normSummary;
  const explicitFacts = parseJsonArray(item?.facts || metadata?.facts || []);
  const fallbackFacts = explicitFacts.length ? explicitFacts : extractFactsFromBody(summary || narrative);
  const derivedFacts = fallbackFacts.length ? fallbackFacts : sentenceFacts(summary);
  return { summary, narrative, facts: derivedFacts, hasSummary: Boolean(summary), hasFacts: derivedFacts.length > 0, hasNarrative: narrativeDistinct };
}

function observationViewModes(data: { hasSummary: boolean; hasFacts: boolean; hasNarrative: boolean }): Array<{ id: ItemViewMode; label: string }> {
  const modes: Array<{ id: ItemViewMode; label: string }> = [];
  if (data.hasSummary) modes.push({ id: 'summary', label: 'Summary' });
  if (data.hasFacts) modes.push({ id: 'facts', label: 'Facts' });
  if (data.hasNarrative) modes.push({ id: 'narrative', label: 'Narrative' });
  return modes;
}

function defaultObservationView(data: { hasSummary: boolean; hasFacts: boolean; hasNarrative: boolean }): ItemViewMode {
  if (data.hasSummary) return 'summary';
  if (data.hasFacts) return 'facts';
  return 'narrative';
}

function shouldClampBody(mode: ItemViewMode, data: { summary: string; narrative: string }): boolean {
  if (mode === 'facts') return false;
  if (mode === 'summary') return data.summary.length > 260;
  return data.narrative.length > 320;
}

function clampClass(mode: ItemViewMode): string[] {
  return mode === 'summary' ? ['clamp', 'clamp-3'] : ['clamp', 'clamp-5'];
}

/* ── Rendering functions ─────────────────────────────────── */

function renderSummaryObject(summary: Record<string, any>): HTMLElement | null {
  const preferred = ['request', 'outcome', 'plan', 'completed', 'learned', 'investigated', 'next', 'next_steps', 'notes'];
  const keys = Object.keys(summary);
  const ordered = preferred.filter((k) => keys.includes(k));
  const container = el('div', 'feed-body facts') as HTMLDivElement;
  let wrote = false;
  ordered.forEach((key) => {
    const content = String(summary[key] || '').trim();
    if (!content) return;
    wrote = true;
    const row = el('div', 'summary-section');
    const label = el('div', 'summary-section-label', toTitleLabel(key));
    const value = el('div', 'summary-section-content');
    try { value.innerHTML = (globalThis as any).marked.parse(content); } catch { value.textContent = content; }
    row.append(label, value);
    container.appendChild(row);
  });
  return wrote ? container : null;
}

function renderFacts(facts: string[]): HTMLElement | null {
  const trimmed = facts.map((f) => String(f || '').trim()).filter(Boolean);
  if (!trimmed.length) return null;
  const container = el('div', 'feed-body');
  const list = document.createElement('ul');
  trimmed.forEach((f) => { const li = document.createElement('li'); li.textContent = f; list.appendChild(li); });
  container.appendChild(list);
  return container;
}

function renderNarrative(narrative: string): HTMLElement | null {
  const content = String(narrative || '').trim();
  if (!content) return null;
  const body = el('div', 'feed-body');
  try { body.innerHTML = (globalThis as any).marked.parse(content); } catch { body.textContent = content; }
  return body;
}

function renderObservationBody(data: { summary: string; narrative: string; facts: string[] }, mode: ItemViewMode): HTMLElement {
  if (mode === 'facts') return renderFacts(data.facts) || el('div', 'feed-body');
  if (mode === 'narrative') return renderNarrative(data.narrative) || el('div', 'feed-body');
  return renderNarrative(data.summary) || el('div', 'feed-body');
}

function renderViewToggle(modes: Array<{ id: ItemViewMode; label: string }>, active: ItemViewMode, onSelect: (mode: ItemViewMode) => void): HTMLElement | null {
  if (modes.length <= 1) return null;
  const toggle = el('div', 'feed-toggle');
  modes.forEach((mode) => {
    const btn = el('button', 'toggle-button', mode.label) as HTMLButtonElement;
    (btn as any).dataset.filter = mode.id;
    btn.classList.toggle('active', mode.id === active);
    btn.addEventListener('click', () => onSelect(mode.id));
    toggle.appendChild(btn);
  });
  return toggle;
}

function createTagChip(tag: any): HTMLElement | null {
  const display = formatTagLabel(tag);
  if (!display) return null;
  const chip = el('span', 'tag-chip', display);
  (chip as any).title = String(tag);
  return chip;
}

/* ── Feed item card renderer ─────────────────────────────── */

function renderFeedItem(item: any): HTMLElement {
  const kindValue = String(item.kind || 'session_summary').toLowerCase();
  const isSessionSummary = kindValue === 'session_summary';
  const metadata = mergeMetadata(item?.metadata_json);

  const card = el('div', `feed-item ${kindValue}`.trim());
  const rowKey = itemKey(item);
  (card as any).dataset.key = rowKey;

  if (state.newItemKeys.has(rowKey)) {
    card.classList.add('new-item');
    setTimeout(() => { card.classList.remove('new-item'); state.newItemKeys.delete(rowKey); }, 700);
  }

  // Header
  const header = el('div', 'feed-card-header');
  const titleWrap = el('div', 'feed-header');
  const defaultTitle = item.title || '(untitled)';
  const displayTitle = isSessionSummary && metadata?.request ? metadata.request : defaultTitle;
  const title = el('div', 'feed-title title');
  title.innerHTML = highlightText(displayTitle, state.feedQuery);
  const kind = el('span', `kind-pill ${kindValue}`.trim(), kindValue.replace(/_/g, ' '));
  titleWrap.append(kind, title);

  const rightWrap = el('div', 'feed-actions');
  const createdAtRaw = item.created_at || item.created_at_utc;
  const relative = formatRelativeTime(createdAtRaw);
  const age = el('div', 'small feed-age', relative);
  (age as any).title = formatDate(createdAtRaw);

  const footerRight = el('div', 'feed-footer-right');
  let bodyNode: HTMLElement = el('div', 'feed-body');

  if (isSessionSummary) {
    const summaryObj = getSummaryObject({ metadata_json: metadata });
    const rendered = summaryObj ? renderSummaryObject(summaryObj) : null;
    bodyNode = rendered || renderNarrative(String(item.body_text || '')) || bodyNode;
  } else {
    const data = observationViewData({ ...item, metadata_json: metadata });
    const modes = observationViewModes(data);
    const defaultView = defaultObservationView(data);
    const key = itemKey(item);
    const stored = state.itemViewState.get(key) as ItemViewMode | undefined;
    let activeMode: ItemViewMode = stored && modes.some((m) => m.id === stored) ? stored : defaultView;
    state.itemViewState.set(key, activeMode);

    bodyNode = renderObservationBody(data, activeMode);

    const setExpandControl = (mode: ItemViewMode) => {
      footerRight.textContent = '';
      const expandKey = `${key}:${mode}`;
      const expanded = state.itemExpandState.get(expandKey) === true;
      const canClamp = shouldClampBody(mode, data);
      if (!canClamp) return;
      const btn = el('button', 'feed-expand', expanded ? 'Collapse' : 'Expand') as HTMLButtonElement;
      btn.addEventListener('click', () => {
        const next = !(state.itemExpandState.get(expandKey) === true);
        state.itemExpandState.set(expandKey, next);
        if (next) { bodyNode.classList.remove('clamp', 'clamp-3', 'clamp-5'); btn.textContent = 'Collapse'; }
        else { bodyNode.classList.add(...clampClass(mode)); btn.textContent = 'Expand'; }
      });
      footerRight.appendChild(btn);
    };

    const expandKey = `${key}:${activeMode}`;
    const expanded = state.itemExpandState.get(expandKey) === true;
    if (shouldClampBody(activeMode, data) && !expanded) bodyNode.classList.add(...clampClass(activeMode));
    setExpandControl(activeMode);

    const toggle = renderViewToggle(modes, activeMode, (mode) => {
      activeMode = mode;
      state.itemViewState.set(key, mode);
      const nextBody = renderObservationBody(data, mode);
      const nextExpandKey = `${key}:${mode}`;
      const nextExpanded = state.itemExpandState.get(nextExpandKey) === true;
      if (shouldClampBody(mode, data) && !nextExpanded) nextBody.classList.add(...clampClass(mode));
      card.replaceChild(nextBody, bodyNode);
      bodyNode = nextBody;
      setExpandControl(mode);
      if (toggle) {
        toggle.querySelectorAll('.toggle-button').forEach((b) => {
          b.classList.toggle('active', (b as HTMLButtonElement).dataset.filter === mode);
        });
      }
    });
    if (toggle) rightWrap.appendChild(toggle);
  }

  rightWrap.appendChild(age);
  header.append(titleWrap, rightWrap);

  // Meta line
  const meta = el('div', 'feed-meta');
  const tags = parseJsonArray(item.tags || []);
  const files = parseJsonArray(item.files || []);
  const project = item.project || '';
  const tagContent = tags.length ? ` · ${tags.map((t: any) => formatTagLabel(t)).join(', ')}` : '';
  const fileContent = files.length ? ` · ${formatFileList(files)}` : '';
  meta.textContent = `${project ? `Project: ${project}` : 'Project: n/a'}${tagContent}${fileContent}`;

  // Footer
  const footer = el('div', 'feed-footer');
  const footerLeft = el('div', 'feed-footer-left');
  const filesWrap = el('div', 'feed-files');
  const tagsWrap = el('div', 'feed-tags');
  files.forEach((f: any) => filesWrap.appendChild(el('span', 'feed-file', f)));
  tags.forEach((t: any) => { const chip = createTagChip(t); if (chip) tagsWrap.appendChild(chip); });
  if (filesWrap.childElementCount) footerLeft.appendChild(filesWrap);
  if (tagsWrap.childElementCount) footerLeft.appendChild(tagsWrap);
  footer.append(footerLeft, footerRight);

  card.append(header, meta, bodyNode, footer);
  return card;
}

/* ── Filtering ───────────────────────────────────────────── */

function filterByType(items: any[]): any[] {
  if (state.feedTypeFilter === 'observations') return items.filter((i) => String(i.kind || '').toLowerCase() !== 'session_summary');
  if (state.feedTypeFilter === 'summaries') return items.filter((i) => String(i.kind || '').toLowerCase() === 'session_summary');
  return items;
}

function filterByQuery(items: any[]): any[] {
  const query = normalize(state.feedQuery);
  if (!query) return items;
  return items.filter((item) => {
    const hay = [normalize(item?.title), normalize(item?.body_text), normalize(item?.kind), parseJsonArray(item?.tags || []).map((t: any) => normalize(t)).join(' '), normalize(item?.project)].join(' ').trim();
    return hay.includes(query);
  });
}

function computeSignature(items: any[]): string {
  const parts = items.map((i) => `${itemSignature(i)}:${i.kind || ''}:${i.created_at_utc || i.created_at || ''}`);
  return `${state.feedTypeFilter}|${state.currentProject}|${parts.join('|')}`;
}

function countNewItems(nextItems: any[], currentItems: any[]): number {
  const seen = new Set(currentItems.map(itemKey));
  return nextItems.filter((i) => !seen.has(itemKey(i))).length;
}

async function loadMoreFeedPage() {
  if (loadMoreInFlight || !hasMorePages()) return;
  loadMoreInFlight = true;
  try {
    const [observations, summaries] = await Promise.all([
      observationHasMore
        ? api.loadMemoriesPage(state.currentProject, {
            limit: OBSERVATION_PAGE_SIZE,
            offset: observationOffset,
          })
        : Promise.resolve({ items: [], pagination: { has_more: false, next_offset: observationOffset } }),
      summaryHasMore
        ? api.loadSummariesPage(state.currentProject, {
            limit: SUMMARY_PAGE_SIZE,
            offset: summaryOffset,
          })
        : Promise.resolve({ items: [], pagination: { has_more: false, next_offset: summaryOffset } }),
    ]);

    const summaryItems = summaries.items || [];
    const observationItems = observations.items || [];
    const filtered = observationItems.filter((i: any) => !isLowSignalObservation(i));
    state.lastFeedFilteredCount += observationItems.length - filtered.length;

    summaryHasMore = pageHasMore(summaries, summaryItems.length, SUMMARY_PAGE_SIZE);
    observationHasMore = pageHasMore(observations, observationItems.length, OBSERVATION_PAGE_SIZE);
    summaryOffset = pageNextOffset(summaries, summaryOffset + summaryItems.length);
    observationOffset = pageNextOffset(observations, observationOffset + observationItems.length);

    const incoming = [...summaryItems, ...filtered];
    const feedItems = mergeFeedItems(state.lastFeedItems, incoming);
    const newCount = countNewItems(feedItems, state.lastFeedItems);
    if (newCount) {
      const seen = new Set(state.lastFeedItems.map(itemKey));
      feedItems.forEach((item: any) => {
        if (!seen.has(itemKey(item))) state.newItemKeys.add(itemKey(item));
      });
    }

    state.lastFeedItems = feedItems;
    updateFeedView();
  } finally {
    loadMoreInFlight = false;
  }
}

function maybeLoadMoreFeedPage() {
  if (state.activeTab !== 'feed') return;
  if (!hasMorePages()) return;
  if (!isNearFeedBottom()) return;
  void loadMoreFeedPage();
}

/* ── Public API ──────────────────────────────────────────── */

export function initFeedTab() {
  const feedTypeToggle = document.getElementById('feedTypeToggle');
  const feedSearch = document.getElementById('feedSearch') as HTMLInputElement | null;

  updateFeedTypeToggle();

  feedTypeToggle?.addEventListener('click', (e) => {
    const target = (e as any).target?.closest?.('button');
    if (!target) return;
    setFeedTypeFilter(target.dataset.filter || 'all');
    updateFeedTypeToggle();
    updateFeedView();
  });

  feedSearch?.addEventListener('input', () => {
    state.feedQuery = feedSearch.value || '';
    updateFeedView();
  });

  if (!feedScrollHandlerBound) {
    window.addEventListener('scroll', () => {
      maybeLoadMoreFeedPage();
    }, { passive: true });
    feedScrollHandlerBound = true;
  }
}

export function updateFeedTypeToggle() {
  const toggle = document.getElementById('feedTypeToggle');
  if (!toggle) return;
  toggle.querySelectorAll('.toggle-button').forEach((btn) => {
    const value = (btn as HTMLButtonElement).dataset?.filter || 'all';
    btn.classList.toggle('active', value === state.feedTypeFilter);
  });
}

export function updateFeedView() {
  const feedList = document.getElementById('feedList');
  const feedMeta = document.getElementById('feedMeta');
  if (!feedList) return;

  const scrollY = window.scrollY;
  const byType = filterByType(state.lastFeedItems);
  const visible = filterByQuery(byType);
  const filterLabel = state.feedTypeFilter === 'observations' ? ' · observations' : state.feedTypeFilter === 'summaries' ? ' · session summaries' : '';

  const sig = computeSignature(visible);
  const changed = sig !== state.lastFeedSignature;
  state.lastFeedSignature = sig;

  if (feedMeta) {
    const filteredLabel = !state.feedQuery.trim() && state.lastFeedFilteredCount ? ` · ${state.lastFeedFilteredCount} observations filtered` : '';
    const queryLabel = state.feedQuery.trim() ? ` · matching "${state.feedQuery.trim()}"` : '';
    const moreLabel = hasMorePages() ? ' · scroll for more' : '';
    feedMeta.textContent = `${visible.length} items${filterLabel}${queryLabel}${filteredLabel}${moreLabel}`;
  }

  if (changed) {
    feedList.textContent = '';
    if (!visible.length) {
      feedList.appendChild(el('div', 'small', 'No memories yet.'));
    } else {
      visible.forEach((item) => feedList.appendChild(renderFeedItem(item)));
    }
    if (typeof (globalThis as any).lucide !== 'undefined') (globalThis as any).lucide.createIcons();
  }

  window.scrollTo({ top: scrollY });
  maybeLoadMoreFeedPage();
}

export async function loadFeedData() {
  const project = state.currentProject || '';
  if (project !== lastFeedProject) {
    resetPagination(project);
  }

  const observationsLimit = Math.max(OBSERVATION_PAGE_SIZE, observationOffset || OBSERVATION_PAGE_SIZE);
  const summariesLimit = Math.max(SUMMARY_PAGE_SIZE, summaryOffset || SUMMARY_PAGE_SIZE);

  const [observations, summaries] = await Promise.all([
    api.loadMemoriesPage(project, { limit: observationsLimit, offset: 0 }),
    api.loadSummariesPage(project, { limit: summariesLimit, offset: 0 }),
  ]);

  const summaryItems = summaries.items || [];
  const observationItems = observations.items || [];
  const filtered = observationItems.filter((i: any) => !isLowSignalObservation(i));
  const filteredCount = observationItems.length - filtered.length;
  const feedItems = [...summaryItems, ...filtered].sort((a, b) => {
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });

  const newCount = countNewItems(feedItems, state.lastFeedItems);
  if (newCount) {
    const seen = new Set(state.lastFeedItems.map(itemKey));
    feedItems.forEach((item: any) => {
      if (!seen.has(itemKey(item))) state.newItemKeys.add(itemKey(item));
    });
  }

  state.pendingFeedItems = null;
  state.lastFeedItems = feedItems;
  state.lastFeedFilteredCount = filteredCount;
  summaryHasMore = pageHasMore(summaries, summaryItems.length, summariesLimit);
  observationHasMore = pageHasMore(observations, observationItems.length, observationsLimit);
  summaryOffset = pageNextOffset(summaries, summaryItems.length);
  observationOffset = pageNextOffset(observations, observationItems.length);
  updateFeedView();
}
