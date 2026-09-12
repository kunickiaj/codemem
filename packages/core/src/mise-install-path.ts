import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";

export function normalizePortablePath(value: string): string {
	const normalized = posix.normalize(value.replaceAll("\\", "/"));
	return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function comparablePortablePath(value: string): string {
	return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

export function resolveComparablePath(value: string): string {
	try {
		return comparablePortablePath(normalizePortablePath(realpathSync(value)));
	} catch {
		return comparablePortablePath(normalizePortablePath(value));
	}
}

export function normalizeInstallEntryPath(entryPath: string): string {
	if (!entryPath) return "";
	try {
		return normalizePortablePath(realpathSync(entryPath));
	} catch {
		return normalizePortablePath(entryPath);
	}
}

function configuredMiseDataDirectories(env: Record<string, string | undefined>): string[] {
	const explicitDataDirectory = env.MISE_DATA_DIR?.trim();
	if (explicitDataDirectory) return [explicitDataDirectory];

	const candidates: string[] = [];
	const xdgDataHome = env.XDG_DATA_HOME?.trim();
	if (xdgDataHome) return [posix.join(xdgDataHome, "mise")];
	const localAppData = env.LOCALAPPDATA?.trim();
	if (localAppData) return [posix.join(localAppData, "mise")];
	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
	if (home) candidates.push(posix.join(home, ".local/share/mise"));
	return candidates;
}

function versionUnderMiseDataDirectory(entryPath: string, dataDirectory: string): string | null {
	const installPrefix = `${posix.join(
		resolveComparablePath(dataDirectory),
		"installs/npm-codemem",
	)}/`;
	if (!entryPath.startsWith(installPrefix)) return null;
	const versionAndPath = entryPath.slice(installPrefix.length);
	const separatorIndex = versionAndPath.indexOf("/");
	return separatorIndex > 0 ? versionAndPath.slice(0, separatorIndex) : null;
}

export function miseInstallVersionFromPath(
	entryPath: string,
	env: Record<string, string | undefined>,
): string | null {
	const comparableEntryPath = comparablePortablePath(normalizeInstallEntryPath(entryPath));
	for (const dataDirectory of configuredMiseDataDirectories(env)) {
		const version = versionUnderMiseDataDirectory(comparableEntryPath, dataDirectory);
		if (version) return version;
	}
	const defaultMatch = /\/mise\/installs\/npm-codemem\/([^/]+)\//.exec(comparableEntryPath);
	if (defaultMatch?.[1] !== undefined) return defaultMatch[1];
	return null;
}
