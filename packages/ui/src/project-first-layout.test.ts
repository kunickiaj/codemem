/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";
import appSource from "./app.ts?raw";
import coordinatorGroupsSource from "./tabs/coordinator-admin/components/groups-panel.ts?raw";
import syncPeersSource from "./tabs/sync/components/sync-peers.tsx?raw";
import syncPeopleSource from "./tabs/sync/people.ts?raw";
import invitePanelSource from "./tabs/sync/team-sync/helpers/invite-panel-dom.ts?raw";
import renderTeamSyncSource from "./tabs/sync/team-sync/render/render-team-sync.ts?raw";
import coordinatorApprovalSource from "./tabs/sync/view-model/coordinator-approval.ts?raw";

describe("project-first navigation layout", () => {
	it("includes the Projects share-flow mount used by row-level Share actions", () => {
		expect(html).toContain('id="projectShareFlowMount"');
		expect(html).toContain('id="recipientPolicyManagementMount"');
		expect(html).toContain('id="legacyTeamSetupMount"');
	});

	it("orders the visible navigation with Sharing before Advanced", () => {
		const navigation = html.slice(
			html.indexOf('<nav class="tab-bar"'),
			html.indexOf("</nav>", html.indexOf('<nav class="tab-bar"')),
		);
		const labels = ["Feed", "Projects", "Sharing", "Devices", "Health", "Advanced"];
		let previous = -1;
		for (const label of labels) {
			const index = navigation.indexOf(`>${label}</button>`);
			expect(index).toBeGreaterThan(previous);
			previous = index;
		}
	});

	it("adds recipient-focused Sharing and a Devices mount before Advanced", () => {
		const sharingTab = html.indexOf('id="tabBtn-sharing"');
		const devicesTab = html.indexOf('id="tabBtn-devices"');
		const advancedTab = html.indexOf('id="tabBtn-advanced"');
		const sharingMount = html.indexOf('id="recipientPolicySharingMount"');
		const devicesMount = html.indexOf('id="devicesMount"');
		const advancedDisclosure = html.indexOf("Legacy administration");
		const coordinatorMount = html.indexOf('id="coordinatorAdminMount"');

		expect(sharingTab).toBeGreaterThan(-1);
		expect(devicesTab).toBeGreaterThan(sharingTab);
		expect(advancedTab).toBeGreaterThan(devicesTab);
		expect(sharingMount).toBeGreaterThan(-1);
		expect(devicesMount).toBeGreaterThan(sharingMount);
		expect(advancedDisclosure).toBeGreaterThan(sharingMount);
		expect(coordinatorMount).toBeGreaterThan(advancedDisclosure);
	});

	it("reuses Sync and coordinator administration DOM inside the Advanced panel", () => {
		const advancedStart = html.indexOf('id="tab-advanced"');
		const advancedEnd = html.indexOf('<script src="/assets/app.js">', advancedStart);
		const advanced = html.slice(advancedStart, advancedEnd);

		expect(advanced).toContain('id="advancedSyncContent"');
		expect(advanced).toContain('id="syncMainView"');
		expect(advanced).toContain('id="syncDiagnosticsView"');
		expect(advanced).toContain('id="advancedTeamsContent"');
		expect(advanced).toContain('id="coordinatorAdminMount"');
		expect(advanced).toContain('href="#advanced/sync/diagnostics"');
		expect(advanced).toContain('href="#advanced/sync"');
		expect(advanced).toContain(">Review invite</button>");
		expect(advanced).toContain('<h2 class="advanced-heading">Advanced</h2>');
		expect(advanced).toContain('id="advancedTabsMount"');
		expect(advanced).toContain("<summary>Legacy administration</summary>");
		expect(advanced).not.toMatch(/(?:Advanced|Coordinator Administration) \(legacy\)/i);
	});

	it("bounds legacy Team and Space controls and links Team work to Sharing", () => {
		const advancedStart = html.indexOf('id="advancedTeamsContent"');
		const advancedEnd = html.indexOf("</details>", advancedStart);
		const advanced = html.slice(advancedStart, advancedEnd);

		expect(advanced).toContain('id="coordinatorAdminHeading" tabindex="-1"');
		expect(advanced).toContain('href="#sharing" id="advancedTeamSettingsLink">Team settings');
		expect(advanced).toContain("Groups · Invites · Join requests · Devices");
		expect(advanced).toContain("<summary>Legacy administration</summary>");
		expect(advanced).not.toContain('role="note"');
	});

	it("keeps coordinator guidance visible when legacy controls are collapsed", () => {
		const panelStart = html.indexOf('id="advancedTeamsContent"');
		const disclosureStart = html.indexOf("<details", panelStart);
		const headingStart = html.indexOf('id="coordinatorAdminHeading"', panelStart);
		const guidanceStart = html.indexOf("Groups · Invites · Join requests · Devices", panelStart);
		const coordinatorMount = html.indexOf('id="coordinatorAdminMount"', disclosureStart);

		expect(headingStart).toBeGreaterThan(panelStart);
		expect(guidanceStart).toBeLessThan(disclosureStart);
		expect(coordinatorMount).toBeGreaterThan(disclosureStart);
	});

	it("keeps the Advanced status responsive without removing recovery controls", () => {
		expect(html).toContain(".advanced-sync-status");
		expect(html).toMatch(
			/@media \(max-width: 720px\)[\s\S]*\.advanced-sync-status[\s\S]*flex-direction: column/,
		);
		expect(html).toContain("Legacy administration");
		expect(html).toContain('id="coordinatorAdminMount"');
	});

	it("keeps Project fieldset semantics separate from the overflow-safe row grid", () => {
		const stylesStart = html.indexOf(".legacy-team-project-list {");
		const stylesEnd = html.indexOf(".legacy-team-setup-delta {", stylesStart);
		const styles = html.slice(stylesStart, stylesEnd);
		const fieldsetRule = styles.match(/\.legacy-team-project-row \{([^}]*)\}/)?.[1] ?? "";

		expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
		expect(fieldsetRule).not.toContain("display: grid");
		expect(fieldsetRule).toContain("min-width: 0");
		expect(styles).toContain(".legacy-team-project-row-content {");
		expect(styles).toContain("overflow-wrap: anywhere");
	});

	it("bounds Team setup device selectors at narrow and 200% zoom widths", () => {
		const rule = html.match(/\.legacy-team-device-select \{([^}]*)\}/)?.[1] ?? "";
		const cascadeOverride =
			html.match(/\.feed-search\.legacy-team-device-select,[^{]*\{([^}]*)\}/)?.[1] ?? "";

		expect(rule).toContain("width: 100%");
		expect(rule).toContain("min-width: 0");
		expect(rule).toContain("max-width: 100%");
		expect(cascadeOverride).toContain("min-width: 0");
		expect(cascadeOverride).toContain("max-width: 100%");
	});

	it("does not present the legacy coordinator surface as ordinary Team administration", () => {
		const advancedStart = html.indexOf('id="advancedTeamsContent"');
		const advanced = html.slice(advancedStart);

		expect(advanced).not.toContain("Advanced Team administration");
		expect(advanced).not.toContain(">Teams</button>");
		expect(advanced).not.toContain("Manage Team membership");
	});

	it("keeps Coordinator Administration current while labeling legacy Team and Space work", () => {
		const advancedSyncSources = [
			syncPeersSource,
			syncPeopleSource,
			invitePanelSource,
			renderTeamSyncSource,
			coordinatorApprovalSource,
		].join("\n");

		expect(advancedSyncSources).toContain("Coordinator Administration");
		expect(advancedSyncSources).not.toMatch(/(?:Advanced|Coordinator Administration) \(legacy\)/i);
		for (const forbidden of [
			"Manage Spaces in Teams",
			"Review Space access for this device in Teams",
			"Advanced admin tools now live in Teams",
			"Finish Teams setup",
			"Review the Team setup",
		]) {
			expect(advancedSyncSources).not.toContain(forbidden);
		}
	});

	it("warns before creating a legacy coordinator group without relabeling it as a Team", () => {
		expect(coordinatorGroupsSource).toContain(
			"Creating a coordinator group changes legacy discovery and transport setup only.",
		);
		expect(coordinatorGroupsSource).toContain("does not create a policy Team");
		expect(coordinatorGroupsSource).toContain('"Create coordinator group"');
		expect(coordinatorGroupsSource).not.toContain('"Create Team"');
		expect(coordinatorGroupsSource).not.toContain('"Manage Team"');
	});

	it("marks only the initial Feed control with aria-current", () => {
		const navigation = html.slice(
			html.indexOf('<nav class="tab-bar"'),
			html.indexOf("</nav>", html.indexOf('<nav class="tab-bar"')),
		);

		expect(navigation).toContain('id="tabBtn-feed" aria-current="page"');
		expect(navigation.match(/aria-current="page"/g)).toHaveLength(1);
	});

	it("keeps legacy and backend terminology out of primary navigation controls", () => {
		const navigation = html.slice(
			html.indexOf('<nav class="tab-bar"'),
			html.indexOf("</nav>", html.indexOf('<nav class="tab-bar"')),
		);

		expect(navigation).not.toContain('id="tabBtn-sync"');
		expect(navigation).not.toContain('id="tabBtn-coordinator-admin"');
		expect(navigation).not.toContain("(legacy)");
		for (const forbidden of [
			"scope",
			"grant",
			"address",
			"fingerprint",
			"filter",
			"epoch",
			"cursor",
		]) {
			expect(navigation.toLowerCase()).not.toContain(forbidden);
		}
	});

	it("wraps narrow Sharing tabs and legacy actions instead of adding horizontal scrolling", () => {
		expect(html).toContain(".recipient-policy-sharing-responsive-tabs { flex-wrap: wrap;");
		expect(html).toContain(".coordinator-admin-space-toolbar > .peer-actions { display: grid;");
		expect(html).not.toContain(".recipient-policy-sharing-responsive-tabs { overflow-x: auto; }");
	});

	it("keeps normal Projects controls recipient-focused and moves invitations to Sharing", () => {
		const projects = html.indexOf('id="tab-projects"');
		const sharing = html.indexOf('id="tab-sharing"', projects);
		const primary = html.slice(projects, sharing);

		expect(primary).toContain('id="projectsShareSelected"');
		expect(primary).not.toContain("Sharing domain");
		expect(primary).not.toContain("Space");
	});

	it("keeps legacy identity controls available without a second pairing workflow", () => {
		const advanced = html.indexOf("Manual device and identity controls");
		const assignment = html.indexOf('id="syncActorCreateButton"');
		const diagnostics = html.indexOf("Advanced diagnostics");

		expect(advanced).toBeGreaterThan(-1);
		expect(assignment).toBeGreaterThan(advanced);
		expect(diagnostics).toBeGreaterThan(assignment);
		expect(html.slice(advanced, diagnostics)).not.toContain("Connect another device");
		expect(html.slice(advanced, diagnostics)).not.toContain("syncPairingDisclosureMount");
		expect(html.slice(advanced, diagnostics)).toContain("Create person");
		expect(html.slice(advanced, diagnostics)).not.toContain("Connect another device");
	});

	it("keeps the legacy upgrade review destination available", () => {
		expect(html).toContain('id="syncSharingReview"');
	});

	it("keeps Devices read-only at the app integration boundary", () => {
		expect(html).toContain('id="devicesMount"');
		expect(appSource).not.toMatch(
			/commitRecipientPolicy|previewRecipientPolicy|updatePeer|triggerSync/,
		);
	});
});

describe("Projects inventory overlays", () => {
	it("lets project row menus escape the inventory table", () => {
		const tableRule = html.match(/\.project-inventory-table \{([^}]*)\}/)?.[1] ?? "";
		expect(tableRule).toContain("overflow: visible");
		expect(html).toContain(".project-row-menu-panel { position: absolute;");
	});
});

describe("legacy sharing review layout", () => {
	it("keeps review visible outside collapsed manual controls", () => {
		const panelStart = html.indexOf("<h2>People and devices</h2>");
		const review = html.indexOf('id="syncSharingReview"', panelStart);
		const disclosure = html.indexOf('<details class="project-inventory-details"', panelStart);

		expect(review).toBeGreaterThan(panelStart);
		expect(review).toBeLessThan(disclosure);
	});
});

describe("split-pane shell layout", () => {
	it("keeps controls bounded across responsive breakpoints", () => {
		const normalized = html.replace(/\s+/g, " ");
		const responsiveStart = normalized.indexOf("/* ── Responsive");
		const desktopStart = normalized.indexOf("@media (max-width: 900px)", responsiveStart);
		const narrowStart = normalized.indexOf("@media (max-width: 720px)", desktopStart);
		const compactStart = normalized.indexOf("@media (max-width: 520px)", narrowStart);
		const responsiveEnd = normalized.indexOf("/* ──", compactStart);
		const desktopSplit = normalized.slice(desktopStart, narrowStart);
		const narrowSplit = normalized.slice(narrowStart, compactStart);
		const compact = normalized.slice(compactStart, responsiveEnd);

		expect(desktopSplit).toContain(".header-row { flex-wrap: nowrap; }");
		expect(desktopSplit).toContain(".header-tertiary { display: none; }");
		expect(desktopSplit).toContain(
			".header-right .project-filter { flex: 1 1 140px; min-width: 96px;",
		);
		expect(desktopSplit).toContain(".tab-bar { overflow-x: auto;");
		expect(narrowSplit).toContain(".header-title { font-size: var(--font-size-xl); }");
		expect(compact).toContain("header { padding: var(--sp-3) var(--sp-4);");
		expect(compact).toContain("body { --header-sticky-offset: 117px; }");
		expect(compact).toContain(".header-row { flex-wrap: wrap; }");
		expect(compact).toContain(".header-left, .header-right { flex-basis: 100%; }");
		expect(compact).toContain('.refresh-status[data-refresh-state="idle"] { display: none; }');
		expect(compact).not.toContain(".refresh-status { display: none; }");
	});
});
