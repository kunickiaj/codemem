import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

function shellScripts(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return shellScripts(path);
		return entry.name.endsWith(".sh") ? [path] : [];
	});
}

/** Each `invitation accept` command in a script, with its continuation lines joined. */
function acceptCommands(source: string): string[] {
	return source
		.replace(/\\\n/g, " ")
		.split("\n")
		.filter((line) => /coordinator invitation accept\b/.test(line) && !line.trim().startsWith("#"));
}

it("confirms the coordinator join in every checked-in script that accepts an invitation", () => {
	// A script has no terminal to ask in, so an accept that joins must confirm it explicitly.
	const unconfirmed = shellScripts(join(repoRoot, "scripts")).flatMap((path) =>
		acceptCommands(readFileSync(path, "utf8"))
			.filter((command) => !command.includes("--review "))
			.filter((command) => !command.includes("--confirm-coordinator-join"))
			.map(() => relative(repoRoot, path)),
	);

	expect(unconfirmed).toEqual([]);
});
