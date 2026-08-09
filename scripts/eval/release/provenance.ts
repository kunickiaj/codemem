import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { compareCodePoints, digest } from "./canonical.js";
import { parseComponentFileSetManifest } from "./manifest.js";
import { isPathInside } from "./path-safety.js";
import type { ComponentFileSetManifestV1, Digest, JsonValue } from "./types.js";

export function digestComponentContents(
	manifest: ComponentFileSetManifestV1,
	contents: Record<string, string>,
): Digest {
	const checked = parseComponentFileSetManifest(manifest);
	const files = checked.components.evaluator.toSorted(compareCodePoints).map((path) => {
		if (!(path in contents)) throw new TypeError(`Missing content for component file: ${path}`);
		return { path, content_digest: digest(contents[path] as string) };
	});
	return digest({
		schema_version: checked.schema_version,
		component: "evaluator",
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
