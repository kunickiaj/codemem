import type { ComponentChildren, VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../lib/state";
import { coordinatorAdminState } from "../data/state";
import { renderInvitesPanel } from "./invites-panel";

describe("Teams invite panel", () => {
	function textContent(value: ComponentChildren): string {
		if (value == null || typeof value === "boolean") return "";
		if (typeof value === "string" || typeof value === "number") return String(value);
		if (Array.isArray(value)) return value.map(textContent).join("");
		return textContent((value as VNode).props.children);
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
	});

	it("labels coordinator invites as legacy and reflects project sharing read-only", () => {
		const text = textContent(
			renderInvitesPanel({
				createInvite: vi.fn(),
				renderShell: vi.fn(),
				summary: { detail: "", readiness: "ready", title: "Ready" },
			}),
		);

		expect(text).toContain("Legacy Team invites");
		expect(text).toContain("do not grant project access");
		expect(text).toContain("Brian");
		expect(text).toContain("codemem");
		expect(text).toContain("Up to date");
		expect(text).not.toContain("Share project");
	});
});
