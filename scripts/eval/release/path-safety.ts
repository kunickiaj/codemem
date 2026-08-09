import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isPathInside(parent: string, candidate: string): boolean {
	const path = relative(parent, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function isPathOutside(parent: string, candidate: string): boolean {
	return !isPathInside(parent, candidate);
}

async function projectedRealPath(path: string): Promise<string> {
	const missing: string[] = [];
	let current = resolve(path);
	while (true) {
		try {
			return resolve(await realpath(current), ...missing.toReversed());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			missing.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			current = parent;
		}
	}
}

export async function resolvePathWithinAllowedRoots(
	repositoryRoot: string,
	candidatePath: string,
	allowedRelativeRoots: readonly string[],
): Promise<string> {
	const lexicalRoot = resolve(repositoryRoot);
	const lexicalCandidate = resolve(lexicalRoot, candidatePath);
	const lexicalAllowedRoot = allowedRelativeRoots
		.map((path) => resolve(lexicalRoot, path))
		.find((path) => isPathInside(path, lexicalCandidate));
	if (!lexicalAllowedRoot)
		throw new TypeError("Path is outside the allowed release-eval output roots");
	const [actualRoot, actualAllowedRoot, actualCandidate] = await Promise.all([
		projectedRealPath(lexicalRoot),
		projectedRealPath(lexicalAllowedRoot),
		projectedRealPath(lexicalCandidate),
	]);
	if (
		!isPathInside(actualRoot, actualAllowedRoot) ||
		!isPathInside(actualAllowedRoot, actualCandidate)
	) {
		throw new TypeError("Path resolves outside the allowed release-eval output roots");
	}
	return lexicalCandidate;
}
