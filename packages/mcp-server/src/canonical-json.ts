export function canonicalJson(value: unknown): string {
	return (
		JSON.stringify(value, (_key, nestedValue) => {
			if (nestedValue === null || typeof nestedValue !== "object" || Array.isArray(nestedValue)) {
				return nestedValue;
			}
			return Object.fromEntries(
				Object.entries(nestedValue as Record<string, unknown>).toSorted(([left], [right]) =>
					left < right ? -1 : left > right ? 1 : 0,
				),
			);
		}) ?? "undefined"
	);
}
