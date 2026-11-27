/**
 * Values that status reads serve from memory while a background task refreshes them.
 * A read never waits for the refresh, so slow network calls stay off the request path.
 */

interface Entry<T> {
	value: T | null;
	refreshedAtMs: number | null;
	/** The version the value was loaded for; a different version is refreshed. */
	version: string;
	inFlight: Promise<void> | null;
	error: string | null;
}

export interface BackgroundValue<T> {
	value: T | null;
	/** When the served value was loaded, or null before the first load finished. */
	refreshedAt: string | null;
	ageMs: number | null;
	/** A refresh is running; the served value may change on the next read. */
	refreshing: boolean;
	/** Why the last refresh failed, when it did. */
	error: string | null;
}

export interface BackgroundRefreshOptions<T> {
	key: string;
	/** Changes when the source data changed, forcing a refresh. */
	version?: string;
	/** How long a loaded value is served before the next refresh; may depend on the value. */
	maxAgeMs: number | ((value: T) => number);
	load: () => Promise<T>;
	now?: () => number;
}

const entries = new Map<string, Entry<unknown>>();

function maxAge<T>(setting: number | ((value: T) => number), value: T): number {
	return typeof setting === "number" ? setting : setting(value);
}

/**
 * The current value for `key`, starting a single background refresh when it is
 * missing, older than `maxAgeMs`, or loaded for another version.
 */
export function readInBackground<T>(options: BackgroundRefreshOptions<T>): BackgroundValue<T> {
	const now = options.now ?? Date.now;
	const version = options.version ?? "";
	const entry = (entries.get(options.key) as Entry<T> | undefined) ?? {
		value: null,
		refreshedAtMs: null,
		version,
		inFlight: null,
		error: null,
	};
	entries.set(options.key, entry as Entry<unknown>);
	const stale =
		entry.refreshedAtMs == null ||
		entry.version !== version ||
		now() - entry.refreshedAtMs >= maxAge(options.maxAgeMs, entry.value as T);
	if (stale && !entry.inFlight) {
		entry.inFlight = options
			.load()
			.then((value) => {
				entry.value = value;
				entry.version = version;
				entry.error = null;
				entry.refreshedAtMs = now();
			})
			.catch((error: unknown) => {
				entry.error = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				entry.inFlight = null;
			});
	}
	return {
		value: entry.value,
		refreshedAt: entry.refreshedAtMs == null ? null : new Date(entry.refreshedAtMs).toISOString(),
		ageMs: entry.refreshedAtMs == null ? null : Math.max(0, now() - entry.refreshedAtMs),
		refreshing: entry.inFlight !== null,
		error: entry.error,
	};
}

/** Wait for every running refresh; for tests. */
export async function settleBackgroundRefreshes(): Promise<void> {
	await Promise.all([...entries.values()].map((entry) => entry.inFlight));
}

/** Forget every cached value; for tests. */
export function clearBackgroundRefreshes(): void {
	entries.clear();
}
