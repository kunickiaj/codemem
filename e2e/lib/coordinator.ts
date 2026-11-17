import { assertStatus } from "./assert.js";
import type { ScenarioContext } from "./scenario-context.js";

export const CLI_PREFIX = ["pnpm", "exec", "tsx", "--conditions", "source", "packages/cli/src/index.ts"];
export const GROUP_ID = "e2e-team";
export const ADMIN_SECRET = "e2e-admin-secret";
export const COORDINATOR_URL = "http://coordinator:7347";

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
): PeerIdentity {
	const result = ctx.compose.exec(
		service,
		["pnpm", "exec", "tsx", "--conditions", "source", "e2e/scripts/peer-identity.ts"],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to read identity for ${service}`);
	return parseJson<PeerIdentity>(result.stdout, `${service}:identity`);
}

export interface PeerIdentity {
	device_id: string;
	fingerprint: string;
	public_key: string;
}

/** Enrolls a device the way an admin does on the coordinator host. This is the
 * supported way to connect a device without sharing Projects. */
export function enrollPeerDevice(
	ctx: ScenarioContext,
	options: {
		groupId: string;
		identity: PeerIdentity;
		artifactName: string;
		coordinatorService?: string;
	},
) {
	const result = ctx.compose.exec(
		options.coordinatorService ?? "coordinator",
		[
			...CLI_PREFIX,
			"coordinator",
			"device",
			"enroll",
			options.groupId,
			options.identity.device_id,
			"--fingerprint",
			options.identity.fingerprint,
			"--public-key",
			options.identity.public_key,
			"--db-path",
			"/data/coordinator.sqlite",
			"--json",
		],
		options.artifactName,
		120_000,
	);
	assertStatus(
		result.status,
		0,
		`failed to enroll ${options.identity.device_id} in ${options.groupId}`,
	);
}

/** Legacy fixture: mints a connection-only invitation whose join needs admin
 * approval. The CLI no longer creates these, but devices still accept existing
 * ones, so the coordinator admin API mints it here to keep that path covered. */
export function createLegacyApprovalInvite(
	ctx: ScenarioContext,
	options: { service: string; groupId: string; artifactName: string },
): string {
	const request = {
		url: `${COORDINATOR_URL}/v1/admin/invites`,
		adminSecret: ADMIN_SECRET,
		body: {
			group_id: options.groupId,
			invite_kind: "legacy_enrollment",
			policy: "approval_required",
			coordinator_url: COORDINATOR_URL,
		},
	};
	const script = `const request = ${JSON.stringify(request)}; const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); const res = await fetch(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codemem-Coordinator-Admin': request.adminSecret }, body: JSON.stringify({ ...request.body, expires_at: expiresAt }) }); console.log(await res.text()); process.exit(res.ok ? 0 : 1);`;
	const result = ctx.compose.exec(
		options.service,
		["node", "--input-type=module", "-e", script],
		options.artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to create legacy invite for ${options.groupId}`);
	const created = parseJson<{
		encoded?: string;
		invite?: { invite_kind?: string; policy?: string };
	}>(result.stdout, `legacy invite for ${options.groupId}`);
	if (
		!created.encoded ||
		created.invite?.invite_kind !== "legacy_enrollment" ||
		created.invite?.policy !== "approval_required"
	) {
		throw new Error(
			`coordinator did not return an approval-required legacy invite for ${options.groupId}`,
		);
	}
	return created.encoded;
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
