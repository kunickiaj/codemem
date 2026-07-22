import { render } from "preact";
import type {
	RecipientPolicyIntentGraphV1,
	RecipientPolicyReconciliationReadState,
	RecipientPolicyReconciliationStatusV1,
} from "../lib/api/sync";

export type DeviceAvailabilityState = "available" | "offline" | "unknown";
export type DevicesNavigationTarget = "health" | "sharing";

export interface DeviceAvailabilityInput {
	deviceId: string;
	state: DeviceAvailabilityState;
}

export interface DevicesProjectInput {
	canonicalProjectIdentity: string;
	displayName: string;
}

export interface DevicesRendererOptions {
	loading?: boolean;
	loadError?: boolean;
	refreshError?: boolean;
	onNavigate?: (target: DevicesNavigationTarget) => void;
}

export interface DeviceProjectProjection {
	displayName: string;
	teamNames: string[];
	state: RecipientPolicyReconciliationReadState;
	statusLabel: string;
	statusCopy: string;
	deliveredCopiesMayRemain: boolean;
}

export interface DeviceProjection {
	deviceId: string;
	displayName: string;
	identityName: string;
	availability: DeviceAvailabilityState;
	availabilityLabel: string;
	directProjects: DeviceProjectProjection[];
	inheritedProjects: DeviceProjectProjection[];
	unavailableProjectCount: number;
	statusState: RecipientPolicyReconciliationReadState | "no_projects";
	statusLabel: string;
	statusCopy: string;
	deliveredCopiesMayRemain: boolean;
	action: { label: string; target: DevicesNavigationTarget } | null;
}

export interface DevicesProjection {
	devices: DeviceProjection[];
	revokedDeviceCount: number;
}

type DeviceActionFocusIdentity = {
	deviceId: string;
	target: DevicesNavigationTarget;
};

const deviceActionFocusIdentities = new WeakMap<HTMLElement, DeviceActionFocusIdentity>();

const STATUS_PRIORITY: Record<RecipientPolicyReconciliationReadState, number> = {
	active: 0,
	verifying: 1,
	pending: 2,
	waiting: 3,
	needs_attention: 4,
};

const PENDING_STATUS = {
	state: "pending",
	label: "Recipient policy pending",
	explanation: "Current access remains in place while this Project is prepared.",
	deliveredCopiesMayRemain: true,
} as const;

const AVAILABILITY_LABELS: Record<DeviceAvailabilityState, string> = {
	available: "Available",
	offline: "Offline",
	unknown: "Availability unknown",
};

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function projectStatus(
	projectId: string,
	statusesByProject: Map<string, RecipientPolicyReconciliationStatusV1["items"][number]>,
) {
	return statusesByProject.get(projectId) ?? PENDING_STATUS;
}

function overallStatus(projects: DeviceProjectProjection[]) {
	return projects.reduce<DeviceProjectProjection | null>((current, project) => {
		if (!current || STATUS_PRIORITY[project.state] > STATUS_PRIORITY[current.state]) return project;
		return current;
	}, null);
}

function actionForDevice(
	availability: DeviceAvailabilityState,
	status: RecipientPolicyReconciliationReadState | "no_projects",
): DeviceProjection["action"] {
	if (status === "needs_attention") return { label: "Review sharing", target: "sharing" };
	if (availability !== "available") return { label: "Check device health", target: "health" };
	if (status === "waiting" || status === "pending" || status === "verifying") {
		return { label: "View sharing status", target: "sharing" };
	}
	return null;
}

export function projectDevices(
	intent: RecipientPolicyIntentGraphV1,
	reconciliation: RecipientPolicyReconciliationStatusV1,
	projects: DevicesProjectInput[],
	availabilityInput: DeviceAvailabilityInput[],
): DevicesProjection {
	const identityNames = new Map(
		intent.identities
			.filter((item) => item.status === "active" && item.mergedIntoIdentityId === null)
			.map((item) => [item.identityId, item.displayName]),
	);
	const teamNames = new Map(
		intent.teams
			.filter((item) => item.status === "active")
			.map((item) => [item.teamId, item.displayName]),
	);
	const projectNames = new Map(
		projects.map((item) => [item.canonicalProjectIdentity, item.displayName]),
	);
	const availability = new Map(availabilityInput.map((item) => [item.deviceId, item.state]));
	const statuses = new Map(
		reconciliation.items.map((item) => [item.canonicalProjectIdentity, item]),
	);

	const devices = intent.identityDevices
		.filter((device) => device.status === "active" && identityNames.has(device.identityId))
		.map((device): DeviceProjection => {
			const activeTeamIds = new Set(
				intent.teamMemberships
					.filter(
						(item) =>
							item.status === "active" &&
							item.identityId === device.identityId &&
							teamNames.has(item.teamId),
					)
					.map((item) => item.teamId),
			);
			const directProjectIds = uniqueSorted(
				intent.projectRecipients
					.filter(
						(item) =>
							item.status === "active" &&
							item.recipientKind === "identity" &&
							item.identityId === device.identityId,
					)
					.map((item) => item.canonicalProjectIdentity),
			);
			const inheritedTeamIdsByProject = new Map<string, Set<string>>();
			for (const edge of intent.projectRecipients) {
				if (
					edge.status !== "active" ||
					edge.recipientKind !== "team" ||
					!activeTeamIds.has(edge.teamId)
				) {
					continue;
				}
				const ids = inheritedTeamIdsByProject.get(edge.canonicalProjectIdentity) ?? new Set();
				ids.add(edge.teamId);
				inheritedTeamIdsByProject.set(edge.canonicalProjectIdentity, ids);
			}
			const toProject = (projectId: string, inheritedTeamIds: Iterable<string> = []) => {
				const displayName = projectNames.get(projectId);
				if (!displayName) return null;
				const status = projectStatus(projectId, statuses);
				return {
					displayName,
					teamNames: uniqueSorted(
						[...inheritedTeamIds].flatMap((teamId) => {
							const name = teamNames.get(teamId);
							return name ? [name] : [];
						}),
					),
					state: status.state,
					statusLabel: status.label,
					statusCopy: status.explanation,
					deliveredCopiesMayRemain: status.deliveredCopiesMayRemain,
				} satisfies DeviceProjectProjection;
			};
			const directProjects = directProjectIds.flatMap((projectId) => {
				const project = toProject(projectId);
				return project ? [project] : [];
			});
			const inheritedProjects = uniqueSorted(inheritedTeamIdsByProject.keys()).flatMap(
				(projectId) => {
					const project = toProject(projectId, inheritedTeamIdsByProject.get(projectId));
					return project ? [project] : [];
				},
			);
			const allProjects = [...directProjects, ...inheritedProjects];
			const status = overallStatus(allProjects);
			const deviceAvailability = availability.get(device.deviceId) ?? "unknown";
			return {
				deviceId: device.deviceId,
				displayName: device.displayName,
				identityName: identityNames.get(device.identityId) ?? "Identity unavailable",
				availability: deviceAvailability,
				availabilityLabel: AVAILABILITY_LABELS[deviceAvailability],
				directProjects,
				inheritedProjects,
				unavailableProjectCount:
					directProjectIds.length + inheritedTeamIdsByProject.size - allProjects.length,
				statusState: status?.state ?? "no_projects",
				statusLabel: status?.statusLabel ?? "No shared Projects",
				statusCopy: status?.statusCopy ?? "This device has no current Project access.",
				deliveredCopiesMayRemain: allProjects.some((project) => project.deliveredCopiesMayRemain),
				action: actionForDevice(deviceAvailability, status?.state ?? "no_projects"),
			};
		})
		.sort(
			(left, right) =>
				left.displayName.localeCompare(right.displayName) ||
				left.identityName.localeCompare(right.identityName),
		);
	return {
		devices,
		revokedDeviceCount: intent.identityDevices.filter(
			(device) => device.status === "revoked" && identityNames.has(device.identityId),
		).length,
	};
}

function ProjectList({ empty, projects }: { empty: string; projects: DeviceProjectProjection[] }) {
	if (projects.length === 0) return <p className="small">{empty}</p>;
	return (
		<ul>
			{projects.map((project) => (
				<li key={`${project.displayName}:${project.teamNames.join(":")}`}>
					<strong>{project.displayName}</strong>
					{project.teamNames.length ? ` through ${project.teamNames.join(", ")}` : ""}
					<span className="small">
						{" "}
						— {project.statusLabel}. {project.statusCopy}
					</span>
				</li>
			))}
		</ul>
	);
}

function DevicesView({
	options,
	projection,
}: {
	options: DevicesRendererOptions;
	projection: DevicesProjection;
}) {
	if (options.loading) {
		return (
			<p aria-live="polite" className="small" role="status">
				Loading Devices…
			</p>
		);
	}
	if (options.loadError) {
		return (
			<p aria-live="assertive" role="alert">
				Devices are unavailable. Refresh and try again.
			</p>
		);
	}
	const refreshError = options.refreshError ? (
		<p aria-live="assertive" role="alert">
			Refresh failed; showing previous device information.
		</p>
	) : null;
	if (projection.devices.length === 0) {
		return (
			<>
				{refreshError}
				<p className="small" role="status">
					No active devices are registered.
					{projection.revokedDeviceCount > 0
						? ` ${projection.revokedDeviceCount.toLocaleString()} revoked ${projection.revokedDeviceCount === 1 ? "device is" : "devices are"} not shown.`
						: ""}
				</p>
			</>
		);
	}
	return (
		<>
			{refreshError}
			<ul className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
				{projection.devices.map((device, index) => {
					const titleId = `devices-card-title-${index}`;
					const action = device.action;
					return (
						<li key={device.deviceId}>
							<article
								aria-labelledby={titleId}
								className="peer-card peer-card--padded recipient-policy-sharing-card"
							>
								<div className="peer-title recipient-policy-sharing-card-title">
									<h3 id={titleId}>{device.displayName}</h3>
									<span className="badge actor-badge">{device.availabilityLabel}</span>
								</div>
								<dl className="recipient-policy-sharing-details">
									<div>
										<dt>Owning Identity</dt>
										<dd>{device.identityName}</dd>
									</div>
									<div>
										<dt>Availability</dt>
										<dd>{device.availabilityLabel}</dd>
									</div>
									<div>
										<dt>Sharing status</dt>
										<dd>
											<strong>{device.statusLabel}</strong> — {device.statusCopy}
										</dd>
									</div>
								</dl>
								<section aria-labelledby={`${titleId}-direct`}>
									<h4 id={`${titleId}-direct`}>Direct Projects</h4>
									<ProjectList
										empty="No Projects are shared directly."
										projects={device.directProjects}
									/>
								</section>
								<section aria-labelledby={`${titleId}-teams`}>
									<h4 id={`${titleId}-teams`}>Projects through Teams</h4>
									<ProjectList
										empty="No Projects are inherited through Teams."
										projects={device.inheritedProjects}
									/>
								</section>
								{device.unavailableProjectCount > 0 ? (
									<p className="small" role="status">
										Some Project names are unavailable and are not shown.
									</p>
								) : null}
								{device.deliveredCopiesMayRemain ? (
									<p className="small">
										<strong>Delivered copies:</strong> Changing access stops future delivery, but
										copies already delivered may remain on this device or in backups.
									</p>
								) : null}
								{action && options.onNavigate ? (
									<button
										aria-label={`${action.label} for ${device.displayName}`}
										className="settings-button recipient-policy-sharing-target-24"
										onClick={() => options.onNavigate?.(action.target)}
										ref={(element) => {
											if (element) {
												deviceActionFocusIdentities.set(element, {
													deviceId: device.deviceId,
													target: action.target,
												});
											}
										}}
										type="button"
									>
										{action.label}
									</button>
								) : null}
							</article>
						</li>
					);
				})}
			</ul>
			{projection.revokedDeviceCount > 0 ? (
				<p className="small" role="status">
					{projection.revokedDeviceCount.toLocaleString()} revoked{" "}
					{projection.revokedDeviceCount === 1 ? "device is" : "devices are"} not included in the
					active list.
				</p>
			) : null}
		</>
	);
}

export function mountDevices(
	mount: HTMLElement,
	intent: RecipientPolicyIntentGraphV1,
	reconciliation: RecipientPolicyReconciliationStatusV1,
	projects: DevicesProjectInput[],
	availability: DeviceAvailabilityInput[],
	options: DevicesRendererOptions = {},
): void {
	const focusedElement = document.activeElement;
	const focusedAction =
		focusedElement instanceof HTMLElement && mount.contains(focusedElement)
			? deviceActionFocusIdentities.get(focusedElement)
			: undefined;
	const projection = projectDevices(intent, reconciliation, projects, availability);
	render(
		<section
			aria-labelledby="devices-heading"
			className="recipient-policy-sharing recipient-policy-sharing-responsive-surface"
		>
			<div className="recipient-policy-sharing-header">
				<h2 id="devices-heading">Devices</h2>
				<p className="small">
					See where Codemem runs and which Projects each active device receives.
				</p>
			</div>
			<DevicesView options={options} projection={projection} />
		</section>,
		mount,
	);
	if (!focusedAction) return;
	const matchingAction = [...mount.querySelectorAll<HTMLElement>("button")].find((element) => {
		const identity = deviceActionFocusIdentities.get(element);
		return (
			identity?.deviceId === focusedAction.deviceId && identity.target === focusedAction.target
		);
	});
	(matchingAction ?? document.getElementById("tabBtn-devices"))?.focus();
}
