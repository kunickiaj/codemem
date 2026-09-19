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
		<table className="project-inventory-table">
			<caption className="sr-only">Projects</caption>
			<thead>
				<tr className="project-inventory-table-header project-inventory-table-row">
					<th scope="col">
						<span className="sr-only">Select</span>
					</th>
					<th scope="col">Project</th>
					<th scope="col">Memories</th>
					<th scope="col">Sessions</th>
					<th scope="col">Last activity</th>
					<th scope="col">Shared with</th>
					<th scope="col">
						<span className="sr-only">Actions</span>
					</th>
				</tr>
			</thead>
			{view.rows.map((row) =>
				row.kind === "cluster" ? (
					<ProjectClusterRow callbacks={callbacks} key={row.key} model={row} view={view} />
				) : (
					<ProjectRow callbacks={callbacks} key={row.key} model={row} view={view} />
				),
			)}
		</table>
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
