export interface ProjectIdentityPresentationItem {
	canonicalId: string;
	displayName: string;
}

export interface ProjectIdentitySummaryGroup {
	displayName: string;
	identityCount: number;
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

function distinctSortedItems(
	items: ProjectIdentityPresentationItem[],
): ProjectIdentityPresentationItem[] {
	const byCanonicalId = new Map<string, ProjectIdentityPresentationItem>();
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
					? `${item.displayName} — Project ${index + 1} of ${group.length}`
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
