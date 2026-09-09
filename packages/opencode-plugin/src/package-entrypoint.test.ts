import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const minimumOpenCodeVersion = "1.18.29";

async function readJson(relativePath: string) {
	return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

it("keeps the OpenCode 1 SDK manifests aligned with the supported host floor", async () => {
	const packageManifest = await readJson("packages/opencode-plugin/package.json");
	const pluginRuntimeManifest = await readJson("packages/opencode-plugin/.opencode/package.json");
	const cliRuntimeManifest = await readJson("packages/cli/.opencode/package.json");

	expect(packageManifest.dependencies["@opencode-ai/plugin"]).toBe(minimumOpenCodeVersion);
	expect(packageManifest.engines.opencode).toBe(`>=${minimumOpenCodeVersion}`);
	expect(pluginRuntimeManifest.dependencies["@opencode-ai/plugin"]).toBe(minimumOpenCodeVersion);
	expect(cliRuntimeManifest.dependencies["@opencode-ai/plugin"]).toBe(minimumOpenCodeVersion);
});

it("loads the repository wrapper from the canonical package implementation", async () => {
	const packageEntrypointUrl = pathToFileURL(
		path.join(repositoryRoot, "packages/opencode-plugin/index.js"),
	).href;
	const repositoryWrapperUrl = pathToFileURL(
		path.join(repositoryRoot, ".opencode/plugins/codemem.js"),
	).href;

	const packageEntrypoint = await import(packageEntrypointUrl);
	const repositoryWrapper = await import(repositoryWrapperUrl);

	expect(Object.keys(repositoryWrapper)).toEqual(["default"]);
	expect(repositoryWrapper.default).toBe(packageEntrypoint.default);
});
