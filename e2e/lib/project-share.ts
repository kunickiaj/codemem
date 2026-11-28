import { assert } from "./assert.js";
import type { ScenarioContext } from "./scenario-context.js";
import { readConfig, request, restartServer, waitForPeerTransport, waitForServer } from "./viewer.js";
import { waitFor } from "./wait.js";

export interface InventoryProject {
	workspace_identity: string;
	display_project: string;
	memory_count: number | null;
}

export interface ShareProjectsOptions {
	owner: string;
	recipient: string;
	recipientDeviceId: string;
	projects: InventoryProject[];
	/** Shared memories the owner's review must count, summed across the Projects. */
	expectedExistingMemories: number;
	/** When set, imported memories without a known author the review must report as left out. */
	expectedUnattributedImports?: number;
	teammateName: string;
	deviceName: string;
	artifactPrefix: string;
}

/** The owner's Project inventory, as the Viewer's Projects screen reads it. */
export async function listInventoryProjects(
	ctx: ScenarioContext,
	service: string,
	artifact: string,
): Promise<InventoryProject[]> {
	const inventory = await request<{ projects: InventoryProject[] }>(
		ctx,
		service,
		"/api/sync/projects?limit=50",
		artifact,
	);
	assert(inventory.status === 200, `${service} Project inventory failed: ${JSON.stringify(inventory.body)}`);
	return inventory.body.projects;
}

async function waitForDaemonSync(
	ctx: ScenarioContext,
	service: string,
	artifact: string,
	description: string,
): Promise<void> {
	await waitFor(
		async () => {
			const status = await request<{ daemon_state: string; daemon_last_ok_at?: string | null }>(
				ctx,
				service,
				"/api/sync/status?includeDiagnostics=true",
				artifact,
			);
			assert(status.status === 200, `${service} sync status failed`);
			assert(status.body.daemon_state !== "starting", `${service} sync is still starting`);
			assert(status.body.daemon_last_ok_at, `${service} sync has not completed`);
		},
		{ description, timeoutMs: 120_000, intervalMs: 2_000 },
	);
}

/**
 * Share Projects with a teammate's device through the supported Project invite
 * flow: review, create, accept on the recipient, then let the owner provision
 * each Project's own boundary. Returns once the share operation is active.
 */
export async function shareProjectsWithTeammate(
	ctx: ScenarioContext,
	options: ShareProjectsOptions,
): Promise<string> {
	const { owner, recipient, artifactPrefix: prefix } = options;
	const projectIds = options.projects.map((project) => project.workspace_identity);
	await waitForDaemonSync(ctx, owner, `${prefix}-owner-sync`, "owner sync before the Project invite");
	const preview = await request<{
		reviewed_project_set_digest: string;
		existing_memory_count: number;
		unattributed_import_count?: number;
	}>(
		ctx,
		owner,
		"/api/sync/project-invites/preview",
		`${prefix}-preview`,
		{ teammate_name: options.teammateName, project_ids: projectIds },
	);
	assert(preview.status === 200, `Project invite preview failed: ${JSON.stringify(preview.body)}`);
	assert(
		preview.body.existing_memory_count === options.expectedExistingMemories,
		`Project invite review counted ${preview.body.existing_memory_count} shared memories, expected ${options.expectedExistingMemories}`,
	);
	if (options.expectedUnattributedImports !== undefined) {
		assert(
			(preview.body.unattributed_import_count ?? 0) === options.expectedUnattributedImports,
			`Project invite review left out ${preview.body.unattributed_import_count} imported memories, expected ${options.expectedUnattributedImports}`,
		);
	}
	const created = await request<{
		operation_id: string;
		invite: { encoded: string };
		projects: Array<{ project_id: string }>;
	}>(ctx, owner, "/api/sync/project-invites", `${prefix}-create`, {
		teammate_name: options.teammateName,
		project_ids: projectIds,
		reviewed_project_set_digest: preview.body.reviewed_project_set_digest,
	});
	assert(created.status === 200, `Project invite creation failed: ${JSON.stringify(created.body)}`);
	assert(
		created.body.projects.map((project) => project.project_id).toSorted().join("\n") ===
			projectIds.toSorted().join("\n"),
		"Project invite does not contain exactly the reviewed Projects",
	);

	const accepted = await request<Record<string, unknown>>(ctx, recipient, "/api/sync/invites/import", `${prefix}-accept`, {
		invite: created.body.invite.encoded,
		recipient_name: options.teammateName,
		device_name: options.deviceName,
		// Joining turns off sync without a coordinator for this key; the journey accepts that.
		confirm_coordinator_join: true,
	});
	assert(accepted.status === 200, `Project invite acceptance failed: ${JSON.stringify(accepted.body)}`);
	assert(accepted.body.type === "project_share", `unexpected invite type: ${String(accepted.body.type)}`);
	assert(readConfig(ctx, recipient, `${prefix}-recipient-config`).sync_enabled === true, "acceptance did not enable sync");
	if (accepted.body.restart_required === true) {
		restartServer(ctx, recipient, `${prefix}-restart-recipient`);
		await waitForServer(ctx, recipient, `${prefix}-recipient-ready`);
	}
	await waitForDaemonSync(
		ctx,
		recipient,
		`${prefix}-recipient-sync`,
		"recipient sync after accepting the Project invite",
	);
	await waitForPeerTransport(ctx, {
		service: owner,
		peerDeviceId: options.recipientDeviceId,
		artifact: `${prefix}-owner-sees-recipient`,
	});

	// Advancing reconciles the acceptance and provisions each Project's boundary.
	// It waits while the owner cannot reach the recipient yet. The owner's own
	// maintenance may activate the share first, so check the stored state.
	const operationPath = `/api/sync/share-operations/${created.body.operation_id}`;
	await waitFor(
		async () => {
			const advanced = await request<{ error?: string }>(
				ctx,
				owner,
				`${operationPath}/advance`,
				`${prefix}-advance`,
				{},
			);
			const operation = await request<{ lifecycle?: { state?: string } }>(
				ctx,
				owner,
				operationPath,
				`${prefix}-operation`,
			);
			const state = operation.body.lifecycle?.state ?? "missing";
			assert(
				operation.status === 200 && state === "active",
				`Project share is not active yet: ${state} (advance: ${JSON.stringify(advanced.body.error ?? "ok")})`,
			);
		},
		{ description: "Project share activation", timeoutMs: 180_000, intervalMs: 3_000 },
	);
	return created.body.operation_id;
}
