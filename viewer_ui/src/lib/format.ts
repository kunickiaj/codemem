/* Formatting utilities — dates, numbers, text normalization. */

export function formatDate(value: any): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function formatTimestamp(value: any): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export function formatRelativeTime(value: any): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return String(value);
  const diff = Date.now() - ms;
  const seconds = Math.round(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function secondsSince(value: any): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  const delta = Math.floor((Date.now() - ts) / 1e3);
  return delta >= 0 ? delta : 0;
}

export function formatAgeShort(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return 'n/a';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function formatPercent(value: any): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'n/a';
  return `${Math.round(num * 100)}%`;
}

export function formatMultiplier(saved: any, read: any): string {
  const savedNum = Number(saved || 0);
  const readNum = Number(read || 0);
  if (!Number.isFinite(savedNum) || !Number.isFinite(readNum) || readNum <= 0) return 'n/a';
  const factor = (savedNum + readNum) / readNum;
  if (!Number.isFinite(factor) || factor <= 0) return 'n/a';
  return `${factor.toFixed(factor >= 10 ? 0 : 1)}x`;
}

export function formatReductionPercent(saved: any, read: any): string {
  const savedNum = Number(saved || 0);
  const readNum = Number(read || 0);
  if (!Number.isFinite(savedNum) || !Number.isFinite(readNum)) return 'n/a';
  const total = savedNum + readNum;
  if (total <= 0) return 'n/a';
  const pct = savedNum / total;
  if (!Number.isFinite(pct)) return 'n/a';
  return `${Math.round(pct * 100)}%`;
}

export function parsePercentValue(label: any): number | null {
  const text = String(label || '').trim();
  if (!text.endsWith('%')) return null;
  const raw = Number(text.replace('%', ''));
  if (!Number.isFinite(raw)) return null;
  return raw;
}

export function normalize(text: any): string {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function parseJsonArray(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function titleCase(value: any): string {
  const text = String(value || '').trim();
  if (!text) return 'Unknown';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function toTitleLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ')
    .trim();
}

export function formatFileList(files: any[], limit = 2): string {
  if (!files.length) return '';
  const trimmed = files.map((f) => String(f).trim()).filter(Boolean);
  const slice = trimmed.slice(0, limit);
  const suffix = trimmed.length > limit ? ` +${trimmed.length - limit}` : '';
  return `${slice.join(', ')}${suffix}`.trim();
}

export function formatTagLabel(tag: any): string {
  if (!tag) return '';
  const trimmed = String(tag).trim();
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) return trimmed;
  return trimmed.slice(0, colonIndex).trim();
}
