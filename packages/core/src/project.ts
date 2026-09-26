import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Database } from "./db.js";

export interface GitRepositoryIdentity {
	identity: string;
	root: string | null;
	source: "git_remote" | "git_common_dir";
}

export const REPOSITORY_IDENTITY_METADATA_KEY = "codemem_repository_identity";

/**
 * SQL expression for the recorded repository identity in a metadata JSON
 * column, or NULL. Read queries select this instead of the whole column: few
 * sessions record the key, and the substring check skips JSON parsing for the
 * rest.
 */
export function repositoryIdentitySql(column: string): string {
	const path = `'$.${REPOSITORY_IDENTITY_METADATA_KEY}'`;
	return `CASE
		WHEN instr(${column}, '${REPOSITORY_IDENTITY_METADATA_KEY}') = 0 THEN NULL
		WHEN json_valid(${column}) THEN
			CASE WHEN json_type(${column}, ${path}) = 'text' THEN json_extract(${column}, ${path}) END
	END`;
}

/**
 * Recorded repository identities keyed by session id, for the few sessions
 * that recorded one. Lets per-memory queries join by session id instead of
 * evaluating session metadata once per memory row.
 */
export function recordedRepositoryIdentitiesBySession(db: Database): Map<number, string> {
	const rows = db
		.prepare(
			`SELECT id, ${repositoryIdentitySql("metadata_json")} AS repository_identity
			 FROM sessions
			 WHERE instr(metadata_json, '${REPOSITORY_IDENTITY_METADATA_KEY}') > 0`,
		)
		.all() as Array<{ id: number; repository_identity: string | null }>;
	const identities = new Map<number, string>();
	for (const row of rows) {
		const identity = row.repository_identity?.trim();
		if (identity) identities.set(row.id, identity);
	}
	return identities;
}

export function repositoryIdentityFromMetadata(
	metadataJson: string | null | undefined,
): string | null {
	if (!metadataJson) return null;
	try {
		const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
		const value = metadata[REPOSITORY_IDENTITY_METADATA_KEY];
		return typeof value === "string" && value.trim() ? value.trim() : null;
	} catch {
		return null;
	}
}

function normalizePathLike(value: string): string {
	return value.trim().replaceAll("\\", "/").replace(/\/+$/u, "") || value.trim();
}

function normalizeRemoteIdentity(value: string, repositoryRoot: string): string | null {
	const remote = value.trim();
	if (!remote) return null;
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(remote)) {
		try {
			const url = new URL(remote);
			if (url.protocol === "http:" || url.protocol === "https:") url.username = "";
			url.password = "";
			url.search = "";
			url.hash = "";
			return normalizePathLike(url.toString());
		} catch {
			return null;
		}
	}
	if (/^[A-Za-z]:[\\/]/u.test(remote) || !remote.includes(":")) {
		return normalizePathLike(resolve(repositoryRoot, remote));
	}
	const scpRemote = remote.match(/^((?:[^/@:]+@)?[^/:]+):(.+)$/u);
	if (!scpRemote?.[1] || !scpRemote[2]) return null;
	return `${scpRemote[1]}:${normalizePathLike(scpRemote[2])}`;
}

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
			const gitDirectory = gitDirectoryFromMarker(current, gitPath);
			if (!gitDirectory) return current;
			const layout = gitDirectoryLayout(gitDirectory);
			return layout.isLinkedWorktree && basename(layout.commonDirectory) === ".git"
				? dirname(layout.commonDirectory)
				: current;
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

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

function gitDirectoryLayout(gitDirectory: string): {
	commonDirectory: string;
	isLinkedWorktree: boolean;
} {
	try {
		const marker = readFileSync(resolve(gitDirectory, "commondir"), "utf8").trim();
		if (marker) return { commonDirectory: resolve(gitDirectory, marker), isLinkedWorktree: true };
	} catch {
		// Normal repositories use their own .git directory as the common directory.
	}
	return { commonDirectory: gitDirectory, isLinkedWorktree: false };
}

function originRemote(commonDirectory: string, repositoryRoot: string): string | null {
	try {
		const value = execFileSync(
			"git",
			[
				"config",
				"--file",
				resolve(commonDirectory, "config"),
				"--includes",
				"--get",
				"remote.origin.url",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 },
		).trim();
		return normalizeRemoteIdentity(value, repositoryRoot);
	} catch {
		return null;
	}
}

/** Resolve a location-independent identity for a live Git repository or linked worktree. */
export function resolveGitRepositoryIdentity(cwd: string): GitRepositoryIdentity | null {
	let current = resolve(cwd);
	while (true) {
		const gitPath = resolve(current, ".git");
		if (existsSync(gitPath)) {
			const gitDirectory = gitDirectoryFromMarker(current, gitPath);
			if (!gitDirectory) return null;
			const layout = gitDirectoryLayout(gitDirectory);
			const { commonDirectory } = layout;
			const normalizedCommonDirectory = normalizePathLike(commonDirectory);
			const root =
				layout.isLinkedWorktree && basename(normalizedCommonDirectory) === ".git"
					? dirname(commonDirectory)
					: current;
			const remote = originRemote(commonDirectory, root);
			if (remote) return { identity: remote, root, source: "git_remote" };
			return {
				identity: normalizedCommonDirectory,
				root,
				source: "git_common_dir",
			};
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
