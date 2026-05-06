import { type ComponentChild, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../components/primitives/radix-select", () => ({
	RadixSelect: ({
		ariaLabel,
		disabled,
		id,
		onValueChange,
		options,
		value,
	}: {
		ariaLabel?: string;
		disabled?: boolean;
		id?: string;
		onValueChange: (value: string) => void;
		options: Array<{ label: string; value: string }>;
		value: string;
	}) => (
		<select
			aria-label={ariaLabel}
			disabled={disabled}
			id={id}
			onChange={(event) => onValueChange((event.currentTarget as HTMLSelectElement).value)}
			value={value}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
}));

vi.mock("../../../lib/api", () => ({
	deleteSharingDomainProjectMapping: vi.fn(),
	loadSharingDomainSettings: vi.fn(),
	saveSharingDomainProjectMapping: vi.fn(),
}));

vi.mock("../../../lib/notice", () => ({ showGlobalNotice: vi.fn() }));

import * as api from "../../../lib/api";
import { SharingDomainsPanel } from "./SharingDomainsPanel";

let mount: HTMLDivElement | null = null;

function renderIntoDocument(content: ComponentChild) {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(content, mount as HTMLDivElement);
	});
	return mount;
}

async function flushEffects() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

afterEach(() => {
	if (mount) {
		act(() => {
			render(null, mount as HTMLDivElement);
		});
		mount.remove();
		mount = null;
	}
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("SharingDomainsPanel", () => {
	it("shows local-only fallback and saves an explicit project Sharing domain", async () => {
		vi.mocked(api.loadSharingDomainSettings)
			.mockResolvedValueOnce({
				local_default_scope_id: "local-default",
				mappings: [],
				projects: [
					{
						cwd: "/work/acme/api",
						display_project: "api",
						git_branch: "main",
						git_remote: "https://example.test/acme/api.git",
						identity_source: "git_remote",
						latest_session_at: "2026-05-06T00:00:00Z",
						mapping_id: null,
						matched_pattern: null,
						project: "api",
						resolution_reason: "local_default",
						resolved_scope_id: "local-default",
						workspace_identity: "https://example.test/acme/api.git",
					},
				],
				scopes: [
					{
						authority_type: "local",
						kind: "system",
						label: "Local only",
						scope_id: "local-default",
						status: "active",
					},
					{
						authority_type: "coordinator",
						kind: "team",
						label: "Acme Work",
						scope_id: "acme-work",
						status: "active",
					},
				],
			})
			.mockResolvedValueOnce({
				local_default_scope_id: "local-default",
				mappings: [],
				projects: [
					{
						cwd: "/work/acme/api",
						display_project: "api",
						git_branch: "main",
						git_remote: "https://example.test/acme/api.git",
						identity_source: "git_remote",
						latest_session_at: "2026-05-06T00:00:00Z",
						mapping_id: 42,
						matched_pattern: null,
						project: "api",
						resolution_reason: "exact_mapping",
						resolved_scope_id: "acme-work",
						workspace_identity: "https://example.test/acme/api.git",
					},
				],
				scopes: [
					{
						authority_type: "local",
						kind: "system",
						label: "Local only",
						scope_id: "local-default",
						status: "active",
					},
					{
						authority_type: "coordinator",
						kind: "team",
						label: "Acme Work",
						scope_id: "acme-work",
						status: "active",
					},
				],
			});
		vi.mocked(api.saveSharingDomainProjectMapping).mockResolvedValue({
			id: 42,
			priority: 0,
			project_pattern: "api",
			scope_id: "acme-work",
			source: "user",
			workspace_identity: "https://example.test/acme/api.git",
		});

		const root = renderIntoDocument(<SharingDomainsPanel />);
		await flushEffects();

		expect(root.textContent).toContain("Unmapped and unknown projects stay on Local only");
		expect(root.textContent).toContain("Current default: Local only · local-only fallback");

		const select = root.querySelector("select");
		act(() => {
			if (!select) throw new Error("select missing");
			select.value = "acme-work";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});

		const saveButton = Array.from(root.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Sharing domain",
		);
		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		await flushEffects();

		expect(api.saveSharingDomainProjectMapping).toHaveBeenCalledWith({
			project_pattern: "api",
			scope_id: "acme-work",
			workspace_identity: "https://example.test/acme/api.git",
		});
		expect(root.textContent).toContain("Current default: Acme Work · explicit project mapping");
	});

	it("keeps unmapped project assignment controls disabled", async () => {
		vi.mocked(api.loadSharingDomainSettings).mockResolvedValue({
			local_default_scope_id: "local-default",
			mappings: [],
			projects: [
				{
					cwd: null,
					display_project: "unmapped:abc123",
					git_branch: null,
					git_remote: null,
					identity_source: "unmapped",
					latest_session_at: "2026-05-06T00:00:00Z",
					mapping_id: null,
					matched_pattern: null,
					project: null,
					resolution_reason: "local_default",
					resolved_scope_id: "local-default",
					workspace_identity: "unmapped:abc123",
				},
			],
			scopes: [
				{
					authority_type: "local",
					kind: "system",
					label: "Local only",
					scope_id: "local-default",
					status: "active",
				},
				{
					authority_type: "coordinator",
					kind: "team",
					label: "Acme Work",
					scope_id: "acme-work",
					status: "active",
				},
			],
		});

		const root = renderIntoDocument(<SharingDomainsPanel />);
		await flushEffects();

		expect(root.textContent).toContain("Sharing domain assignment is disabled");
		expect(root.querySelector("select")?.disabled).toBe(true);
		const saveButton = Array.from(root.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Sharing domain",
		) as HTMLButtonElement | undefined;
		expect(saveButton?.disabled).toBe(true);
		expect(api.saveSharingDomainProjectMapping).not.toHaveBeenCalled();
	});
});
