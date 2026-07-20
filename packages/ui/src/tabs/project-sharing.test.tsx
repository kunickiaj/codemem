import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
	createProjectInvite: vi.fn(),
	previewProjectInvite: vi.fn(),
}));

vi.mock("../components/primitives/radix-dialog", () => ({
	RadixDialog: ({
		ariaDescribedby,
		ariaLabelledby,
		children,
		contentClassName,
		contentId,
		open,
	}: {
		ariaDescribedby?: string;
		ariaLabelledby?: string;
		children?: ComponentChildren;
		contentClassName?: string;
		contentId: string;
		open: boolean;
	}) =>
		open ? (
			<div
				aria-describedby={ariaDescribedby}
				aria-labelledby={ariaLabelledby}
				className={contentClassName}
				id={contentId}
				role="dialog"
			>
				{children}
			</div>
		) : null,
}));

import * as api from "../lib/api";
import type { ProjectScopeInventoryProject } from "../lib/api/sync";
import { openProjectShareFlow, renderProjectShareFlow } from "./project-sharing";

const project: ProjectScopeInventoryProject = {
	cwd: "/work/codemem",
	display_project: "codemem",
	git_branch: "main",
	git_remote: "https://example.invalid/codemem.git",
	guardrail_warnings: [],
	identity_source: "git_remote",
	latest_session_at: "2026-07-20T00:00:00Z",
	mapping_id: null,
	matched_pattern: null,
	memory_count: 436,
	project: "codemem",
	read_only: false,
	read_only_reason: null,
	resolution_reason: "local_default",
	resolved_scope_id: "private-internal-value",
	session_count: 4,
	statuses: ["local_only"],
	suggested_scope_id: null,
	suggestion_reason: null,
	suggestion_signal: null,
	workspace_identity: "git:https://example.invalid/codemem.git",
};

const preview = {
	existing_memory_count: 436,
	future_memories_shared: true as const,
	history_policy: "existing_and_future" as const,
	operation_id: `share_${"a".repeat(40)}`,
	projects: [
		{
			display_name: "codemem",
			existing_memory_count: 436,
			project_id: project.workspace_identity,
		},
	],
	reviewed_project_set_digest: "b".repeat(64),
	teammate: { display_name: "Brian", match: "pending" as const },
};

describe("project sharing flow", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="mount"></div>';
		vi.mocked(api.previewProjectInvite).mockResolvedValue(preview);
		vi.mocked(api.createProjectInvite).mockResolvedValue({
			...preview,
			invite: {
				encoded: "encoded",
				expires_at: "2026-07-27T00:00:00Z",
				link: "codemem://join?invite=encoded",
			},
			ok: true,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		document.body.innerHTML = "";
	});

	it("reviews exact projects, counts, and future sharing without internal terminology", async () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));

		act(() => (document.querySelector("button") as HTMLButtonElement).click());
		const name = document.getElementById("project-share-teammate") as HTMLInputElement;
		const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
		act(() => {
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			checkbox.click();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(document.body.textContent).toContain(
			"436 existing memories and future activity from codemem",
		);
		expect(document.body.textContent).toContain("No other projects will be shared.");
		expect(document.body.textContent).not.toMatch(/Space|scope|UUID|filter|coordinator/i);
		expect(api.previewProjectInvite).toHaveBeenCalledWith({
			teammate_name: "Brian",
			project_ids: [project.workspace_identity],
		});
	});

	it("creates only the reviewed project set", async () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (document.querySelector("button") as HTMLButtonElement).click());
		act(() => {
			const name = document.getElementById("project-share-teammate") as HTMLInputElement;
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(api.createProjectInvite).toHaveBeenCalledWith({
			teammate_name: "Brian",
			project_ids: [project.workspace_identity],
			reviewed_project_set_digest: preview.reviewed_project_set_digest,
		});
		expect(document.body.textContent).toContain("Invitation created for Brian");
	});

	it("preselects only the canonical project requested by a row action", () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		const selected = {
			...project,
			display_project: "codemem-site",
			workspace_identity: "git:https://example.invalid/codemem-site.git",
		};
		act(() => renderProjectShareFlow(mount, [project, selected]));

		act(() => openProjectShareFlow([selected.workspace_identity]));

		const checkboxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([false, true]);
	});

	it("uses unique control IDs for canonical identities that sanitize alike", () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		const colliding = {
			...project,
			display_project: "codemem mirror",
			workspace_identity: "git:https://example.invalid/codemem/git",
		};
		const punctuated = {
			...project,
			workspace_identity: "git:https://example.invalid/codemem.git",
		};
		act(() => renderProjectShareFlow(mount, [punctuated, colliding]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());

		const checkboxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		expect(new Set(checkboxes.map((checkbox) => checkbox.id)).size).toBe(2);
		expect(
			[...document.querySelectorAll<HTMLLabelElement>("label[for]")]
				.map((label) => label.htmlFor)
				.filter((id) => id.startsWith("share-project-")),
		).toEqual(checkboxes.map((checkbox) => checkbox.id));
	});

	it("explains when the complete project selector cannot be loaded", () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [], { inventoryError: true }));

		expect((mount.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
		expect(document.getElementById("project-share-inventory-error")?.textContent).toContain(
			"Refresh Projects to try again",
		);
	});

	it("closes and clears an open selector when the complete inventory becomes unavailable", () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();

		act(() => renderProjectShareFlow(mount, [], { inventoryError: true }));

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect((mount.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
	});

	it("validates required fields and resets the teammate when reopened", () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());

		act(() => (document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click());
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Enter your teammate's name.",
		);
		expect(api.previewProjectInvite).not.toHaveBeenCalled();

		const name = document.getElementById("project-share-teammate") as HTMLInputElement;
		act(() => {
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			(document.querySelector('[aria-label="Close Share projects"]') as HTMLButtonElement).click();
		});
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());

		expect((document.getElementById("project-share-teammate") as HTMLInputElement).value).toBe("");
	});

	it("requires a project after the teammate is entered", () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());
		act(() => {
			const name = document.getElementById("project-share-teammate") as HTMLInputElement;
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => (document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click());

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Select at least one project.",
		);
		expect(api.previewProjectInvite).not.toHaveBeenCalled();
	});

	it("disables unmapped, ambiguous, and peer-received projects", () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		const unavailable = [
			{
				...project,
				display_project: "unmapped",
				identity_source: "unmapped",
				workspace_identity: "unmapped:project",
			},
			{
				...project,
				display_project: "ambiguous",
				guardrail_warnings: [
					{
						code: "basename_collision_review",
						message: "Review the collision",
						requires_confirmation: true,
						severity: "warning" as const,
					},
				],
				workspace_identity: "path:/work/ambiguous",
			},
			{
				...project,
				display_project: "received",
				read_only: true,
				read_only_reason: "peer_received" as const,
				workspace_identity: "peer-received:device:project:received",
			},
		];
		act(() => renderProjectShareFlow(mount, [project, ...unavailable]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());

		const checkboxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		expect(checkboxes).toHaveLength(4);
		expect(checkboxes[0]?.disabled).toBe(false);
		expect(checkboxes.slice(1).every((checkbox) => checkbox.disabled)).toBe(true);
		expect(document.body.textContent).toContain(
			"Unavailable until this project identity is reviewed",
		);
	});

	it("shows a safe error instead of raw server terminology", async () => {
		vi.mocked(api.previewProjectInvite).mockRejectedValue(new Error("coordinator_internal_error"));
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());
		act(() => {
			const name = document.getElementById("project-share-teammate") as HTMLInputElement;
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Unable to review this invitation.",
		);
		expect(document.body.textContent).not.toContain("coordinator_internal_error");
	});

	it.each([
		[
			"project_selection_ambiguous",
			"One selected project has a name collision. Review its project identity first.",
		],
		["reviewed_project_set_changed", "The selected projects changed. Review the invitation again."],
	])("renders safe copy for %s", async (code, message) => {
		vi.mocked(api.previewProjectInvite).mockRejectedValue(new Error(code));
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());
		act(() => {
			const name = document.getElementById("project-share-teammate") as HTMLInputElement;
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
		expect(document.body.textContent).not.toContain(code);
	});

	it("requires a fresh review after the selected project set changes", async () => {
		vi.mocked(api.createProjectInvite)
			.mockRejectedValueOnce(new Error("reviewed_project_set_changed"))
			.mockResolvedValueOnce({
				...preview,
				invite: {
					encoded: "encoded",
					expires_at: "2026-07-27T00:00:00Z",
					link: "codemem://join?invite=encoded",
				},
				ok: true,
			});
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());
		act(() => {
			const name = document.getElementById("project-share-teammate") as HTMLInputElement;
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(document.body.textContent).not.toContain(
			"436 existing memories and future activity from codemem",
		);
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"The selected projects changed. Review the invitation again.",
		);
		expect((document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).textContent).toBe(
			"Review sharing",
		);

		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(api.previewProjectInvite).toHaveBeenCalledTimes(2);
		expect(document.body.textContent).toContain(
			"436 existing memories and future activity from codemem",
		);
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(api.createProjectInvite).toHaveBeenCalledTimes(2);
		expect(document.body.textContent).toContain("Invitation created for Brian");
	});

	it("announces successful invite copying without nesting live regions", async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());
		act(() => {
			const name = document.getElementById("project-share-teammate") as HTMLInputElement;
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
		});
		for (let step = 0; step < 2; step += 1) {
			await act(async () => {
				(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
				await Promise.resolve();
				await Promise.resolve();
			});
		}

		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>("button")]
				.find((button) => button.textContent === "Copy invite")
				?.click();
			await Promise.resolve();
		});

		expect(writeText).toHaveBeenCalledWith("codemem://join?invite=encoded");
		expect(
			[...document.querySelectorAll<HTMLElement>('[role="status"]')].map(
				(item) => item.textContent,
			),
		).toContain("Invite copied.");
	});

	it("clears selection, preview, created state, and errors when reopened", async () => {
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() => renderProjectShareFlow(mount, [project]));
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());
		act(() => {
			const name = document.getElementById("project-share-teammate") as HTMLInputElement;
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		vi.mocked(api.createProjectInvite).mockRejectedValueOnce(
			new Error("reviewed_project_set_changed"),
		);
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		act(() =>
			(document.querySelector('[aria-label="Close Share projects"]') as HTMLButtonElement).click(),
		);
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());

		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(document.body.textContent).not.toContain("will receive:");
		expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
			false,
		);

		act(() => {
			const name = document.getElementById("project-share-teammate") as HTMLInputElement;
			name.value = "Brian";
			name.dispatchEvent(new Event("input", { bubbles: true }));
			(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		await act(async () => {
			(document.querySelector(".sync-dialog-confirm") as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(document.body.textContent).toContain("Invitation created for Brian");
		act(() =>
			(document.querySelector('[aria-label="Close Share projects"]') as HTMLButtonElement).click(),
		);
		act(() => (mount.querySelector("button") as HTMLButtonElement).click());

		expect(document.body.textContent).not.toContain("Invitation created for Brian");
		expect(document.getElementById("project-share-teammate")).not.toBeNull();
	});
});
