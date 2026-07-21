import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../project-sharing", () => ({ openProjectShareFlow: vi.fn() }));

import type { ShareOperationLifecycleState, ShareOperationReadModel } from "../../../lib/api/sync";
import { openProjectShareFlow } from "../../project-sharing";
import {
	ProjectShareOperations,
	resetProjectShareOperationFeedbackForTests,
} from "./project-share-operations";

const labels: Record<ShareOperationLifecycleState, string> = {
	waiting_for_acceptance: "Waiting for acceptance",
	provisioning: "Setting up project access",
	initial_sync: "Starting first sync",
	waiting_for_device: "Waiting for device",
	active: "Up to date",
	needs_attention: "Setup needs attention",
	revoking: "Removing future access",
	revoked: "Access removed",
	cancelled: "Invitation cancelled",
};

function operation(
	state: ShareOperationLifecycleState,
	overrides: Partial<ShareOperationReadModel> = {},
): ShareOperationReadModel {
	const primaryAction =
		state === "needs_attention"
			? ({ kind: "retry_setup", label: "Retry setup" } as const)
			: state === "waiting_for_acceptance"
				? ({
						kind: "copy_invite",
						label: "Copy invite",
						invite_link: "codemem://invite/existing-safe-link",
					} as const)
				: state === "revoked"
					? ({ kind: "share_again", label: "Share again" } as const)
					: state === "cancelled"
						? ({ kind: "create_new_invite", label: "Create new invite" } as const)
						: null;
	return {
		operation_id: `share_${state.padEnd(40, "a").slice(0, 40)}`,
		person: { actor_id: "actor-brian", display_name: "Brian" },
		devices:
			state === "waiting_for_acceptance"
				? []
				: [
						{
							device_id: "2e7f4e49-6a83-4c53-9f1f-5ba57f401111",
							display_name: "Brian's MacBook",
							last_seen_at: null,
						},
					],
		projects: [
			{ project_id: "git:codemem", display_name: "codemem", existing_memory_count: 3 },
			{ project_id: "git:codemem-site", display_name: "codemem-site", existing_memory_count: 2 },
		],
		project_count: 2,
		lifecycle: {
			state,
			label: labels[state],
			explanation:
				state === "revoked"
					? "Previously copied memories may remain."
					: `${labels[state]} explanation.`,
			primary_action: primaryAction,
		},
		timestamps: {
			created_at: "2026-07-20T00:00:00Z",
			updated_at: "2026-07-20T00:01:00Z",
			accepted_at: null,
			invite_expires_at: "2026-07-27T00:00:00Z",
		},
		...overrides,
	};
}

describe("ProjectShareOperations", () => {
	let mount: HTMLDivElement;

	beforeEach(() => {
		mount = document.createElement("div");
		document.body.appendChild(mount);
		resetProjectShareOperationFeedbackForTests();
	});

	afterEach(() => {
		render(null, mount);
		mount.remove();
	});

	it.each(
		Object.keys(labels) as ShareOperationLifecycleState[],
	)("renders %s with one lifecycle and at most one action", (state) => {
		render(
			<ProjectShareOperations
				operations={[operation(state)]}
				onAdvance={vi.fn()}
				onReload={vi.fn()}
			/>,
			mount,
		);
		const card = mount.querySelector("article");
		expect(card?.textContent).toContain(labels[state]);
		expect(card?.querySelectorAll("button").length).toBeLessThanOrEqual(1);
		expect(card?.querySelector('[role="alert"]') != null).toBe(state === "needs_attention");
	});

	it("groups strictly by actor identity and nests friendly devices and projects", () => {
		render(
			<ProjectShareOperations
				operations={[
					operation("active"),
					operation("waiting_for_device", {
						operation_id: `share_${"c".repeat(40)}`,
					}),
					operation("initial_sync", {
						operation_id: `share_${"b".repeat(40)}`,
						person: { actor_id: "actor-other-brian", display_name: "Brian" },
					}),
				]}
				onAdvance={vi.fn()}
				onReload={vi.fn()}
			/>,
			mount,
		);

		expect(mount.querySelectorAll(".project-share-person-group")).toHaveLength(2);
		expect(mount.querySelectorAll('ul[aria-label^="Devices for Brian"]')).toHaveLength(2);
		expect(
			mount
				.querySelectorAll(".project-share-person-group")[0]
				.querySelectorAll(".project-share-operation-card"),
		).toHaveLength(2);
		expect(
			mount.querySelectorAll(".project-share-person-group")[0].querySelectorAll("h3"),
		).toHaveLength(1);
		expect(mount.textContent).toContain("Brian's MacBook");
		expect(mount.textContent).toContain("codemem-site");
		expect(mount.textContent).not.toContain("2e7f4e49");
		for (const internalTerm of ["scope", "cursor", "fingerprint", "address", "group id"]) {
			expect(mount.textContent?.toLowerCase()).not.toContain(internalTerm);
		}
	});

	it.each([
		["revoked", "Previously shared"],
		["cancelled", "Invitation cancelled"],
	] as const)("describes %s operations as historical rather than current sharing", (state, label) => {
		render(
			<ProjectShareOperations
				operations={[operation(state)]}
				onAdvance={vi.fn()}
				onReload={vi.fn()}
			/>,
			mount,
		);

		const operationCard = mount.querySelector(".project-share-operation-card");
		expect(operationCard?.textContent).toContain(label);
		expect(operationCard?.querySelector(".peer-scope-summary")?.textContent).not.toBe("Sharing");
	});

	it.each([
		["revoked", "Share again"],
		["cancelled", "Create new invite"],
	] as const)("reopens exact project sharing for %s operations", (state, label) => {
		render(
			<ProjectShareOperations
				operations={[operation(state)]}
				onAdvance={vi.fn()}
				onReload={vi.fn()}
			/>,
			mount,
		);

		const button = mount.querySelector("button") as HTMLButtonElement;
		expect(button.textContent).toBe(label);
		button.click();

		expect(openProjectShareFlow).toHaveBeenCalledWith(["git:codemem", "git:codemem-site"], "Brian");
	});

	it("runs retry through the operation advance callback with busy semantics", async () => {
		let finishAdvance!: (value: ShareOperationReadModel) => void;
		const advancePending = new Promise<ShareOperationReadModel>((resolve) => {
			finishAdvance = resolve;
		});
		const advance = vi.fn(() => advancePending);
		const reload = vi.fn(async () => undefined);
		render(
			<ProjectShareOperations
				operations={[operation("needs_attention")]}
				onAdvance={advance}
				onReload={reload}
			/>,
			mount,
		);
		const button = mount.querySelector("button") as HTMLButtonElement;
		button.click();
		await vi.waitFor(() => expect(button.disabled).toBe(true));
		expect(button.getAttribute("aria-busy")).toBe("true");
		finishAdvance(operation("active"));
		await vi.waitFor(() => expect(reload).toHaveBeenCalled());
		expect(advance).toHaveBeenCalledWith(operation("needs_attention").operation_id);
		expect(mount.querySelector('[role="status"]')?.textContent).toContain("Setup complete");
	});

	it("loads an invite link only when the user asks to copy it", async () => {
		const pending = operation("waiting_for_acceptance");
		pending.lifecycle.primary_action = { kind: "copy_invite", label: "Copy invite" };
		const loadOperation = vi.fn(async () => operation("waiting_for_acceptance"));
		const copyText = vi.fn(async () => undefined);
		render(
			<ProjectShareOperations
				operations={[pending]}
				onAdvance={vi.fn()}
				onLoadOperation={loadOperation}
				onReload={vi.fn()}
				copyText={copyText}
			/>,
			mount,
		);

		(mount.querySelector("button") as HTMLButtonElement).click();

		await vi.waitFor(() =>
			expect(copyText).toHaveBeenCalledWith("codemem://invite/existing-safe-link"),
		);
		expect(loadOperation).toHaveBeenCalledWith(pending.operation_id);
	});

	it("keeps recovery error codes in diagnostics instead of primary feedback", async () => {
		render(
			<ProjectShareOperations
				operations={[operation("needs_attention")]}
				onAdvance={vi.fn(async () => {
					throw new Error("operation_device_binding_missing");
				})}
				onReload={vi.fn()}
			/>,
			mount,
		);

		(mount.querySelector("button") as HTMLButtonElement).click();

		await vi.waitFor(() =>
			expect(mount.querySelector('[role="status"]')?.textContent).toContain(
				"accepted device has not been linked",
			),
		);
		expect(mount.textContent).not.toContain("operation_device_binding_missing");
	});
});
