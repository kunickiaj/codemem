import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripJsonComments, stripTrailingCommas } from "@codemem/core";

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

/**
 * Write JSON config after copying any existing file to `<path>.codemem.bak`.
 * Backup failure is non-fatal (write still proceeds).
 */
export function writeJsonConfigWithBackup(path: string, data: Record<string, unknown>): void {
	if (existsSync(path)) {
		try {
			copyFileSync(path, `${path}.codemem.bak`);
		} catch {
			// Non-fatal: continue without a backup rather than blocking install.
		}
	}
	writeJsonConfig(path, data);
}
