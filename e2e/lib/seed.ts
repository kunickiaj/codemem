import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assert } from "./assert.js";
import type { ComposeManager } from "./compose.js";

export type SeedMode = "empty" | "fixture-small" | "fixture-large" | "local-import";

const CLI_PREFIX = ["pnpm", "exec", "tsx", "--conditions", "source", "packages/cli/src/index.ts"];
const TSX_PREFIX = ["pnpm", "exec", "tsx", "--conditions", "source"];

export function seedPeer(
	compose: ComposeManager,
	artifactsDir: string,
	service: string,
	mode: SeedMode,
	artifactName: string,
	dbPath = "/data/mem.sqlite",
): void {
	if (mode === "local-import") {
		const inputFile = process.env.CODEMEM_E2E_LOCAL_IMPORT?.trim();
		assert(inputFile, "CODEMEM_E2E_LOCAL_IMPORT is required for local-import seed mode");
		const resolvedInput = resolve(inputFile);
		assert(existsSync(resolvedInput), `Local import payload not found: ${resolvedInput}`);
		const containerPath = `${service}:/tmp/${basename(resolvedInput)}`;
		compose.copyToContainer(resolvedInput, containerPath, `${artifactName}-copy-local-import`);
		compose.exec(
			service,
			[...CLI_PREFIX, "import-memories", `/tmp/${basename(resolvedInput)}`, "--db-path", dbPath],
			`${artifactName}-import-local-import`,
			300_000,
		);
		return;
	}

	compose.exec(
		service,
		[
			...TSX_PREFIX,
			"e2e/seeds/load.ts",
			"--mode",
			mode,
			"--db-path",
			dbPath,
		],
		artifactName,
		300_000,
	);

	compose.copyFromContainer(
		`${service}:${dbPath}`,
		join(artifactsDir, "db", `${service}-${mode}.sqlite`),
		`${artifactName}-db-snapshot`,
	);
}
