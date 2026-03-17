import { parseStrictInteger } from "@codemem/core";

/**
 * Shared helpers for viewer-server routes.
 */

/**
 * Parse a JSON string that should be an array of strings.
 * Returns an empty array on null, invalid JSON, or non-array values.
 * Mirrors Python's store._safe_json_list().
 */
export function safeJsonList(raw: string | null | undefined): string[] {
	if (raw == null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

/**
 * Parse a query parameter as an integer, returning the default on failure.
 */
export function queryInt(value: string | undefined, defaultValue: number): number {
	if (value == null) return defaultValue;
	const parsed = parseStrictInteger(value);
	return parsed == null ? defaultValue : parsed;
}

/**
 * Parse a query parameter as a boolean flag.
 * Recognizes "1", "true", "yes" as truthy.
 */
export function queryBool(value: string | undefined): boolean {
	if (value == null) return false;
	return value === "1" || value === "true" || value === "yes";
}
