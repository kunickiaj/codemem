/**
 * Shared address normalization utilities for the sync system.
 *
 * Used by both coordinator-store and sync-discovery to ensure
 * consistent address handling across the sync pipeline.
 */

/**
 * Normalize an address to a consistent URL form.
 *
 * Uses the built-in URL constructor for consistent normalization:
 * lowercases host, strips default ports (80/443), trims trailing slashes.
 * Returns empty string for invalid/empty input.
 */
export function normalizeAddress(address: string): string {
	const value = address.trim();
	if (!value) return "";

	const withScheme = value.includes("://") ? value : `http://${value}`;

	try {
		const url = new URL(withScheme);
		if (!url.hostname) return "";
		if (url.port && (Number(url.port) <= 0 || Number(url.port) > 65535)) return "";
		return url.origin + url.pathname.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

/**
 * Produce a dedup key for an address (strips http scheme for comparison).
 */
export function addressDedupeKey(address: string): string {
	if (!address) return "";
	try {
		const url = new URL(address);
		const host = url.hostname.toLowerCase();
		if (host && url.port) return `${host}:${url.port}`;
		if (host) return host;
	} catch {
		// Not parseable
	}
	return address;
}

/**
 * Merge two address lists, normalizing and deduplicating.
 * Existing addresses come first, then new candidates.
 */
export function mergeAddresses(existing: string[], candidates: string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const address of [...existing, ...candidates]) {
		const cleaned = normalizeAddress(address);
		const key = addressDedupeKey(cleaned);
		if (!cleaned || seen.has(key)) continue;
		seen.add(key);
		normalized.push(cleaned);
	}
	return normalized;
}
