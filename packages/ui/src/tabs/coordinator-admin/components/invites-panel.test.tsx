import type { ComponentChildren, VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../lib/state";
import { renderInvitesPanel } from "./invites-panel";

describe("coordinator administration invitations panel", () => {
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
	});

	afterEach(() => {
		state.lastShareOperations = [];
		state.lastTeamInvite = null;
	});

	it("hands invitation creation to Sharing and keeps Project sharing read-only", () => {
		// Arrange
		const createInvite = vi.fn();
		const panel = renderInvitesPanel({ createInvite });
		const button = nodes(panel).find(
			(node) =>
				node.type === "button" &&
				textContent(node.props.children) === "Create an invitation in Sharing",
		) as VNode<{ onClick?: () => void }> | undefined;

		// Act
		button?.props.onClick?.();

		// Assert
		expect(createInvite).toHaveBeenCalledOnce();
		expect(textContent(panel)).toContain("Invitations are created in Sharing.");
		expect(textContent(panel)).toContain("Brian");
		expect(textContent(panel)).toContain("Up to date");
		expect(textContent(panel)).not.toMatch(/legacy|Legacy|enroll/);
	});

	it("keeps a previously generated code copyable", () => {
		state.lastTeamInvite = { encoded: "retained-invite", warnings: [] };
		const panel = renderInvitesPanel({ createInvite: vi.fn() });
		const copy = nodes(panel).find(
			(node) => node.props.class === "settings-button sync-action-copy",
		);

		expect(copy?.props.disabled).not.toBe(true);
	});
});
