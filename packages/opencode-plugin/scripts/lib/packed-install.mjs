import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Packs this checkout's CLI, its workspace dependencies and the OpenCode plugin,
 * and installs the tarballs into a temporary prefix, the way
 * packages/cli/scripts/packed-artifact-smoke.mjs installs the CLI: hoisted, with
 * the optional embeddings runtime left out. npm uses an empty user config and a
 * cache inside the prefix, so the host's npm settings and credentials don't apply.
 * Run `pnpm build` first so each package's dist is current.
 */
const PACKAGES = ["core", "mcp-server", "viewer-server", "cli", "opencode-plugin"];
const NPM_REGISTRY = "https://registry.npmjs.org/";

function run(command, args, cwd, env) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout;
}

function packWorkspacePackage(workspaceRoot, name, destination) {
	const tarball = run("pnpm", ["pack", "--pack-destination", destination], join(workspaceRoot, "packages", name), process.env)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	if (!tarball || !existsSync(tarball)) throw new Error(`pnpm pack did not produce a tarball for ${name}`);
	return tarball;
}

/** Installed paths of the packed CLI entry point and OpenCode plugin. */
export function installPackedCodemem(workspaceRoot, root) {
	const cliDist = join(workspaceRoot, "packages/cli/dist/index.js");
	if (!existsSync(cliDist)) throw new Error("Run `pnpm build` before packing: packages/cli/dist is missing");
	const packedDir = join(root, "packed");
	const installDir = join(root, "install");
	mkdirSync(packedDir, { recursive: true });
	mkdirSync(installDir, { recursive: true });
	const tarballs = PACKAGES.map((name) => packWorkspacePackage(workspaceRoot, name, packedDir));
	const userConfig = join(root, "npmrc");
	writeFileSync(userConfig, "");
	run(
		"npm",
		["install", "--omit=optional", "--no-audit", "--no-fund", "--prefix", installDir, ...tarballs],
		installDir,
		{
			PATH: process.env.PATH ?? "",
			HOME: root,
			npm_config_userconfig: userConfig,
			npm_config_cache: join(root, "npm-cache"),
			npm_config_registry: NPM_REGISTRY,
			npm_config_install_strategy: "hoisted",
		},
	);
	const cliEntry = join(installDir, "node_modules/codemem/dist/index.js");
	const pluginRoot = join(installDir, "node_modules/@codemem/opencode-plugin");
	for (const path of [cliEntry, pluginRoot]) {
		if (!existsSync(path)) throw new Error(`Packed install is missing ${path}`);
	}
	return { cliEntry, pluginRoot };
}
