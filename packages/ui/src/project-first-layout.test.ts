/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";

describe("project-first Sync layout", () => {
	it("includes the Projects share-flow mount used by row-level Share actions", () => {
		expect(html).toContain('id="projectShareFlowMount"');
		expect(html).toContain('id="recipientPolicyManagementMount"');
	});

	it("adds recipient-focused Sharing while keeping legacy administration under Advanced", () => {
		const sharingTab = html.indexOf('id="tabBtn-sharing"');
		const advancedTab = html.indexOf('id="tabBtn-coordinator-admin"');
		const sharingMount = html.indexOf('id="recipientPolicySharingMount"');
		const advancedDisclosure = html.indexOf("Advanced Team administration");
		const coordinatorMount = html.indexOf('id="coordinatorAdminMount"');

		expect(sharingTab).toBeGreaterThan(-1);
		expect(advancedTab).toBeGreaterThan(sharingTab);
		expect(sharingMount).toBeGreaterThan(-1);
		expect(advancedDisclosure).toBeGreaterThan(sharingMount);
		expect(coordinatorMount).toBeGreaterThan(advancedDisclosure);
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
});
