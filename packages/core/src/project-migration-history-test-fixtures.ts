import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

// Full tagged schemas, including additive columns that didn't bump user_version.
// Pin the commits so the tests don't need tag names, a network or old npm installs.
export const releases = [
	["0.19.0", "299687e81d43c22a4286b62403bde96f29939a53", 6],
	["0.29.0", "c411f685946a466af5041316735d50435d1818e5", 7],
	["0.30.0", "21eac98911c38ad225d50d17b5aef2db176bdafd", 8],
	["0.43.0", "4c47ee433812b71e03f1a12f7235c95fd1307c2a", 20],
	["0.47.0", "662effec8e9c69724d3a391db4e50eaabda1a899", 21],
	["0.49.1", "2e74a02b3a8ddadd462d3259b5d5d3474ce7a05e", 21],
	["0.50.0-beta.2", "07d78653d6ffc1574d43f5eed74c6c3bc8dcab4c", 26],
	["0.50.0-beta.3", "f60c4284712c21287165c6ea2e02af0b284087f5", 26],
	["0.50.0-beta.4", "24db7c6f1587e577c3752d0f8c134f6c24a6c34b", 26],
] as const;

const root = fileURLToPath(new URL("../../../", import.meta.url));

export function createHistoricalStore(
	directory: string,
	release: (typeof releases)[number],
): string {
	const path = join(directory, "historical.sqlite");
	if (release[0] === "0.19.0") {
		const db = new DatabaseSync(path);
		try {
			db.exec(
				readFileSync(new URL("./fixtures/project-migration-v0.19.sql", import.meta.url), "utf8"),
			);
		} finally {
			db.close();
		}
		return path;
	}
	const archive = execFileSync(
		"git",
		[
			"archive",
			release[1],
			"packages/core/src",
			"packages/core/package.json",
			":(exclude)*.test.ts",
		],
		{
			cwd: root,
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
	const core = join(directory, "packages/core");
	symlinkSync(join(root, "packages/core/node_modules"), join(core, "node_modules"), "dir");
	const home = join(directory, "home");
	mkdirSync(home);
	const module = pathToFileURL(join(core, "src/db.ts")).href;
	execFileSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`import { connect, ensureAdditiveSchemaCompatibility } from ${JSON.stringify(module)};
		 const db = connect(process.argv[1]); ensureAdditiveSchemaCompatibility(db); db.close();`,
			path,
		],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				CODEMEM_CONFIG: join(home, "absent"),
				CODEMEM_EMBEDDING_DISABLED: "1",
			},
		},
	);
	return path;
}
