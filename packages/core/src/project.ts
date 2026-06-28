import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export function projectBasename(value: string): string {
	let normalized = value.replaceAll("\\", "/");
	while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	if (!normalized) return "";
	const parts = normalized.split("/");
	return parts[parts.length - 1] ?? "";
}

function escapeSqlLikePattern(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function projectColumnClause(
	columnExpr: string,
	project: string,
): { clause: string; params: string[] } {
	const trimmed = project.trim();
	if (!trimmed) return { clause: "", params: [] };
	const value = /[\\/]/.test(trimmed) ? projectBasename(trimmed) : trimmed;
	if (!value) return { clause: "", params: [] };
	const escaped = escapeSqlLikePattern(value);
	return {
		clause: `(${columnExpr} = ? OR ${columnExpr} LIKE ? ESCAPE '\\' OR ${columnExpr} LIKE ? ESCAPE '\\')`,
		params: [value, `%/${escaped}`, `%\\${escaped}`],
	};
}

export function projectClause(project: string): { clause: string; params: string[] } {
	return projectColumnClause("sessions.project", project);
}

export function projectMatchesFilter(
	projectFilter: string | null | undefined,
	itemProject: string | null | undefined,
): boolean {
	if (!projectFilter) return true;
	if (!itemProject) return false;
	const normalizedFilter = projectFilter.trim().replaceAll("\\", "/");
	if (!normalizedFilter) return true;
	const filterValue = normalizedFilter.includes("/")
		? projectBasename(normalizedFilter)
		: normalizedFilter;
	const normalizedProject = itemProject.replaceAll("\\", "/");
	return normalizedProject === filterValue || normalizedProject.endsWith(`/${filterValue}`);
}

function findGitAnchor(startCwd: string): string | null {
	let current = resolve(startCwd);
	while (true) {
		const gitPath = resolve(current, ".git");
		if (existsSync(gitPath)) {
			try {
				if (lstatSync(gitPath).isDirectory()) {
					return current;
				}
				const text = readFileSync(gitPath, "utf8").trim();
				if (text.startsWith("gitdir:")) {
					const gitdir = resolve(current, text.slice("gitdir:".length).trim()).replaceAll(
						"\\",
						"/",
					);
					const worktreeMarker = "/.git/worktrees/";
					const worktreeIndex = gitdir.indexOf(worktreeMarker);
					if (worktreeIndex >= 0) {
						return gitdir.slice(0, worktreeIndex);
					}
				}
				return current;
			} catch {
				return current;
			}
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function resolveProject(cwd: string, override?: string | null): string | null {
	if (override != null) {
		const trimmed = override.trim();
		return trimmed || null;
	}
	const gitAnchor = findGitAnchor(cwd);
	if (gitAnchor) {
		return basename(gitAnchor);
	}
	return basename(resolve(cwd));
}

/**
 * Resolve the working-tree root for a directory by walking up to the nearest
 * `.git` marker and returning the directory that contains it. Returns null when
 * no repository is found.
 *
 * Unlike `resolveProject` (which follows a linked worktree's gitdir back to the
 * primary checkout for a stable project name), this returns the *current*
 * worktree root so repo-root files like AGENTS.md are read from the worktree
 * actually being used, not another checkout.
 */
export function resolveProjectRoot(cwd: string): string | null {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(resolve(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
