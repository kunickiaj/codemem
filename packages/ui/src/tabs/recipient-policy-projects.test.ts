import { expect, it } from "vitest";
import type { ProjectScopeInventoryProject } from "../lib/api/sync";
import { toReceivedProjectShares } from "./recipient-policy-projects";

it("defaults missing received-project origin devices for older inventory payloads", () => {
	const project: ProjectScopeInventoryProject = {
		cwd: null,
		display_project: "viewer",
		git_branch: null,
		git_remote: null,
		identity_source: "workspace_id",
		latest_session_at: null,
		mapping_id: null,
		matched_pattern: null,
		memory_count: 2,
		project: "viewer",
		read_only: true,
		read_only_reason: "peer_received",
		resolution_reason: "local_default",
		resolved_scope_id: "local-default",
		session_count: 0,
		statuses: ["received"],
		workspace_identity: "peer-received:scope:managed-project:test",
	};

	expect(toReceivedProjectShares([project])[0]?.originDevices).toEqual([]);
});
