/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";

describe("Sharing action states", () => {
	it("dims primary and secondary aria-disabled actions", () => {
		expect(html).toContain(
			'.settings-button[aria-disabled="true"],\n      .settings-save[aria-disabled="true"]',
		);
	});
});
