import type Database from "better-sqlite3";
import type { RelayPairPacing } from "./relay-peer-client.js";

/**
 * Keeps pair pacing and disposable SQLite quota refill on the same elapsed time.
 * Concurrent waits advance the shared clock cumulatively. Verify concurrent
 * pacing and quota fairness with native-clock tests.
 */
export function simulatedRelayPairPacing() {
	let elapsedMs = 0;
	const utcOrigin = Date.now();
	const advance = (milliseconds: number): void => {
		if (!Number.isFinite(milliseconds) || milliseconds < 0)
			throw new Error("Invalid simulated pacing interval");
		elapsedMs += milliseconds;
	};
	const pairPacing: RelayPairPacing = {
		monotonicMs: () => elapsedMs,
		async delay(milliseconds, signal) {
			signal.throwIfAborted();
			advance(Math.ceil(milliseconds));
		},
	};
	return { pairPacing, quotaUtcMs: () => utcOrigin + elapsedMs, advance };
}

export type SimulatedRelayPairPacing = ReturnType<typeof simulatedRelayPairPacing>;

/** Substitute only a disposable budget database's clock, preserving its real SQL. */
export function installSimulatedRelayBudgetClock(
	database: Database.Database,
	clock: SimulatedRelayPairPacing,
): void {
	database.function("strftime", { varargs: true }, (format) => {
		const now = clock.quotaUtcMs();
		if (format === "%s") return String(Math.floor(now / 1000));
		if (format === "%f") return new Date(now).toISOString().slice(17, 23);
		throw new Error("Unexpected budget clock format");
	});
}
