/* Pure helpers for reading + normalizing settings form values. */

import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, SETTINGS_ADVANCED_KEY } from "./constants";

export function loadAdvancedPreference(): boolean {
	try {
		return globalThis.localStorage?.getItem(SETTINGS_ADVANCED_KEY) === "1";
	} catch {
		return false;
	}
}

export function persistAdvancedPreference(show: boolean) {
	try {
		globalThis.localStorage?.setItem(SETTINGS_ADVANCED_KEY, show ? "1" : "0");
	} catch {}
}

export function hasOwn(obj: unknown, key: string): boolean {
	return typeof obj === "object" && obj !== null && Object.hasOwn(obj, key);
}

export function effectiveOrConfigured(config: unknown, effective: unknown, key: string): unknown {
	if (hasOwn(effective, key)) return (effective as Record<string, unknown>)[key];
	if (hasOwn(config, key)) return (config as Record<string, unknown>)[key];
	return undefined;
}

export function asInputString(value: unknown): string {
	if (value === undefined || value === null) return "";
	return String(value);
}

export function asBooleanValue(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (!normalized) return false;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
	}
	return Boolean(value);
}

export function toProviderList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function isEqualValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeTextValue(value: string): string {
	const trimmed = value.trim();
	return trimmed === "" ? "" : trimmed;
}

export function inferObserverModel(
	runtime: string,
	provider: string,
	configuredModel: string,
): { model: string; source: string } {
	if (configuredModel) return { model: configuredModel, source: "Configured" };
	if (runtime === "claude_sidecar") {
		return { model: DEFAULT_ANTHROPIC_MODEL, source: "Recommended (local Claude session)" };
	}
	if (provider === "anthropic") {
		return { model: DEFAULT_ANTHROPIC_MODEL, source: "Recommended (Anthropic provider)" };
	}
	if (provider === "opencode") {
		return { model: "opencode/gpt-5.1-codex-mini", source: "Recommended (OpenCode Zen provider)" };
	}
	if (provider && provider !== "openai") {
		return { model: "provider default", source: "Recommended (provider default)" };
	}
	return { model: DEFAULT_OPENAI_MODEL, source: "Recommended (direct API)" };
}

export function configuredValueForKey(config: unknown, key: string): unknown {
	const cfg = (config ?? {}) as Record<string, unknown>;
	switch (key) {
		case "claude_command": {
			const value = cfg.claude_command;
			if (!Array.isArray(value)) return [];
			const normalized: string[] = [];
			value.forEach((item) => {
				if (typeof item !== "string") return;
				const token = item.trim();
				if (token) normalized.push(token);
			});
			return normalized;
		}
		case "observer_provider":
		case "observer_model":
		case "observer_simple_model":
		case "observer_rich_model":
		case "observer_rich_reasoning_effort":
		case "observer_rich_reasoning_summary":
		case "observer_auth_file":
		case "sync_host":
		case "sync_coordinator_url":
		case "sync_coordinator_group":
			return normalizeTextValue(asInputString(cfg[key]));
		case "observer_runtime":
			return normalizeTextValue(asInputString(cfg.observer_runtime));
		case "observer_auth_source":
			return normalizeTextValue(asInputString(cfg.observer_auth_source));
		case "observer_auth_command": {
			const value = cfg.observer_auth_command;
			if (!Array.isArray(value)) return [];
			return value.filter((item) => typeof item === "string");
		}
		case "observer_headers": {
			const value = cfg.observer_headers;
			if (!value || typeof value !== "object" || Array.isArray(value)) return {};
			const headers: Record<string, string> = {};
			Object.entries(value as Record<string, unknown>).forEach(([header, headerValue]) => {
				if (typeof header === "string" && header.trim() && typeof headerValue === "string") {
					headers[header.trim()] = headerValue;
				}
			});
			return headers;
		}
		case "observer_auth_timeout_ms":
		case "observer_max_chars":
		case "observer_simple_temperature":
		case "observer_rich_temperature":
		case "observer_rich_max_output_tokens":
		case "pack_observation_limit":
		case "pack_session_limit":
		case "raw_events_sweeper_interval_s":
		case "sync_port":
		case "sync_interval_s": {
			if (!hasOwn(cfg, key)) return "";
			const parsed = Number(cfg[key]);
			return Number.isFinite(parsed) && parsed !== 0 ? parsed : "";
		}
		case "sync_coordinator_timeout_s":
		case "sync_coordinator_presence_ttl_s": {
			if (!hasOwn(cfg, key)) return "";
			const parsed = Number(cfg[key]);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : "";
		}
		case "observer_auth_cache_ttl_s": {
			if (!hasOwn(cfg, key)) return "";
			const parsed = Number(cfg[key]);
			return Number.isFinite(parsed) ? parsed : "";
		}
		case "sync_enabled":
		case "sync_mdns":
		case "observer_tier_routing_enabled":
			return asBooleanValue(cfg[key]);
		default:
			return hasOwn(cfg, key) ? cfg[key] : "";
	}
}

export function mergeOverrideBaseline(
	baseline: Record<string, unknown>,
	config: unknown,
	envOverrides: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...baseline };
	Object.keys(envOverrides).forEach((key) => {
		if (hasOwn(next, key)) {
			next[key] = configuredValueForKey(config, key);
		}
	});
	return next;
}
