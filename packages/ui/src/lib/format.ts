/* Formatting utilities — dates, numbers, text normalization. */

export function formatDate(value: unknown): string {
	if (!value) return "n/a";
	const date = new Date(value as string | number | Date);
	return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function formatTimestamp(value: unknown): string {
	if (!value) return "never";
	const date = new Date(value as string | number | Date);
	if (Number.isNaN(date.getTime())) return String(value);
	return date.toLocaleString();
}

export function formatRelativeTime(value: unknown): string {
	if (!value) return "n/a";
	const date = new Date(value as string | number | Date);
	const ms = date.getTime();
	if (Number.isNaN(ms)) return String(value);
	const diff = Date.now() - ms;
	const seconds = Math.round(diff / 1000);
	if (seconds < 10) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 14) return `${days}d ago`;
	return date.toLocaleDateString();
}

export function secondsSince(value: unknown): number | null {
	if (!value) return null;
	const ts = new Date(value as string | number | Date).getTime();
	if (!Number.isFinite(ts)) return null;
	const delta = Math.floor((Date.now() - ts) / 1e3);
	return delta >= 0 ? delta : 0;
}

export function formatAgeShort(seconds: number | null): string {
	if (seconds === null || seconds === undefined) return "n/a";
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

export function formatPercent(value: unknown): string {
	const num = Number(value);
	if (!Number.isFinite(num)) return "n/a";
	return `${Math.round(num * 100)}%`;
}

export function formatMultiplier(saved: unknown, read: unknown): string {
	const savedNum = Number(saved || 0);
	const readNum = Number(read || 0);
	if (!Number.isFinite(savedNum) || !Number.isFinite(readNum) || readNum <= 0) return "n/a";
	const factor = (savedNum + readNum) / readNum;
	if (!Number.isFinite(factor) || factor <= 0) return "n/a";
	return `${factor.toFixed(factor >= 10 ? 0 : 1)}x`;
}

export function formatReductionPercent(saved: unknown, read: unknown): string {
	const savedNum = Number(saved || 0);
	const readNum = Number(read || 0);
	if (!Number.isFinite(savedNum) || !Number.isFinite(readNum)) return "n/a";
	const total = savedNum + readNum;
	if (total <= 0) return "n/a";
	const pct = savedNum / total;
	if (!Number.isFinite(pct)) return "n/a";
	return `${Math.round(pct * 100)}%`;
}

export function formatTokenCount(value: unknown): string {
	const num = Number(value || 0);
	if (!Number.isFinite(num)) return "n/a";
	const units = [
		{ threshold: 1_000_000_000, suffix: "B" },
		{ threshold: 1_000_000, suffix: "M" },
		{ threshold: 1_000, suffix: "K" },
	] as const;
	let unitIndex = units.findIndex(({ threshold }) => Math.abs(num) >= threshold);
	if (unitIndex === -1) return `${num.toLocaleString()} tokens`;
	while (unitIndex >= 0) {
		const { suffix, threshold } = units[unitIndex];
		const scaled = num / threshold;
		const roundedNumber = Number(scaled.toFixed(scaled >= 10 ? 0 : 1));
		if (Math.abs(roundedNumber) < 1000 || unitIndex === 0) {
			const roundedText = roundedNumber.toString().replace(/\.0$/, "");
			return `${roundedText}${suffix} tokens`;
		}
		unitIndex -= 1;
	}
	return `${num.toLocaleString()} tokens`;
}

export function parsePercentValue(label: unknown): number | null {
	const text = String(label || "").trim();
	if (!text.endsWith("%")) return null;
	const raw = Number(text.replace("%", ""));
	if (!Number.isFinite(raw)) return null;
	return raw;
}

export function normalize(text: unknown): string {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export function parseJsonArray(value: unknown): unknown[] {
	if (!value) return [];
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

export function titleCase(value: unknown): string {
	const text = String(value || "").trim();
	if (!text) return "Unknown";
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function toTitleLabel(value: string): string {
	return value
		.replace(/_/g, " ")
		.split(" ")
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ")
		.trim();
}

export function formatFileList(files: unknown[], limit = 2): string {
	if (!files.length) return "";
	const trimmed = files.map((f) => String(f).trim()).filter(Boolean);
	const slice = trimmed.slice(0, limit);
	const suffix = trimmed.length > limit ? ` +${trimmed.length - limit}` : "";
	return `${slice.join(", ")}${suffix}`.trim();
}

export function formatTagLabel(tag: unknown): string {
	if (!tag) return "";
	const trimmed = String(tag).trim();
	const colonIndex = trimmed.indexOf(":");
	if (colonIndex === -1) return trimmed;
	return trimmed.slice(0, colonIndex).trim();
}
