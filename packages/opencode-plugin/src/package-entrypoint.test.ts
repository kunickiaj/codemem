import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin as OpenCodeV2 } from "@opencode/plugin";
import type { Plugin as OpenCodeV1Plugin } from "@opencode-ai/plugin";
import { expect, it } from "vitest";
import CodememDualPlugin, { CodememPlugin, OpencodeMemPlugin } from "../index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const minimumOpenCodeVersion = "1.18.29";
const pinnedOpenCodeV2Version = "2.0.2";

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
	expect(packageManifest.dependencies["@opencode/plugin"]).toBe(pinnedOpenCodeV2Version);
	expect(packageManifest.devDependencies["@opencode/plugin"]).toBeUndefined();
	expect(packageManifest.exports["./rpc"]).toEqual({
		types: "./rpc.d.ts",
		import: "./rpc.js",
	});
	expect(packageManifest.exports["./tui"]).toEqual({
		types: "./tui.d.ts",
		import: "./tui.js",
	});
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
	expect(repositoryWrapper.default.server).toBe(packageEntrypoint.CodememPlugin);
});

it("keeps repository lint feedback on V1 and makes it an explicit V2 no-op", async () => {
	const lintFeedbackEntrypoint = await import("./lint-feedback.js");
	const repositoryWrapperUrl = pathToFileURL(
		path.join(repositoryRoot, ".opencode/plugins/lint-feedback.js"),
	).href;
	const repositoryWrapper = await import(repositoryWrapperUrl);

	expect(Object.keys(repositoryWrapper)).toEqual(["default"]);
	expect(repositoryWrapper.default.id).toBe("codemem-lint-feedback");
	expect(repositoryWrapper.default.server).toBe(lintFeedbackEntrypoint.default);
	expect(await repositoryWrapper.default.setup({})).toBeUndefined();
});
