/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";
import appSource from "./app.ts?raw";

describe("project-first navigation layout", () => {
	it("includes the Projects share-flow mount used by row-level Share actions", () => {
		expect(html).toContain('id="projectShareFlowMount"');
		expect(html).toContain('id="recipientPolicyManagementMount"');
	});

	it("orders the visible navigation as Feed, Projects, Sharing, Devices, Health, Advanced", () => {
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
		const advancedDisclosure = html.indexOf("Advanced Team administration");
		const coordinatorMount = html.indexOf('id="coordinatorAdminMount"');

		expect(sharingTab).toBeGreaterThan(-1);
		expect(devicesTab).toBeGreaterThan(sharingTab);
		expect(advancedTab).toBeGreaterThan(devicesTab);
		expect(sharingMount).toBeGreaterThan(-1);
		expect(devicesMount).toBeGreaterThan(sharingMount);
		expect(advancedDisclosure).toBeGreaterThan(sharingMount);
		expect(coordinatorMount).toBeGreaterThan(advancedDisclosure);
	});

	it("reuses Sync and Team administration DOM inside the Advanced panel", () => {
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
