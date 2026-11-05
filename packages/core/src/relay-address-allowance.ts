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

/**
 * The fairness key for a client address. One subscriber usually holds a whole
 * IPv6 /64, so an IPv6 address is keyed by its first four groups; otherwise one
 * host could take a new bucket per address and fill the table. IPv4, including
 * IPv4-mapped IPv6, keys by the full address. Anything unparsable keys as itself.
 * Plain string parsing keeps this free of Node modules for the Workers host.
 */
export function relayAddressKey(address: string): string {
	const lower = address.trim().toLowerCase();
	const zone = lower.indexOf("%");
	const trimmed = zone === -1 ? lower : lower.slice(0, zone);
	if (!trimmed.includes(":")) return trimmed;
	const mapped = /^(?:(?:0{1,4}:){5}|::)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
	if (mapped?.[1]) return mapped[1];
	const groups = expandIPv6(trimmed);
	return groups ? `${groups.slice(0, 4).join(":")}::/64` : trimmed;
}

function expandIPv6(address: string): string[] | null {
	if (address.includes(".")) return null;
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
	return groups.map((group) => group.replace(/^0+(?=.)/, ""));
}

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
