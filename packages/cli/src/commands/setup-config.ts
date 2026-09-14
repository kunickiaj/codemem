import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripJsonComments, stripTrailingCommas } from "@codemem/core";

export const OPENCODE_PLUGIN_SPEC = "@codemem/opencode-plugin";
const LEGACY_OPENCODE_PLUGIN_SPECS = ["codemem", "@kunickiaj/codemem"];

function matchesPluginSpec(entry: unknown, spec: string): boolean {
	return typeof entry === "string" && (entry === spec || entry.startsWith(`${spec}@`));
}

export function reconcileOpencodePluginConfig(
	config: Record<string, unknown>,
	{ force }: { force: boolean },
): { config: Record<string, unknown>; changed: boolean; removedLegacy: boolean } {
	const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
	const isCanonicalSpec = (entry: unknown): boolean =>
		matchesPluginSpec(entry, OPENCODE_PLUGIN_SPEC);
	const isLegacySpec = (entry: unknown): boolean =>
		LEGACY_OPENCODE_PLUGIN_SPECS.some((spec) => matchesPluginSpec(entry, spec));
	const hasCanonicalSpec = plugins.some(isCanonicalSpec);
	const hasLegacySpec = plugins.some(isLegacySpec);

	if (hasCanonicalSpec && !hasLegacySpec && !force) {
		return { config, changed: false, removedLegacy: false };
	}

	const preserved = plugins.filter((entry) => !isCanonicalSpec(entry) && !isLegacySpec(entry));
	return {
		config: { ...config, plugin: [...preserved, OPENCODE_PLUGIN_SPEC] },
		changed: true,
		removedLegacy: hasLegacySpec,
	};
}

export function resolveOpencodeConfigPath(configDir: string): string {
	const jsonPath = join(configDir, "opencode.json");
	if (existsSync(jsonPath)) return jsonPath;
	const jsoncPath = join(configDir, "opencode.jsonc");
	if (existsSync(jsoncPath)) return jsoncPath;
	return jsoncPath;
}

export function loadJsoncConfig(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf-8");
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		const cleaned = stripTrailingCommas(stripJsonComments(raw));
		return JSON.parse(cleaned) as Record<string, unknown>;
	}
}

export function writeJsonConfig(path: string, data: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}
