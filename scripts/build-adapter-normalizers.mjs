#!/usr/bin/env node

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputRoot = repoRoot;

const targets = [
	{
		entry: "packages/core/src/claude-hooks.ts",
		output: "plugins/claude/scripts/codemem-normalizer.mjs",
	},
	{
		entry: "packages/core/src/codex-hooks.ts",
		output: "plugins/codex/scripts/codemem-normalizer.mjs",
	},
];

function parseOutputRoot(argv) {
	const index = argv.indexOf("--out-dir");
	if (index === -1) return defaultOutputRoot;
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error("--out-dir requires a path");
	return resolve(value);
}

async function buildTarget(target, outputRoot) {
	const finalPath = resolve(outputRoot, target.output);
	const temporaryDirectory = `${finalPath}.build`;
	await rm(temporaryDirectory, { recursive: true, force: true });
	await mkdir(temporaryDirectory, { recursive: true });

	try {
		await build({
			configFile: false,
			logLevel: "silent",
			build: {
				emptyOutDir: true,
				minify: false,
				outDir: temporaryDirectory,
				reportCompressedSize: false,
				ssr: resolve(repoRoot, target.entry),
				target: "node24",
				rollupOptions: {
					output: {
						entryFileNames: "normalizer.mjs",
					},
				},
			},
		});
		await mkdir(dirname(finalPath), { recursive: true });
		await rm(finalPath, { force: true });
		await rename(resolve(temporaryDirectory, "normalizer.mjs"), finalPath);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export async function buildAdapterNormalizers(outputRoot = defaultOutputRoot) {
	for (const target of targets) await buildTarget(target, outputRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await buildAdapterNormalizers(parseOutputRoot(process.argv.slice(2)));
}
