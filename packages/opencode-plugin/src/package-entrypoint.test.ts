import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin as OpenCodeV2 } from "@opencode/plugin";
import type { Plugin as OpenCodeV1Plugin } from "@opencode-ai/plugin";
import { expect, it } from "vitest";
import CodememDualPlugin, { CodememPlugin, OpencodeMemPlugin } from "../index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const minimumOpenCodeVersion = "1.18.29";
const pinnedOpenCodeV2Version = "0.0.0-beta-19296";

async function readJson(relativePath: string) {
	return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

function assertOpenCodeContracts(
	entrypoint: OpenCodeV2.Plugin & { readonly server: OpenCodeV1Plugin },
) {
	return entrypoint;
}

it("exports one typed dual-host object while retaining V1 compatibility names", async () => {
	const entrypoint = assertOpenCodeContracts(CodememDualPlugin);

	expect(Object.keys(entrypoint).sort()).toEqual(["id", "server", "setup"]);
	expect(entrypoint.id).toBe("codemem");
	expect(entrypoint.server).toBe(CodememPlugin);
	expect(OpencodeMemPlugin).toBe(CodememPlugin);
	expect(entrypoint.setup).toBeTypeOf("function");
});

it("keeps the OpenCode 1 SDK manifests aligned with the supported host floor", async () => {
	const packageManifest = await readJson("packages/opencode-plugin/package.json");
	const pluginRuntimeManifest = await readJson("packages/opencode-plugin/.opencode/package.json");
	const cliRuntimeManifest = await readJson("packages/cli/.opencode/package.json");

	expect(packageManifest.dependencies["@opencode-ai/plugin"]).toBe(minimumOpenCodeVersion);
	expect(packageManifest.engines.opencode).toBe(`>=${minimumOpenCodeVersion}`);
	expect(pluginRuntimeManifest.dependencies["@opencode-ai/plugin"]).toBe(minimumOpenCodeVersion);
	expect(cliRuntimeManifest.dependencies["@opencode-ai/plugin"]).toBe(minimumOpenCodeVersion);
	expect(packageManifest.dependencies["@opencode/plugin"]).toBeUndefined();
	expect(packageManifest.devDependencies["@opencode/plugin"]).toBe(pinnedOpenCodeV2Version);
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
	expect(repositoryWrapper.default).toBe(packageEntrypoint.CodememPlugin);
	expect(packageEntrypoint.default.server).toBe(repositoryWrapper.default);
});
