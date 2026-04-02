import { assertStatus } from "./assert.js";
import type { ScenarioContext } from "./scenario-context.js";

export const CLI_PREFIX = ["pnpm", "exec", "tsx", "--conditions", "source", "packages/cli/src/index.ts"];
export const GROUP_ID = "e2e-team";
export const ADMIN_SECRET = "e2e-admin-secret";

export function parseJson<T>(raw: string, label: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new Error(
			`Failed to parse JSON for ${label}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function readPeerIdentity(
	ctx: ScenarioContext,
	service: string,
	artifactName: string,
): { device_id: string; fingerprint: string; public_key: string } {
	const result = ctx.compose.exec(
		service,
		["pnpm", "exec", "tsx", "--conditions", "source", "e2e/scripts/peer-identity.ts"],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to read identity for ${service}`);
	return parseJson<{ device_id: string; fingerprint: string; public_key: string }>(
		result.stdout,
		`${service}:identity`,
	);
}

export function writePeerConfig(
	ctx: ScenarioContext,
	service: string,
	values: Record<string, unknown>,
	artifactName: string,
) {
	const script = `import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('/config', { recursive: true }); writeFileSync('/config/codemem.json', JSON.stringify(${JSON.stringify(values)}, null, 2));`;
	const result = ctx.compose.exec(
		service,
		["node", "--input-type=module", "-e", script],
		artifactName,
		30_000,
	);
	assertStatus(result.status, 0, `failed to write config for ${service}`);
}

export function fetchCoordinatorSnapshot<T>(
	ctx: ScenarioContext,
	service: string,
	artifactName: string,
): T {
	const result = ctx.compose.exec(
		service,
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/coordinator-status.ts",
			"--db-path",
			"/data/mem.sqlite",
			"--run-tick",
		],
		artifactName,
		120_000,
	);
	assertStatus(result.status, 0, `failed to fetch coordinator snapshot from ${service}`);
	return parseJson<T>(result.stdout, `${service}:coordinator-snapshot`);
}
