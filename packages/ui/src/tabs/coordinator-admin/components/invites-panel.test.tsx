import type { ComponentChildren, VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../lib/state";
import { coordinatorAdminState } from "../data/state";
import { renderInvitesPanel } from "./invites-panel";

describe("legacy coordinator invite panel", () => {
	type TestNode = VNode<{
		children?: ComponentChildren;
		class?: string;
		disabled?: boolean;
	}>;

	function textContent(value: ComponentChildren): string {
		if (value == null || typeof value === "boolean") return "";
		if (typeof value === "string" || typeof value === "number") return String(value);
		if (Array.isArray(value)) return value.map(textContent).join("");
		return textContent((value as VNode).props.children);
	}

	function nodes(value: ComponentChildren): TestNode[] {
		if (
			value == null ||
			typeof value === "boolean" ||
			typeof value === "string" ||
			typeof value === "number"
		) {
			return [];
		}
		if (Array.isArray(value)) return value.flatMap(nodes);
		const node = value as TestNode;
		return [node, ...nodes(node.props.children)];
	}

	beforeEach(() => {
		state.lastCoordinatorAdminStatus = {
			active_group: "team-a",
			has_admin_secret: true,
			readiness: "ready",
		};
		state.lastShareOperations = [
			{
				operation_id: `share_${"a".repeat(40)}`,
				person: { actor_id: "actor-brian", display_name: "Brian" },
				devices: [],
				projects: [{ display_name: "codemem", existing_memory_count: 3 }],
				project_count: 1,
				lifecycle: {
					state: "active",
					label: "Up to date",
					explanation: "Existing memories and future activity are shared.",
					primary_action: null,
				},
				timestamps: {
					created_at: "2026-07-20T00:00:00Z",
					updated_at: "2026-07-20T00:01:00Z",
					accepted_at: "2026-07-20T00:00:30Z",
					invite_expires_at: "2026-07-27T00:00:00Z",
				},
			},
		];
		coordinatorAdminState.invitePending = false;
	});

	afterEach(() => {
		state.lastShareOperations = [];
		state.lastTeamInvite = null;
	});

	it("labels coordinator invites as legacy and reflects project sharing read-only", () => {
		const text = textContent(
			renderInvitesPanel({
				createInvite: vi.fn(),
				fresh: true,
				renderShell: vi.fn(),
				summary: { detail: "", readiness: "ready", title: "Ready" },
			}),
		);

		expect(text).toContain("Legacy coordinator invites");
		expect(text).toContain("do not add policy Team membership or grant Project access");
		expect(text).toContain("Brian");
		expect(text).toContain("codemem");
		expect(text).toContain("Up to date");
		expect(text).not.toContain("Share project");
	});

	it("keeps a previously generated invite copyable while fresh-state mutations are disabled", () => {
		state.lastTeamInvite = { encoded: "retained-invite", warnings: [] };
		const panel = renderInvitesPanel({
			createInvite: vi.fn(),
			fresh: false,
			renderShell: vi.fn(),
			summary: { detail: "Ready", readiness: "ready", title: "Ready" },
		});
		const panelNodes = nodes(panel);
		const copy = panelNodes.find((node) => node.props.class === "settings-button sync-action-copy");
		const create = panelNodes.find(
			(node) => textContent(node.props.children) === "Create legacy coordinator invite",
		);

		expect(textContent(panel)).toContain("Previously generated invites remain available to copy");
		expect(copy?.props.disabled).not.toBe(true);
		expect(create?.props.disabled).toBe(true);
	});

	it("uses setup guidance when coordinator administration is not configured", () => {
		const panel = renderInvitesPanel({
			createInvite: vi.fn(),
			fresh: false,
			renderShell: vi.fn(),
			summary: { detail: "Setup", readiness: "not_configured", title: "Setup required" },
		});

		expect(textContent(panel)).toContain("Finish coordinator setup first");
		expect(textContent(panel)).not.toContain("data are unavailable");
	});
});
