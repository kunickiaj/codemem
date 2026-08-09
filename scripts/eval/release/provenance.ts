import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { compareCodePoints, digest } from "./canonical.js";
import { parseComponentFileSetManifest } from "./manifest.js";
import { isPathInside } from "./path-safety.js";
import type { ComponentDigests, ComponentFileSetManifestV1, Digest, JsonValue } from "./types.js";

export type EvaluatorComponentName = "evaluator" | "retrieval" | "injection";

export function digestComponentContents(
	manifest: ComponentFileSetManifestV1,
	contents: Record<string, string>,
	component: EvaluatorComponentName = "evaluator",
): Digest {
	const checked = parseComponentFileSetManifest(manifest);
	const componentFiles = checked.components[component];
	if (!componentFiles?.length)
		throw new TypeError(`Component file-set manifest is missing ${component}`);
	const files = componentFiles.toSorted(compareCodePoints).map((path) => {
		if (!(path in contents)) throw new TypeError(`Missing content for component file: ${path}`);
		return { path, content_digest: digest(contents[path] as string) };
	});
	return digest({
		schema_version: checked.schema_version,
		component,
		files,
	} as JsonValue);
}

export async function digestEvaluatorComponent(
	repositoryRoot: string,
	manifest: ComponentFileSetManifestV1,
): Promise<Digest> {
	const checked = parseComponentFileSetManifest(manifest);
	const root = await realpath(repositoryRoot);
	const entries = await Promise.all(
		checked.components.evaluator.map(async (path) => {
			const actual = await realpath(resolve(root, path));
			if (!isPathInside(root, actual))
				throw new TypeError(`Component file resolves outside the repository: ${path}`);
			return [path, await readFile(actual, "utf8")] as const;
		}),
	);
	return digestComponentContents(checked, Object.fromEntries(entries));
}

export async function digestScopedEvaluatorComponent(
	repositoryRoot: string,
	manifest: ComponentFileSetManifestV1,
	component: EvaluatorComponentName,
): Promise<Digest> {
	const checked = parseComponentFileSetManifest(manifest);
	const paths = checked.components[component];
	if (!paths?.length) throw new TypeError(`Component file-set manifest is missing ${component}`);
	const root = await realpath(repositoryRoot);
	const entries = await Promise.all(
		paths.map(async (path) => {
			const actual = await realpath(resolve(root, path));
			if (!isPathInside(root, actual))
				throw new TypeError(`Component file resolves outside the repository: ${path}`);
			return [path, await readFile(actual, "utf8")] as const;
		}),
	);
	return digestComponentContents(checked, Object.fromEntries(entries), component);
}

export async function digestReleaseComponents(
	repositoryRoot: string,
	manifest: ComponentFileSetManifestV1,
): Promise<ComponentDigests> {
	const [observer, retrieval, injection] = await Promise.all([
		digestEvaluatorComponent(repositoryRoot, manifest),
		digestScopedEvaluatorComponent(repositoryRoot, manifest, "retrieval"),
		digestScopedEvaluatorComponent(repositoryRoot, manifest, "injection"),
	]);
	return { observer, retrieval, injection };
}
