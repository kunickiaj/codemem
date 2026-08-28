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

	it("wires the global Team setup dialog to Sharing and Projects", () => {
		expect(appSource).toContain("mountLegacyTeamSetupDialog");
		expect(appSource.match(/onOpenTeamSetup: openLegacyTeamSetup/g)).toHaveLength(2);
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
		const advancedDisclosure = html.indexOf("Coordinator Administration");
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
		expect(advanced).toContain("<h2>Advanced</h2>");
		expect(advanced).toContain(">Coordinator Administration</button>");
		expect(advanced).toContain("<summary>Coordinator Administration</summary>");
		expect(advanced).not.toMatch(/(?:Advanced|Coordinator Administration) \(legacy\)/i);
	});

	it("bounds legacy Team and Space controls and directs ordinary Team work to Sharing", () => {
		const advancedStart = html.indexOf('id="advancedTeamsContent"');
		const advancedEnd = html.indexOf("</details>", advancedStart);
		const advanced = html.slice(advancedStart, advancedEnd);

		expect(advanced).toContain('role="note"');
		expect(advanced).toContain('aria-labelledby="coordinatorAdminLegacyNoticeTitle"');
		expect(advanced).toContain("Looking for Team settings?");
		expect(advanced).toContain("Manage Team members, names, and Project access in Sharing.");
		expect(advanced).toContain('id="coordinatorAdminOpenSharing"');
		expect(advanced).toContain(">Open Sharing</button>");
		expect(html).toContain('aria-label="Advanced sections" role="group"');
		expect(advanced).toContain('id="coordinatorAdminLegacyNoticeTitle" tabindex="-1"');
	});

	it("keeps the legacy notice visible when technical controls are collapsed", () => {
		const panelStart = html.indexOf('id="advancedTeamsContent"');
		const disclosureStart = html.indexOf("<details", panelStart);
		const noticeStart = html.indexOf('class="coordinator-admin-inline-warning', panelStart);
		const noticeEnd = html.indexOf("</aside>", noticeStart);
		const coordinatorMount = html.indexOf('id="coordinatorAdminMount"', disclosureStart);

		expect(noticeStart).toBeGreaterThan(panelStart);
		expect(noticeEnd).toBeLessThan(disclosureStart);
		expect(coordinatorMount).toBeGreaterThan(disclosureStart);
	});

	it("keeps the legacy notice responsive without removing recovery controls", () => {
		expect(html).toContain(".coordinator-admin-legacy-notice");
		expect(html).toMatch(
			/@media \(max-width: 720px\)[\s\S]*\.coordinator-admin-legacy-notice[\s\S]*flex-direction: column/,
		);
		expect(html).toContain("Looking for Team settings?");
		expect(html).toContain(
			"Manage Team members, names, and Project access in Sharing. Use this page only for older coordinator groups and Spaces.",
		);
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

	it("keeps normal Projects controls recipient-focused and moves invitations to Advanced", () => {
		const projects = html.indexOf('id="tab-projects"');
		const advanced = html.indexOf("Advanced Project invitations", projects);
		const primary = html.slice(projects, advanced);

		expect(primary).toContain('id="projectsShareSelected"');
		expect(primary).toContain("Choose exact Projects");
		expect(primary).not.toContain("Sharing domain");
		expect(primary).not.toContain("Space");
	});

	it("keeps legacy device controls available but outside the primary project-sharing flow", () => {
		const primary = html.indexOf('id="syncProjectShareOperations"');
		const advanced = html.indexOf("Manual device and identity controls");
		const assignment = html.indexOf('id="syncActorCreateButton"');
		const diagnostics = html.indexOf("Advanced diagnostics");

		expect(primary).toBeGreaterThan(-1);
		expect(advanced).toBeGreaterThan(primary);
		expect(assignment).toBeGreaterThan(advanced);
		expect(diagnostics).toBeGreaterThan(assignment);
		expect(html.slice(advanced, diagnostics)).toContain("Connect another device");
		expect(html.slice(advanced, diagnostics)).toContain("Create person");
	});

	it("preserves Health sync refresh and the legacy upgrade review destinations", () => {
		expect(appSource).toContain('refreshTab === "health"');
		expect(appSource).toContain('window.location.hash = "sync"');
		expect(appSource).toContain('window.location.hash = "projects"');
		expect(html).toContain('id="syncSharingReview"');
	});

	it("wires Devices to its read-only data sources without introducing mutation endpoints", () => {
		expect(html).toContain('id="devicesMount"');
		expect(appSource).toMatch(/from ["'].+devices["']/i);
		expect(appSource).toContain("loadDevicesData");
		expect(appSource).toContain("loadRecipientPolicyIntent");
		expect(appSource).toContain("loadRecipientPolicyReconciliationStatus");
		expect(appSource).toContain("loadSyncData");
		expect(appSource).not.toMatch(
			/commitRecipientPolicy|previewRecipientPolicy|updatePeer|triggerSync/,
		);
	});
});
