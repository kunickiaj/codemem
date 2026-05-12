import * as api from "../lib/api";
import type { ProjectScopeInventoryProject } from "../lib/api/sync";

type RefreshFn = () => void;

const STATUS_OPTIONS = [
	["", "All statuses"],
	["local_only", "Local only"],
	["unmapped", "Unmapped"],
	["suggested", "Suggested"],
	["explicitly_mapped", "Explicitly mapped"],
	["legacy_review", "Legacy review"],
	["needs_attention", "Needs attention"],
] as const;

let refreshProjects: RefreshFn | null = null;
let currentOffset = 0;
const lastLimit = 50;

function el<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

function formatStatus(status: string): string {
	return STATUS_OPTIONS.find(([value]) => value === status)?.[1] ?? status.replaceAll("_", " ");
}

function formatResolution(reason: string): string {
	switch (reason) {
		case "exact_mapping":
			return "explicit project mapping";
		case "pattern_mapping":
			return "pattern mapping";
		case "explicit_override":
			return "explicit override";
		default:
			return "local-only fallback";
	}
}

function formatLatest(value: string | null): string {
	if (!value) return "No recent sessions";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}

function strongestSignal(project: ProjectScopeInventoryProject): string {
	if (project.git_remote) return project.git_remote;
	if (project.cwd) return project.cwd;
	return project.workspace_identity;
}

function renderProjectRow(project: ProjectScopeInventoryProject): HTMLElement {
	const row = document.createElement("article");
	row.className = "project-inventory-row";
	const header = document.createElement("div");
	header.className = "project-inventory-row-header";

	const title = document.createElement("div");
	title.className = "project-inventory-title";
	title.textContent = project.display_project;
	header.appendChild(title);

	const domain = document.createElement("div");
	domain.className = "project-inventory-domain";
	domain.textContent = project.resolved_scope_id;
	header.appendChild(domain);
	row.appendChild(header);

	const meta = document.createElement("div");
	meta.className = "project-inventory-meta";
	meta.textContent = `${formatResolution(project.resolution_reason)} · ${project.identity_source} · ${formatLatest(project.latest_session_at)}`;
	row.appendChild(meta);

	const signal = document.createElement("div");
	signal.className = "project-inventory-signal mono";
	signal.textContent = strongestSignal(project);
	row.appendChild(signal);

	if (project.statuses.length > 0) {
		const badges = document.createElement("div");
		badges.className = "project-inventory-badges";
		for (const status of project.statuses) {
			const badge = document.createElement("span");
			badge.className = `project-status-badge ${status}`;
			badge.textContent = formatStatus(status);
			badges.appendChild(badge);
		}
		row.appendChild(badges);
	}

	const detail = document.createElement("details");
	detail.className = "project-inventory-details";
	const summary = document.createElement("summary");
	summary.textContent = "Identity and mapping details";
	detail.appendChild(summary);
	const list = document.createElement("dl");
	list.className = "project-detail-grid";
	const fields: Array<[string, string | number | null | undefined]> = [
		["Workspace identity", project.workspace_identity],
		["Project", project.project],
		["CWD", project.cwd],
		["Git remote", project.git_remote],
		["Git branch", project.git_branch],
		["Suggested domain", project.suggested_scope_id],
		["Suggestion reason", project.suggestion_reason],
		["Sessions", project.session_count],
		["Memories", project.memory_count ?? "count unavailable"],
	];
	for (const [label, value] of fields) {
		const dt = document.createElement("dt");
		dt.textContent = label;
		const dd = document.createElement("dd");
		dd.textContent = value == null || value === "" ? "—" : String(value);
		list.append(dt, dd);
	}
	detail.appendChild(list);
	row.appendChild(detail);
	return row;
}

function renderEmpty(message: string) {
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!list) return;
	list.textContent = "";
	const empty = document.createElement("div");
	empty.className = "settings-note";
	empty.textContent = message;
	list.appendChild(empty);
}

export async function loadProjectsData() {
	const meta = el<HTMLDivElement>("projectsInventoryMeta");
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!meta || !list) return;
	meta.textContent = "Loading project inventory…";
	try {
		const result = await api.loadProjectScopeInventory({
			limit: lastLimit,
			offset: currentOffset,
			q: el<HTMLInputElement>("projectsSearch")?.value.trim() || undefined,
			status: el<HTMLSelectElement>("projectsStatusFilter")?.value || undefined,
		});
		list.textContent = "";
		if (result.projects.length === 0) {
			renderEmpty("No projects match those filters.");
		} else {
			for (const project of result.projects) list.appendChild(renderProjectRow(project));
		}
		meta.textContent = `${result.total} project${result.total === 1 ? "" : "s"} found · showing ${result.offset + 1}-${Math.min(result.offset + result.projects.length, result.total)}`;
		const prev = el<HTMLButtonElement>("projectsPrevPage");
		const next = el<HTMLButtonElement>("projectsNextPage");
		if (prev) prev.disabled = result.offset === 0;
		if (next) next.disabled = !result.has_more;
	} catch (error) {
		meta.textContent = "Project inventory failed to load.";
		renderEmpty(error instanceof Error ? error.message : "Unable to load project inventory.");
	}
}

export function initProjectsTab(refresh: RefreshFn) {
	refreshProjects = refresh;
	const status = el<HTMLSelectElement>("projectsStatusFilter");
	if (status && status.options.length === 0) {
		for (const [value, label] of STATUS_OPTIONS) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			status.appendChild(option);
		}
	}
	const requestRefresh = () => {
		currentOffset = 0;
		refreshProjects?.();
	};
	el<HTMLInputElement>("projectsSearch")?.addEventListener("input", requestRefresh);
	status?.addEventListener("change", requestRefresh);
	el<HTMLButtonElement>("projectsPrevPage")?.addEventListener("click", () => {
		currentOffset = Math.max(0, currentOffset - lastLimit);
		refreshProjects?.();
	});
	el<HTMLButtonElement>("projectsNextPage")?.addEventListener("click", () => {
		currentOffset += lastLimit;
		refreshProjects?.();
	});
}
