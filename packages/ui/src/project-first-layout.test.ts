/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";

describe("project-first Sync layout", () => {
	it("includes the Projects share-flow mount used by row-level Share actions", () => {
		expect(html).toContain('id="projectShareFlowMount"');
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
