import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(packageRoot, ".opencode", "plugins");
const helperRoot = path.join(packageRoot, ".opencode", "lib");

const readPluginFile = (name: string) => readFile(path.join(pluginRoot, name), "utf8");
const readHelperFile = (name: string) => readFile(path.join(helperRoot, name), "utf8");

describe("shared runtime boundary", () => {
	it("keeps helper modules outside OpenCode's auto-load directory", async () => {
		const [pluginFiles, helperFiles] = await Promise.all([
			readdir(pluginRoot),
			readdir(helperRoot),
		]);

		expect(pluginFiles.filter((name) => /\.(?:js|ts)$/u.test(name)).sort()).toEqual(["codemem.js"]);
		expect(helperFiles).toEqual(expect.arrayContaining(["host-contract.js", "runtime.js"]));
	});

	it("keeps the OpenCode SDK import in the V1 adapter", async () => {
		const [adapter, runtime, contract] = await Promise.all([
			readPluginFile("codemem.js"),
			readHelperFile("runtime.js"),
			readHelperFile("host-contract.js"),
		]);

		expect(adapter).toContain('from "@opencode-ai/plugin"');
		expect(runtime).not.toMatch(/@opencode(?:-ai)?\/plugin/);
		expect(contract).not.toMatch(/@opencode(?:-ai)?\/plugin/);
	});

	it("exports one named host-neutral runtime constructor", async () => {
		const runtimeUrl = pathToFileURL(path.join(helperRoot, "runtime.js")).href;
		const runtime = await import(runtimeUrl);

		expect(typeof runtime.createCodememRuntime).toBe("function");
	});

	it("translates OpenCode 1 events into the runtime contract", async () => {
		const adapterUrl = pathToFileURL(path.join(pluginRoot, "codemem.js")).href;
		const adapter = await import(adapterUrl);
		const part = { id: "part-1", sessionID: "session-1", type: "text" };
		const event = { type: "message.part.updated", properties: { part } };

		expect(adapter.__v1AdapterTestUtils.translateV1Event(event)).toEqual({
			type: "message.part.updated",
			sessionID: "session-1",
			messageInfo: null,
			part,
			usage: null,
			raw: event,
		});
	});

	it("rejects runtime tool argument types unsupported by OpenCode 1", async () => {
		const adapterUrl = pathToFileURL(path.join(pluginRoot, "codemem.js")).href;
		const adapter = await import(adapterUrl);

		expect(() =>
			adapter.__v1AdapterTestUtils.createV1Tool({
				description: "unsupported contract",
				args: { query: { type: "string", optional: true } },
				execute: async () => "unused",
			}),
		).toThrow("Unsupported OpenCode 1 tool argument: query:string");
	});

	it("keeps checkout wrappers as re-exports of the canonical V1 adapter", async () => {
		const repositoryRoot = path.resolve(packageRoot, "../..");
		const [repositoryWrapper, cliWrapper] = await Promise.all([
			readFile(path.join(repositoryRoot, ".opencode/plugins/codemem.js"), "utf8"),
			readFile(path.join(repositoryRoot, "packages/cli/.opencode/plugins/codemem.js"), "utf8"),
		]);

		expect(repositoryWrapper.trim()).toBe(
			'export { default } from "../../packages/opencode-plugin/.opencode/plugins/codemem.js";',
		);
		const version = cliWrapper.match(/^const PINNED_BACKEND_VERSION = "([^"]+)";/)?.[1];
		expect(version).toBeDefined();
		expect(cliWrapper.trim()).toBe(`const PINNED_BACKEND_VERSION = "${version}";

export {
	default,
	CodememPlugin,
	OpencodeMemPlugin,
	__testUtils,
	buildInjectionToastMessage,
} from "../../../opencode-plugin/.opencode/plugins/codemem.js";`);
		expect(repositoryWrapper).not.toContain("runtime.js");
		expect(cliWrapper).not.toContain("runtime.js");
	});
});
