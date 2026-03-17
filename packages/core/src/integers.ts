const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Parse a strict integer string like Python's int(), but reject partial strings
 * like "10abc" that parseInt() would silently truncate.
 */
export function parseStrictInteger(value: string | undefined): number | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (!/^[+-]?\d+$/.test(trimmed)) return null;
	try {
		const parsed = BigInt(trimmed);
		if (parsed < MIN_SAFE_BIGINT || parsed > MAX_SAFE_BIGINT) return null;
		return Number(parsed);
	} catch {
		return null;
	}
}

/**
 * Parse a positive memory ID matching Python's stricter semantics:
 * - allow integer numbers
 * - allow digit-only strings
 * - reject bools, floats, scientific notation, whitespacey strings, unsafe ints
 */
export function parsePositiveMemoryId(value: unknown): number | null {
	if (typeof value === "boolean") return null;
	if (typeof value === "number") {
		if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value <= 0) return null;
		return value;
	}
	if (typeof value === "string") {
		if (!/^\d+$/.test(value)) return null;
		try {
			const parsed = BigInt(value);
			if (parsed <= 0n || parsed > MAX_SAFE_BIGINT) return null;
			return Number(parsed);
		} catch {
			return null;
		}
	}
	return null;
}
