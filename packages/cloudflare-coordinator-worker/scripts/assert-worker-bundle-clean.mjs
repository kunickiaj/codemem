import { readdir, readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Extend this allowlist only when the Worker runtime and source graph require it.
const ALLOWED_NODE_IMPORTS = new Set(["node:crypto", "node:path"]);
const BARE_NODE_IMPORTS = new Set(
	builtinModules.filter((specifier) => !specifier.startsWith("node:")),
);
const FORBIDDEN_IMPORTS = [
	// Bundled npm packages are listed as intent and are also caught by the
	// default-deny node:* rule when they pull unsupported builtins into the Worker.
	"@codemem/embeddings",
	"@xenova/transformers",
	"better-sqlite3",
	"bonjour-service",
	"sqlite-vec",
];
// Add every forbidden package that is linked from this workspace rather than node_modules.
const FORBIDDEN_WORKSPACE_PATHS = new Map([
	["@codemem/embeddings", ["/../embeddings/", "/packages/embeddings/"]],
]);

function isForbiddenImport(specifier) {
	const normalizedNodeImport = specifier.startsWith("node:")
		? specifier
		: BARE_NODE_IMPORTS.has(specifier)
			? `node:${specifier}`
			: null;
	if (normalizedNodeImport) return !ALLOWED_NODE_IMPORTS.has(normalizedNodeImport);
	return FORBIDDEN_IMPORTS.some(
		(forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
	);
}

export function findForbiddenWorkerImports(source) {
	const specifiers = new Set();
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/gu,
		/\bimport\s*["']([^"']+)["']/gu,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
		/\b(?:__)?require\d*\s*\(\s*["']([^"']+)["']\s*\)/gu,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			if (match[1]) specifiers.add(match[1]);
		}
	}
	return [...specifiers].filter(isForbiddenImport).toSorted();
}

function packageNameFromModulePath(modulePath) {
	const normalizedPath = `/${modulePath.replaceAll("\\", "/")}`;
	return FORBIDDEN_IMPORTS.find(
		(forbidden) =>
			normalizedPath.includes(`/node_modules/${forbidden}/`) ||
			normalizedPath.endsWith(`/node_modules/${forbidden}`) ||
			FORBIDDEN_WORKSPACE_PATHS.get(forbidden)?.some((workspacePath) =>
				normalizedPath.includes(workspacePath),
			),
	);
}

export function findForbiddenWorkerMetafileModules(metafile) {
	const forbiddenModules = new Set();
	for (const [modulePath, metadata] of Object.entries(metafile?.inputs ?? {})) {
		const packageName = packageNameFromModulePath(modulePath);
		if (packageName) forbiddenModules.add(packageName);
		if (!metadata || typeof metadata !== "object") {
			throw new TypeError(`Worker bundle metafile has invalid entry for: ${modulePath}`);
		}
		if (!Array.isArray(metadata.imports)) {
			throw new TypeError(`Worker bundle metafile has invalid imports for: ${modulePath}`);
		}
		for (const imported of metadata.imports) {
			if (!imported || typeof imported !== "object") continue;
			for (const specifier of [imported.original, imported.path]) {
				if (typeof specifier !== "string") continue;
				const importedPackage = packageNameFromModulePath(specifier);
				if (importedPackage) forbiddenModules.add(importedPackage);
				else if (isForbiddenImport(specifier)) forbiddenModules.add(specifier);
			}
		}
	}
	return [...forbiddenModules].toSorted();
}

export async function assertWorkerBundleClean(bundlePath) {
	const source = await readFile(bundlePath, "utf8");
	const forbiddenImports = findForbiddenWorkerImports(source);
	if (forbiddenImports.length > 0) {
		throw new Error(`Worker bundle contains forbidden imports: ${forbiddenImports.join(", ")}`);
	}
}

async function listJavaScriptFiles(path) {
	const entry = await stat(path);
	if (entry.isFile()) return path.endsWith(".js") ? [path] : [];
	const files = [];
	for (const child of await readdir(path, { withFileTypes: true })) {
		const childPath = join(path, child.name);
		if (child.isDirectory()) files.push(...(await listJavaScriptFiles(childPath)));
		else if (child.isFile() && child.name.endsWith(".js")) files.push(childPath);
	}
	return files.toSorted();
}

export async function assertWorkerBundleOutputClean(bundlePath) {
	const files = await listJavaScriptFiles(bundlePath);
	if (files.length === 0) throw new Error(`Worker bundle contains no JavaScript files: ${bundlePath}`);
	for (const file of files) await assertWorkerBundleClean(file);
}

export async function assertWorkerBundleMetafileClean(metafilePath) {
	const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
	if (
		!metafile?.inputs ||
		typeof metafile.inputs !== "object" ||
		Array.isArray(metafile.inputs) ||
		Object.keys(metafile.inputs).length === 0
	) {
		throw new Error(`Worker bundle metafile has no inputs: ${metafilePath}`);
	}
	const forbiddenModules = findForbiddenWorkerMetafileModules(metafile);
	if (forbiddenModules.length > 0) {
		throw new Error(
			`Worker bundle graph contains forbidden modules: ${forbiddenModules.join(", ")}`,
		);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const bundlePath = process.argv[2];
	const metafilePath = process.argv[3];
	if (!bundlePath || !metafilePath) {
		throw new Error(
			"Usage: node assert-worker-bundle-clean.mjs <bundle-path> <metafile-path>",
		);
	}
	await assertWorkerBundleOutputClean(bundlePath);
	await assertWorkerBundleMetafileClean(metafilePath);
	console.log(`Worker bundle import check passed: ${bundlePath}`);
}
