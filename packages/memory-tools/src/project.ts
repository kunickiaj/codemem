/**
 * Project label from the nearest Git anchor. A linked worktree resolves back
 * to its primary checkout through the gitdir's `commondir` marker, so every
 * worktree of a repository shares one project name.
 *
 * Mirrors `resolveProject` / `findGitAnchor` in packages/core/src/project.ts;
 * implemented here so thin hosts never import @codemem/core. project.test.ts
 * runs both against the same fixtures to pin the match.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

function gitDirectoryFromMarker(repositoryRoot: string, gitPath: string): string | null {
	try {
		const pathInfo = lstatSync(gitPath);
		if (pathInfo.isDirectory()) return gitPath;
		if (pathInfo.isSymbolicLink() && statSync(gitPath).isDirectory()) return realpathSync(gitPath);
		const text = readFileSync(gitPath, "utf8").trim();
		if (!text.startsWith("gitdir:")) return null;
		return resolve(repositoryRoot, text.slice("gitdir:".length).trim());
	} catch {
		return null;
	}
}

function commonGitDirectory(gitDirectory: string): { path: string; isLinkedWorktree: boolean } {
	try {
		const marker = readFileSync(resolve(gitDirectory, "commondir"), "utf8").trim();
		if (marker) return { path: resolve(gitDirectory, marker), isLinkedWorktree: true };
	} catch {
		// Normal repositories use their own .git directory as the common directory.
	}
	return { path: gitDirectory, isLinkedWorktree: false };
}

function anchorForGitMarker(current: string, gitPath: string): string {
	const gitDirectory = gitDirectoryFromMarker(current, gitPath);
	if (!gitDirectory) return current;
	const common = commonGitDirectory(gitDirectory);
	if (common.isLinkedWorktree && basename(common.path) === ".git") return dirname(common.path);
	return current;
}

function findGitAnchor(directory: string): string | null {
	let current = resolve(directory);
	while (true) {
		const gitPath = resolve(current, ".git");
		if (existsSync(gitPath)) return anchorForGitMarker(current, gitPath);
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function projectFromDirectory(directory: string): string | null {
	const anchor = findGitAnchor(directory);
	if (anchor) return basename(anchor);
	return basename(resolve(directory)) || null;
}

function cleanProject(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * The project label a stdio MCP server would use for `directory`:
 * CODEMEM_PROJECT wins, then the Git-anchored directory name.
 */
export function resolveCallerProject(
	directory: string,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	return cleanProject(env.CODEMEM_PROJECT) ?? projectFromDirectory(directory);
}
