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
export function normalizeAddress(address: string, options?: { defaultHttpPort?: number }): string {
	const value = address.trim();
	if (!value) return "";

	const hasScheme = value.includes("://");
	const withScheme = hasScheme ? value : `http://${value}`;
	const hasExplicitDefaultHttpPort = /^http:\/\/(?:\[[^\]]+\]|[^/?#:]+):80(?:[/?#]|$)/i.test(
		withScheme,
	);

	try {
		const url = new URL(withScheme);
		if (!url.hostname) return "";
		if (url.port && (Number(url.port) <= 0 || Number(url.port) > 65535)) return "";
		if (
			!url.port &&
			!hasExplicitDefaultHttpPort &&
			url.protocol === "http:" &&
			options?.defaultHttpPort
		) {
			const port = Math.trunc(options.defaultHttpPort);
			if (port <= 0 || port > 65535) return "";
			if (port !== 80 && (!hasScheme || /^http:\/\//i.test(value))) {
				url.port = String(port);
			}
		}
		return url.origin + url.pathname.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

export function formatHostPort(host: string, port: number): string {
	const value = host.trim();
	if (!value) return "";
	const normalizedPort = Math.trunc(port);
	if (normalizedPort <= 0 || normalizedPort > 65535) return "";
	const authorityHost = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
	return `${authorityHost}:${normalizedPort}`;
}

/**
 * Produce a dedupe key for an address while preserving scheme and path.
 */
export function addressDedupeKey(address: string): string {
	if (!address) return "";
	try {
		const url = new URL(address);
		const host = url.hostname.toLowerCase();
		if (host && url.port) return `${url.protocol}//${host}:${url.port}${url.pathname}`;
		if (host) return `${url.protocol}//${host}${url.pathname}`;
	} catch {
		// Not parseable
	}
	return address;
}

/**
 * Merge two address lists, normalizing and deduplicating.
 * Existing addresses come first, then new candidates.
 */
export function mergeAddresses(
	existing: string[],
	candidates: string[],
	options?: { defaultHttpPort?: number },
): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const address of [...existing, ...candidates]) {
		const cleaned = normalizeAddress(address, options);
		const key = addressDedupeKey(cleaned);
		if (!cleaned || seen.has(key)) continue;
		seen.add(key);
		normalized.push(cleaned);
	}
	return normalized;
}

/**
 * Merge address lists while preferring newly discovered candidates first.
 * Useful for coordinator presence refreshes where fresh addresses should beat
 * stale cached LAN/Docker addresses without dropping still-useful fallbacks.
 */
export function mergeAddressesPreferCandidates(
	existing: string[],
	candidates: string[],
	options?: { defaultHttpPort?: number },
): string[] {
	return mergeAddresses(candidates, existing, options);
}
