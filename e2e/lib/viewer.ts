import { assert, assertStatus } from "./assert.js";
import { CLI_PREFIX, parseJson } from "./coordinator.js";
import type { ScenarioContext } from "./scenario-context.js";
import { waitFor } from "./wait.js";

/** Viewer and sync service helpers shared by scenarios that drive the Viewer API. */

export function startServer(
	ctx: ScenarioContext,
	service: string,
	artifact: string,
): void {
	const staticResult = ctx.compose.exec(
		service,
		[
			"node",
			"--input-type=module",
			"-e",
			"import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('/tmp/viewer-static', { recursive: true }); writeFileSync('/tmp/viewer-static/index.html', '<!doctype html><title>e2e</title>');",
		],
		`${artifact}-static`,
		30_000,
	);
	assertStatus(staticResult.status, 0, `${service} static preparation failed`);
	const command = [
		"env",
		"CODEMEM_VIEWER_STATIC_DIR=/tmp/viewer-static",
		...CLI_PREFIX,
		"service",
		"start",
		"--foreground",
		"--db-path",
		"/data/mem.sqlite",
		"--host",
		"0.0.0.0",
		"--port",
		"38888",
	];
	const result = ctx.compose.execDetachedLogged(service, command, artifact);
	assertStatus(result.status, 0, `${service} viewer/sync server failed to start`);
}

export function restartServer(
	ctx: ScenarioContext,
	service: string,
	artifact: string,
): void {
	const restarted = ctx.compose.restart(service, `${artifact}-container`);
	assertStatus(restarted.status, 0, `${service} container failed to restart`);
	startServer(ctx, service, `${artifact}-start`);
}

export function readConfig(
	ctx: ScenarioContext,
	service: string,
	artifact: string,
): Record<string, unknown> {
	const result = ctx.compose.exec(
		service,
		[
			"node",
			"--input-type=module",
			"-e",
			"import { readFileSync } from 'node:fs'; console.log(readFileSync('/config/codemem.json', 'utf8'));",
		],
		artifact,
		30_000,
	);
	assertStatus(result.status, 0, `${service} config read failed`);
	return parseJson<Record<string, unknown>>(result.stdout, artifact);
}

export async function request<T>(
	ctx: ScenarioContext,
	service: string,
	path: string,
	artifact: string,
	body?: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
	const script = `const response = await fetch(${JSON.stringify(`http://127.0.0.1:38888${path}`)}, ${JSON.stringify(
		body
			? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
			: {},
	)}); const text = await response.text(); console.log(JSON.stringify({ status: response.status, body: text ? JSON.parse(text) : null }));`;
	const result = ctx.compose.exec(service, ["node", "--input-type=module", "-e", script], artifact, 60_000);
	assertStatus(result.status, 0, `${service} request ${path} failed`);
	return parseJson<{ status: number; body: T }>(result.stdout, artifact);
}

export async function waitForServer(ctx: ScenarioContext, service: string, artifact: string): Promise<void> {
	await waitFor(
		async () => {
			const response = await request(ctx, service, "/api/stats", artifact);
			assert(response.status === 200, `${service} viewer is not ready`);
		},
		{ description: `${service} viewer readiness`, timeoutMs: 120_000, intervalMs: 2_000 },
	);
}

export function syncOnce(ctx: ScenarioContext, service: string, artifact: string, peerDeviceId?: string): void {
	const peerArgs = peerDeviceId ? ["--peer", peerDeviceId] : [];
	const result = ctx.compose.exec(
		service,
		[
			...CLI_PREFIX,
			"sync",
			"once",
			"--db-path",
			"/data/mem.sqlite",
			...peerArgs,
			"--json",
		],
		artifact,
		180_000,
		true,
	);
	const attempts =
		result.status === 0
			? null
			: ctx.compose.exec(
					service,
					[...CLI_PREFIX, "sync", "attempts", "--db-path", "/data/mem.sqlite", "--json"],
					`${artifact}-attempts`,
					60_000,
					true,
				);
	assert(
		result.status === 0 || result.stderr.includes("no accepted peers"),
		`${service} sync once failed: ${result.stderr || result.stdout}${attempts?.stdout ? `\nAttempts:\n${attempts.stdout}` : ""}`,
	);
}

export async function waitForPeerTransport(
	ctx: ScenarioContext,
	options: { service: string; peerDeviceId: string; artifact: string },
): Promise<void> {
	// Discovery can still reflect a snapshot from before the recipient started.
	await waitFor(
		async () => {
			const status = await request<{
				peers: Array<{ peer_device_id: string; pinned: boolean; addresses: string[] }>;
			}>(ctx, options.service, "/api/sync/status?includeDiagnostics=true", options.artifact);
			assert(status.status === 200, "owner presence refresh failed before recipient sync");
			const peer = status.body.peers.find((item) => item.peer_device_id === options.peerDeviceId);
			assert(
				peer?.pinned && peer.addresses.length > 0,
				"owner has not discovered the pinned recipient's sync address",
			);
		},
		{
			description: "owner transport discovery before recipient sync",
			timeoutMs: 120_000,
			intervalMs: 2_000,
		},
	);
}
