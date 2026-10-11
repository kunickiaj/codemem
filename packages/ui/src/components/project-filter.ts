import { h, render } from "preact";
import { RadixSelect } from "./primitives/radix-select";

export const PROJECT_FILTER_CHANGE = "project-filter-change";

export function requestProjectFilterChange(value: string): boolean {
	const mount = document.getElementById("projectFilterMount");
	if (!mount) return false;
	mount.dispatchEvent(new CustomEvent(PROJECT_FILTER_CHANGE, { detail: value }));
	return true;
}

export function renderProjectFilter(projects: string[], value: string): void {
	const mount = document.getElementById("projectFilterMount");
	if (!mount) return;
	render(
		h(RadixSelect, {
			ariaLabel: "Project filter",
			id: "projectFilter",
			onValueChange: requestProjectFilterChange,
			options: [
				{ label: "All Projects", value: "" },
				...projects.map((project) => ({ label: project, value: project })),
			],
			placeholder: "All Projects",
			size: "compact",
			value,
		}),
		mount,
	);
}
