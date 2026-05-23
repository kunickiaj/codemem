import type {
	GroupPreferencesDraft,
	GroupScopeManagementDraft,
	TeamSetupGuideState,
} from "./state";

export interface TeamCardOverview {
	defaultSpace: string;
	autoGrant: string;
	spaces: string;
}

function matchingSetupGuide(
	groupId: string,
	setupGuide: TeamSetupGuideState | null | undefined,
): TeamSetupGuideState | null {
	if (!setupGuide) return null;
	return setupGuide.groupId === groupId ? setupGuide : null;
}

function defaultSpaceSummary(
	preferences: GroupPreferencesDraft | undefined,
	setupGuide: TeamSetupGuideState | null,
): string {
	if (preferences?.loaded && preferences.default_space_scope_id) return "Configured";
	if (preferences?.loaded) return "Not configured";
	if (setupGuide?.defaultSpaceLabel) return setupGuide.defaultSpaceLabel;
	if (setupGuide?.defaultSpaceScopeId) return "Configured";
	return "Open Team defaults to inspect";
}

function autoGrantSummary(
	preferences: GroupPreferencesDraft | undefined,
	setupGuide: TeamSetupGuideState | null,
): string {
	if (preferences?.loaded) {
		return preferences.auto_grant_default_space_on_join
			? "On for the default Space"
			: "Off — Space access stays explicit";
	}
	if (setupGuide?.autoGrantDefaultSpaceOnJoin === true) return "On for the default Space";
	if (setupGuide?.autoGrantDefaultSpaceOnJoin === false) return "Off — Space access stays explicit";
	return "Open Team defaults to inspect";
}

function activeSpaceCount(scopeManagement: GroupScopeManagementDraft | undefined): number | null {
	if (!scopeManagement?.loaded) return null;
	return scopeManagement.scopes.filter((scope) => String(scope.status || "active") === "active")
		.length;
}

function spacesSummary(scopeManagement: GroupScopeManagementDraft | undefined): string {
	const count = activeSpaceCount(scopeManagement);
	if (count === null) return "Open Spaces to inspect access grants";
	return `${count} active ${count === 1 ? "Space" : "Spaces"}`;
}

export function teamCardOverview(opts: {
	groupId: string;
	preferences?: GroupPreferencesDraft;
	scopeManagement?: GroupScopeManagementDraft;
	setupGuide?: TeamSetupGuideState | null;
}): TeamCardOverview {
	const setupGuide = matchingSetupGuide(opts.groupId, opts.setupGuide);
	return {
		autoGrant: autoGrantSummary(opts.preferences, setupGuide),
		defaultSpace: defaultSpaceSummary(opts.preferences, setupGuide),
		spaces: spacesSummary(opts.scopeManagement),
	};
}
