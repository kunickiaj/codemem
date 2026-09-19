import { render } from "preact";
import type {
	ProjectInventoryCallbacks,
	ProjectsInventoryViewModel,
} from "../projects-inventory-model";
import { ProjectClusterRow } from "./ProjectClusterRow";
import { ProjectRow } from "./ProjectRow";

interface ProjectInventoryProps {
	callbacks: ProjectInventoryCallbacks;
	error?: string;
	view: ProjectsInventoryViewModel;
}

export function ProjectInventory({ callbacks, error, view }: ProjectInventoryProps) {
	if (error)
		return (
			<div className="settings-note" role="status">
				{error}
			</div>
		);
	if (view.rows.length === 0) return <div className="settings-note">No matching projects</div>;
	return (
		<section className="project-inventory-table" aria-label="Projects">
			<div className="project-inventory-table-header project-inventory-table-row">
				<span aria-hidden="true" />
				<span>Project</span>
				<span>Memories</span>
				<span>Sessions</span>
				<span>Last activity</span>
				<span>Shared with</span>
				<span aria-hidden="true" />
			</div>
			<div className="project-inventory-table-body">
				{view.rows.map((row) =>
					row.kind === "cluster" ? (
						<ProjectClusterRow callbacks={callbacks} key={row.key} model={row} view={view} />
					) : (
						<ProjectRow callbacks={callbacks} key={row.key} model={row} view={view} />
					),
				)}
			</div>
		</section>
	);
}

export function renderProjectInventory(
	mount: HTMLElement,
	view: ProjectsInventoryViewModel,
	callbacks: ProjectInventoryCallbacks,
	error?: string,
): void {
	render(<ProjectInventory callbacks={callbacks} error={error} view={view} />, mount);
}
