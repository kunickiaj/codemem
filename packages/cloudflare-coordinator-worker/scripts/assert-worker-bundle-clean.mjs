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
	"@xenova/transformers",
	"better-sqlite3",
	"bonjour-service",
	"sqlite-vec",
];

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const bundlePath = process.argv[2];
	if (!bundlePath) throw new Error("Usage: node assert-worker-bundle-clean.mjs <bundle-path>");
	await assertWorkerBundleOutputClean(bundlePath);
	console.log(`Worker bundle import check passed: ${bundlePath}`);
}
