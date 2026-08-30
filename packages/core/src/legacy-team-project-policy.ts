export function isMigratableLegacyTeamProjectIdentity(identity: string): boolean {
	const normalized = identity.trim();
	return (
		normalized !== "shared" &&
		normalized !== "shared:default" &&
		normalized !== "shared:legacy" &&
		!normalized.startsWith("personal:")
	);
}
