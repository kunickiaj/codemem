import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPiExtensionConfig, loadPiExtensionConfig } from "./config.js";

describe("loadPiExtensionConfig", () => {
	const prev = { ...process.env };

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in prev)) delete process.env[key];
		}
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("reads pi.* from config file and allows CODEMEM_PI_* overrides", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-pi-cfg-"));
		const path = join(dir, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				pi: {
					tools_mode: "native",
					inject_prompts: true,
					file_context: false,
				},
			}),
		);
		process.env.CODEMEM_CONFIG = path;
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		delete process.env.CODEMEM_PI_INJECT_PROMPTS;
		delete process.env.CODEMEM_PI_FILE_CONTEXT;

		const cfg = loadPiExtensionConfig(process.env);
		expect(cfg.toolsMode).toBe("native");
		expect(cfg.injectPrompts).toBe(true);
		expect(cfg.fileContext).toBe(false);

		process.env.CODEMEM_PI_TOOLS_MODE = "mcp-adapter";
		process.env.CODEMEM_PI_FILE_CONTEXT = "1";
		const overridden = loadPiExtensionConfig(process.env);
		expect(overridden.toolsMode).toBe("mcp-adapter");
		expect(overridden.fileContext).toBe(true);
	});

	it("defaultPiExtensionConfig merges overrides", () => {
		const cfg = defaultPiExtensionConfig({ toolsMode: "mcp-adapter", injectLimit: 3 });
		expect(cfg.toolsMode).toBe("mcp-adapter");
		expect(cfg.injectLimit).toBe(3);
		expect(cfg.injectPrompts).toBe(true);
	});
});
