/* Pure formatting helpers for settings labels, phrases, auth methods,
 * credential sources, and failure timestamps. */

export function formatSettingsKey(key: string): string {
	return String(key || "").replace(/_/g, " ");
}

export function joinPhrases(values: string[]): string {
	const items = values.filter((value) => typeof value === "string" && value.trim());
	if (items.length === 0) return "";
	if (items.length === 1) return items[0];
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function formatAuthMethod(method: string): string {
	switch (method) {
		case "anthropic_consumer":
			return "OAuth (Claude Max/Pro)";
		case "codex_consumer":
			return "OAuth (ChatGPT subscription)";
		case "sdk_client":
			return "API key";
		case "claude_sidecar":
			return "Local Claude session";
		case "opencode_run":
			return "OpenCode sidecar";
		default:
			return method || "none";
	}
}

export function formatCredentialSources(creds: Record<string, boolean>): string {
	const parts: string[] = [];
	if (creds.oauth) parts.push("OAuth");
	if (creds.api_key) parts.push("API key");
	if (creds.env_var) parts.push("env var");
	return parts.length ? parts.join(", ") : "none";
}

export function formatFailureTimestamp(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "Unknown time";
	const ts = new Date(value);
	if (Number.isNaN(ts.getTime())) return value;
	return ts.toLocaleString();
}
