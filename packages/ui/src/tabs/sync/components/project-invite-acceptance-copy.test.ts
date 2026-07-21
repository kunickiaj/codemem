/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../../../../static/index.html?raw";

describe("project invite acceptance copy", () => {
	it("asks for Person and friendly device identity without internal access language", () => {
		const start = html.indexOf('id="syncProjectInviteReview"');
		const end = html.indexOf('id="syncJoinButton"', start);
		const acceptance = html.slice(start, end);

		expect(acceptance).toContain("Your name");
		expect(acceptance).toContain("This device");
		expect(acceptance).not.toMatch(/UUID|Space|scope|filter|cursor/iu);
	});
});
