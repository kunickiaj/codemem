/* Build the user-facing notice (message + severity) from a settings-save
 * response payload. Interprets the `effects` block — hot-reloaded keys,
 * live-applied keys, restart requirements, sync outcome, warnings, and
 * manual follow-up actions — into one joined status line. */

import { formatSettingsKey, joinPhrases } from "./format";

interface SettingsSaveEffects {
	hot_reloaded_keys?: unknown;
	live_applied_keys?: unknown;
	restart_required_keys?: unknown;
	warnings?: unknown;
	manual_actions?: unknown;
	sync?: {
		attempted?: boolean;
		message?: string;
		reason?: string;
		affected_keys?: unknown;
		ok?: boolean;
	};
}

export function buildSettingsNotice(payload: unknown): {
	message: string;
	type: "success" | "warning";
} {
	const raw = (payload as { effects?: SettingsSaveEffects } | null | undefined)?.effects;
	const effects: SettingsSaveEffects =
		raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const hotReloaded = Array.isArray(effects.hot_reloaded_keys)
		? effects.hot_reloaded_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const liveApplied = Array.isArray(effects.live_applied_keys)
		? effects.live_applied_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const restartRequired = Array.isArray(effects.restart_required_keys)
		? effects.restart_required_keys.map((key) => formatSettingsKey(String(key)))
		: [];
	const warnings = Array.isArray(effects.warnings)
		? effects.warnings.filter(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			)
		: [];
	const manualActions: Array<{ command?: string }> = Array.isArray(effects.manual_actions)
		? (effects.manual_actions as Array<{ command?: string }>)
		: [];
	const sync = effects.sync && typeof effects.sync === "object" ? effects.sync : {};
	const lines: string[] = [];

	if (hotReloaded.length) {
		lines.push(`Applied now: ${joinPhrases(hotReloaded)}.`);
	}
	if (liveApplied.length) {
		lines.push(`Live settings updated: ${joinPhrases(liveApplied)}.`);
	}
	if (sync.attempted && typeof sync.message === "string" && sync.message) {
		lines.push(`Sync: ${sync.message}.`);
	} else if (
		Array.isArray(sync.affected_keys) &&
		sync.affected_keys.length &&
		typeof sync.reason === "string" &&
		sync.reason
	) {
		lines.push(`Sync: ${sync.reason}.`);
	}
	if (restartRequired.length) {
		lines.push(`Restart required for ${joinPhrases(restartRequired)}. Run: codemem serve restart`);
	}
	warnings.forEach((warning) => {
		lines.push(warning);
	});
	manualActions.forEach((action) => {
		if (action && typeof action.command === "string" && action.command.trim()) {
			lines.push(`If needed: ${action.command}.`);
		}
	});
	if (!lines.length) {
		lines.push("Saved.");
	}

	const hasWarning = restartRequired.length > 0 || warnings.length > 0 || sync.ok === false;
	return { message: lines.join(" "), type: hasWarning ? "warning" : "success" };
}
