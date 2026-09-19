/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";

describe("Advanced recovery layout", () => {
	it("keeps Sync now with the main status instructions", () => {
		const main = html.slice(
			html.indexOf('id="syncMainView"'),
			html.indexOf('id="syncDiagnosticsView"'),
		);
		const diagnostics = html.slice(
			html.indexOf('id="syncDiagnosticsView"'),
			html.indexOf('id="advancedSyncContent"'),
		);

		expect(main).toContain('id="syncNowButton"');
		expect(diagnostics).not.toContain('id="syncNowButton"');
	});
});
