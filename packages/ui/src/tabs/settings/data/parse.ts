/* JSON parsers for the settings form: the `claude_command` / observer-auth
 * argv arrays (parseCommandArgv) and the observer HTTP headers object
 * (parseObserverHeaders). Each throws a labeled Error on validation
 * failure so the save flow can surface a field-specific message. */

export function parseCommandArgv(
	raw: string,
	options: { label: string; normalize?: boolean; requireNonEmpty?: boolean },
): string[] {
	const text = raw.trim();
	if (!text) return [];
	const parsed = JSON.parse(text);
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
		throw new Error(`${options.label} must be a JSON string array`);
	}
	if (!options.normalize && !options.requireNonEmpty) {
		return parsed;
	}
	const values = options.normalize ? parsed.map((item) => item.trim()) : parsed;
	if (options.requireNonEmpty && values.some((item) => item.trim() === "")) {
		throw new Error(`${options.label} cannot contain empty command tokens`);
	}
	return values;
}

export function parseObserverHeaders(raw: string): Record<string, string> {
	const text = raw.trim();
	if (!text) return {};
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("observer headers must be a JSON object");
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof key !== "string" || !key.trim() || typeof value !== "string") {
			throw new Error("observer headers must map string keys to string values");
		}
		headers[key.trim()] = value;
	}
	return headers;
}
