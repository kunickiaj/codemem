/**
 * How entries of the Projects inventory form rows. Presentation only: grouping never changes
 * which scope a memory or session resolves to.
 *
 * Keep this rule identical to projectClusterKeys in packages/ui/src/tabs/projects/project-view.ts;
 * both have tests pinned to the same cases.
 */

export interface ProjectInventoryGroupEntry {
	display_project: string;
	git_remote: string | null;
	identity_source: string;
	project: string | null;
	repository_identity?: string | null;
	resolved_scope_id: string;
	workspace_identity: string;
}

function isAbsolutePath(value: string): boolean {
	return /^(\/|[A-Za-z]:[\\/])/.test(value);
}

/**
 * The Project name a row shows, lower-cased, or null when the entry has no name of its own (a
 * generated workspace ID). Matches projectHeading in the UI.
 */
export function projectInventoryNameKey(entry: ProjectInventoryGroupEntry): string | null {
	const name = entry.display_project.trim();
	if (
		!entry.project &&
		entry.identity_source === "workspace_id" &&
		name === entry.workspace_identity
	)
		return null;
	const title = isAbsolutePath(name) ? (name.split(/[\\/]/).filter(Boolean).at(-1) ?? name) : name;
	return title ? title.toLowerCase() : null;
}

function repositoryOf(entry: ProjectInventoryGroupEntry): string | null {
	return entry.repository_identity?.trim() || entry.git_remote?.trim() || null;
}

/**
 * The row key of each entry. Entries form one row when they have the same name, resolve to the
 * same scope and carry the same repository identity. An entry without a repository identity
 * joins the row of its name and scope when exactly one repository identity is recorded there.
 */
export function projectInventoryGroupKeys<T extends ProjectInventoryGroupEntry>(
	entries: readonly T[],
): Map<T, string> {
	const base = (entry: T, name: string) => `name:${name}\u0000scope:${entry.resolved_scope_id}`;
	const repositories = new Map<string, Set<string>>();
	for (const entry of entries) {
		const name = projectInventoryNameKey(entry);
		const repository = repositoryOf(entry);
		if (!name || !repository) continue;
		const key = base(entry, name);
		repositories.set(key, (repositories.get(key) ?? new Set()).add(repository));
	}
	const keys = new Map<T, string>();
	for (const entry of entries) {
		const name = projectInventoryNameKey(entry);
		if (!name) {
			keys.set(entry, `identity:${entry.workspace_identity}`);
			continue;
		}
		const shared = base(entry, name);
		const known = repositories.get(shared);
		const only = known?.size === 1 ? [...known][0] : null;
		keys.set(entry, `${shared}\u0000repo:${repositoryOf(entry) ?? only ?? ""}`);
	}
	return keys;
}
