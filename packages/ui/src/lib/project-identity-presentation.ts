export interface ProjectIdentityPresentationItem {
	canonicalId: string;
	displayName: string;
}

export interface ProjectIdentitySummaryGroup {
	displayName: string;
	identityCount: number;
}

export interface ProjectIdentityMemoryPresentationItem extends ProjectIdentityPresentationItem {
	existingMemoryCount: number;
}

export interface ProjectIdentityMemorySummaryGroup extends ProjectIdentitySummaryGroup {
	existingMemoryCount: number;
}

function compareCanonicalId(
	left: ProjectIdentityPresentationItem,
	right: ProjectIdentityPresentationItem,
): number {
	return left.canonicalId < right.canonicalId ? -1 : left.canonicalId > right.canonicalId ? 1 : 0;
}

export function projectDisplayNameKey(displayName: string): string {
	return displayName
		.normalize("NFKC")
		.replace(/\u200B/gu, "")
		.replace(/\s+/gu, " ")
		.trim()
		.toLowerCase();
}

function distinctSortedItems<T extends ProjectIdentityPresentationItem>(items: T[]): T[] {
	const byCanonicalId = new Map<string, T>();
	for (const item of items) {
		const current = byCanonicalId.get(item.canonicalId);
		if (!current || item.displayName < current.displayName)
			byCanonicalId.set(item.canonicalId, item);
	}
	return [...byCanonicalId.values()].sort(compareCanonicalId);
}

export function stableProjectPresentationLabels(
	items: ProjectIdentityPresentationItem[],
): ReadonlyMap<string, string> {
	const groups = new Map<string, ProjectIdentityPresentationItem[]>();
	for (const item of distinctSortedItems(items)) {
		const key = projectDisplayNameKey(item.displayName);
		const group = groups.get(key);
		if (group) group.push(item);
		else groups.set(key, [item]);
	}

	const labels = new Map<string, string>();
	for (const group of groups.values()) {
		for (const [index, item] of group.entries()) {
			labels.set(
				item.canonicalId,
				group.length > 1
					? `${item.displayName} — duplicate name ${index + 1} of ${group.length}`
					: item.displayName,
			);
		}
	}
	return labels;
}

export function projectIdentitySummaryGroups(
	items: ProjectIdentityPresentationItem[],
): ProjectIdentitySummaryGroup[] {
	const groups = new Map<
		string,
		{ displayName: string; canonicalIds: string[]; firstCanonicalId: string }
	>();
	for (const item of distinctSortedItems(items)) {
		const key = projectDisplayNameKey(item.displayName);
		const group = groups.get(key);
		if (group) group.canonicalIds.push(item.canonicalId);
		else {
			groups.set(key, {
				displayName: item.displayName,
				canonicalIds: [item.canonicalId],
				firstCanonicalId: item.canonicalId,
			});
		}
	}
	return [...groups.values()]
		.sort((left, right) => {
			const nameOrder = projectDisplayNameKey(left.displayName).localeCompare(
				projectDisplayNameKey(right.displayName),
			);
			if (nameOrder !== 0) return nameOrder;
			return left.firstCanonicalId < right.firstCanonicalId
				? -1
				: left.firstCanonicalId > right.firstCanonicalId
					? 1
					: 0;
		})
		.map((group) => ({
			displayName: group.displayName,
			identityCount: group.canonicalIds.length,
		}));
}

export function projectIdentityMemorySummaryGroups(
	items: ProjectIdentityMemoryPresentationItem[],
): ProjectIdentityMemorySummaryGroup[] {
	const distinctItems = distinctSortedItems(items);
	const memoryCounts = new Map<string, number>();
	for (const item of distinctItems) {
		const key = projectDisplayNameKey(item.displayName);
		memoryCounts.set(key, (memoryCounts.get(key) ?? 0) + item.existingMemoryCount);
	}
	return projectIdentitySummaryGroups(distinctItems).map((group) => ({
		...group,
		existingMemoryCount: memoryCounts.get(projectDisplayNameKey(group.displayName)) ?? 0,
	}));
}
