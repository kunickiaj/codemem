export function setupItemErrorId(kind: "device" | "project", itemRef: string): string {
	return `legacy-team-setup-item-error-${kind}-${itemRef}`;
}
