/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import html from "../static/index.html?raw";

describe("responsive Devices table accessibility", () => {
	it("visually hides narrow-screen headers without removing them from the accessibility tree", () => {
		const narrow = html.slice(html.indexOf("@media (max-width: 900px)"));

		expect(narrow).not.toContain(".devices-table-head { display: none; }");
		expect(narrow).toContain(".devices-table-head { position: absolute; width: 1px; height: 1px;");
	});
});
