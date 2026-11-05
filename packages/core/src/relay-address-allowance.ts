/**
 * Pre-authentication upgrade fairness per network address (relay operations
 * contract, "Shedding, health, and switches"): ten upgrade attempts a minute
 * with a burst of two. Counters live only in memory, expire after a minute of
 * inactivity, and hold at most 4,096 addresses, so a flood of new addresses is
 * refused rather than growing the table. Addresses are never logged or stored.
 */
export const RELAY_ADDRESS_BURST = 2;
export const RELAY_ADDRESS_REFILL_MS = 6000;
export const RELAY_ADDRESS_EXPIRY_MS = 60_000;
export const RELAY_ADDRESS_MAX_ENTRIES = 4096;
/** Unregistered sockets one address may hold at once. */
export const RELAY_ADDRESS_PENDING_SOCKETS = 2;

interface Allowance {
	tokens: number;
	updated: number;
}

export class RelayAddressAllowances {
	private readonly allowances = new Map<string, Allowance>();

	constructor(private readonly now: () => number = () => performance.now()) {}

	/** Spends one upgrade attempt for the address. False when none is left or the table is full. */
	take(address: string): boolean {
		const at = this.now();
		for (const [key, allowance] of this.allowances)
			if (at - allowance.updated >= RELAY_ADDRESS_EXPIRY_MS) this.allowances.delete(key);
		let allowance = this.allowances.get(address);
		if (!allowance) {
			if (this.allowances.size >= RELAY_ADDRESS_MAX_ENTRIES) return false;
			allowance = { tokens: RELAY_ADDRESS_BURST, updated: at };
			this.allowances.set(address, allowance);
		}
		allowance.tokens = Math.min(
			RELAY_ADDRESS_BURST,
			allowance.tokens + (at - allowance.updated) / RELAY_ADDRESS_REFILL_MS,
		);
		allowance.updated = at;
		if (allowance.tokens < 1) return false;
		allowance.tokens -= 1;
		return true;
	}
}
