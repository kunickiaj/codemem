import { render } from "preact";
import { useRef, useState } from "preact/hooks";
import type { RecipientPolicyIntentGraphV1 } from "../lib/api/sync";
import {
	openRecipientPolicyManagement,
	type RecipientPolicyManagementProject,
} from "./recipient-policy-management";

export interface RecipientPolicySharingOptions {
	loading?: boolean;
	loadError?: boolean;
}

type SharingTab = "teams" | "identities" | "invitations";

const SHARING_TABS: Array<{ id: SharingTab; label: string }> = [
	{ id: "teams", label: "Teams" },
	{ id: "identities", label: "Identities" },
	{ id: "invitations", label: "Invitations" },
];

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function namesLabel(names: string[], empty: string): string {
	return names.length ? names.join(", ") : empty;
}

function activeProjectNames(
	projectIds: Iterable<string>,
	projectsById: Map<string, RecipientPolicyManagementProject>,
): string[] {
	return [...new Set(projectIds)].flatMap((projectId) => {
		const project = projectsById.get(projectId);
		return project ? [project.displayName] : [];
	});
}

function RecipientActions({
	descriptionId,
	displayName,
	recipient,
}: {
	descriptionId: string;
	displayName: string;
	recipient:
		| { recipientKind: "team"; teamId: string }
		| { recipientKind: "identity"; identityId: string };
}) {
	const openManagement = () => {
		openRecipientPolicyManagement({ mode: "recipient-manage", recipient });
	};
	const openAdd = () => {
		openRecipientPolicyManagement({ mode: "recipient-add", recipient });
	};
	return (
		<>
			<div className="peer-actions recipient-policy-sharing-actions recipient-policy-sharing-responsive-actions">
				<button
					aria-describedby={descriptionId}
					aria-label={`Add Projects for ${displayName}`}
					className="settings-button recipient-policy-sharing-target recipient-policy-sharing-target-24"
					onClick={openAdd}
					type="button"
				>
					Add projects
				</button>
				<button
					aria-label={`Manage Projects for ${displayName}`}
					className="settings-button recipient-policy-sharing-target recipient-policy-sharing-target-24"
					onClick={openManagement}
					type="button"
				>
					Manage projects
				</button>
			</div>
			<p className="small" id={descriptionId}>
				Add projects only adds the selected Projects after you preview the exact changes.
			</p>
		</>
	);
}

function TeamsView({
	intent,
	projects,
}: {
	intent: RecipientPolicyIntentGraphV1;
	projects: RecipientPolicyManagementProject[];
}) {
	const activeTeams = intent.teams.filter((team) => team.status === "active");
	const activeIdentitiesById = new Map(
		intent.identities
			.filter((identity) => identity.status === "active")
			.map((identity) => [identity.identityId, identity]),
	);
	const projectsById = new Map(
		projects.map((project) => [project.canonicalProjectIdentity, project]),
	);

	if (activeTeams.length === 0) {
		return (
			<p className="small recipient-policy-sharing-empty" role="status">
				No active Teams are available for Project sharing.
			</p>
		);
	}

	return (
		<div className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
			{activeTeams.map((team, index) => {
				const memberIds = [
					...new Set(
						intent.teamMemberships
							.filter(
								(membership) =>
									membership.status === "active" &&
									membership.teamId === team.teamId &&
									activeIdentitiesById.has(membership.identityId),
							)
							.map((membership) => membership.identityId),
					),
				];
				const memberNames = memberIds.map(
					(identityId) => activeIdentitiesById.get(identityId)?.displayName ?? "",
				);
				const activeDeviceCount = new Set(
					intent.identityDevices
						.filter((device) => device.status === "active" && memberIds.includes(device.identityId))
						.map((device) => device.deviceId),
				).size;
				const projectNames = activeProjectNames(
					intent.projectRecipients
						.filter(
							(edge) =>
								edge.status === "active" &&
								edge.recipientKind === "team" &&
								edge.teamId === team.teamId,
						)
						.map((edge) => edge.canonicalProjectIdentity),
					projectsById,
				);
				const titleId = `recipient-policy-sharing-team-title-${index}`;
				const addDescriptionId = `recipient-policy-sharing-team-add-description-${index}`;
				return (
					<article
						aria-labelledby={titleId}
						className="peer-card peer-card--padded recipient-policy-sharing-card recipient-policy-sharing-team-card"
						key={team.teamId}
					>
						<div className="peer-title recipient-policy-sharing-card-title">
							<h3 id={titleId}>{team.displayName}</h3>
							<span className="badge actor-badge">Team</span>
						</div>
						<dl className="recipient-policy-sharing-details">
							<div>
								<dt>Current member Identities</dt>
								<dd>
									{countLabel(memberNames.length, "active member")} —{` `}
									{namesLabel(memberNames, "No active members")}
								</dd>
							</div>
							<div>
								<dt>Registered devices</dt>
								<dd>{countLabel(activeDeviceCount, "active registered device")}</dd>
							</div>
							<div>
								<dt>Shared Projects</dt>
								<dd>
									{countLabel(projectNames.length, "active shared Project")} —{` `}
									{namesLabel(projectNames, "No Projects shared")}
								</dd>
							</div>
							<div>
								<dt>Future Team members</dt>
								<dd>Yes — future Team members inherit the Team’s shared Projects.</dd>
							</div>
						</dl>
						<RecipientActions
							descriptionId={addDescriptionId}
							displayName={team.displayName}
							recipient={{ recipientKind: "team", teamId: team.teamId }}
						/>
					</article>
				);
			})}
		</div>
	);
}

function IdentitiesView({
	intent,
	projects,
}: {
	intent: RecipientPolicyIntentGraphV1;
	projects: RecipientPolicyManagementProject[];
}) {
	const activeIdentities = intent.identities.filter((identity) => identity.status === "active");
	const activeTeamsById = new Map(
		intent.teams.filter((team) => team.status === "active").map((team) => [team.teamId, team]),
	);
	const projectsById = new Map(
		projects.map((project) => [project.canonicalProjectIdentity, project]),
	);

	if (activeIdentities.length === 0) {
		return (
			<p className="small recipient-policy-sharing-empty" role="status">
				No active Identities are available for Project sharing.
			</p>
		);
	}

	return (
		<div className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
			{activeIdentities.map((identity, index) => {
				const activeDevices = intent.identityDevices.filter(
					(device) => device.status === "active" && device.identityId === identity.identityId,
				);
				const teamIds = [
					...new Set(
						intent.teamMemberships
							.filter(
								(membership) =>
									membership.status === "active" &&
									membership.identityId === identity.identityId &&
									activeTeamsById.has(membership.teamId),
							)
							.map((membership) => membership.teamId),
					),
				];
				const teamNames = teamIds.map((teamId) => activeTeamsById.get(teamId)?.displayName ?? "");
				const directProjectNames = activeProjectNames(
					intent.projectRecipients
						.filter(
							(edge) =>
								edge.status === "active" &&
								edge.recipientKind === "identity" &&
								edge.identityId === identity.identityId,
						)
						.map((edge) => edge.canonicalProjectIdentity),
					projectsById,
				);
				const inheritedProjectNames = activeProjectNames(
					intent.projectRecipients
						.filter(
							(edge) =>
								edge.status === "active" &&
								edge.recipientKind === "team" &&
								teamIds.includes(edge.teamId),
						)
						.map((edge) => edge.canonicalProjectIdentity),
					projectsById,
				);
				const titleId = `recipient-policy-sharing-identity-title-${index}`;
				const addDescriptionId = `recipient-policy-sharing-identity-add-description-${index}`;
				return (
					<article
						aria-labelledby={titleId}
						className="peer-card peer-card--padded recipient-policy-sharing-card recipient-policy-sharing-identity-card"
						key={identity.identityId}
					>
						<div className="peer-title recipient-policy-sharing-card-title">
							<h3 id={titleId}>{identity.displayName}</h3>
							<span className="badge actor-badge local">Local identity</span>
						</div>
						<dl className="recipient-policy-sharing-details">
							<div>
								<dt>Verification</dt>
								<dd>Local identity</dd>
							</div>
							<div>
								<dt>Registered devices</dt>
								<dd>
									{countLabel(activeDevices.length, "active registered device")} —{` `}
									{namesLabel(
										activeDevices.map((device) => device.displayName),
										"No active devices",
									)}
								</dd>
							</div>
							<div>
								<dt>Team memberships</dt>
								<dd>
									{countLabel(teamNames.length, "active Team membership")} —{` `}
									{namesLabel(teamNames, "No active Team memberships")}
								</dd>
							</div>
							<div>
								<dt>Directly shared Projects</dt>
								<dd>
									{countLabel(directProjectNames.length, "directly shared active Project")} —{` `}
									{namesLabel(directProjectNames, "No Projects shared directly")}
								</dd>
							</div>
							<div>
								<dt>Projects through Teams</dt>
								<dd>
									{countLabel(inheritedProjectNames.length, "Team-inherited Project")} —{` `}
									{namesLabel(inheritedProjectNames, "No Projects inherited through Teams")}
								</dd>
							</div>
						</dl>
						<p className="small">
							Projects through Teams are shown separately and are not direct Identity shares.
						</p>
						<RecipientActions
							descriptionId={addDescriptionId}
							displayName={identity.displayName}
							recipient={{ recipientKind: "identity", identityId: identity.identityId }}
						/>
					</article>
				);
			})}
		</div>
	);
}

function InvitationsView() {
	return (
		<div className="peer-card peer-card--padded recipient-policy-sharing-card recipient-policy-sharing-invitations">
			<h3>Invitation management is coming here later</h3>
			<p>
				Invitation management remains in Advanced Team administration until PR6’s recipient-aware
				journey lands.
			</p>
			<p className="small">Use Advanced Team administration to review current invitations.</p>
		</div>
	);
}

function RecipientPolicySharing({
	intent,
	options,
	projects,
}: {
	intent: RecipientPolicyIntentGraphV1;
	options: RecipientPolicySharingOptions;
	projects: RecipientPolicyManagementProject[];
}) {
	const [activeTab, setActiveTab] = useState<SharingTab>("teams");
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

	const activateTab = (index: number) => {
		const tab = SHARING_TABS[index];
		if (!tab) return;
		setActiveTab(tab.id);
		tabRefs.current[index]?.focus();
	};
	const handleTabKeyDown = (event: KeyboardEvent, index: number) => {
		let nextIndex: number | null = null;
		if (event.key === "ArrowRight") nextIndex = (index + 1) % SHARING_TABS.length;
		else if (event.key === "ArrowLeft") {
			nextIndex = (index - 1 + SHARING_TABS.length) % SHARING_TABS.length;
		} else if (event.key === "Home") nextIndex = 0;
		else if (event.key === "End") nextIndex = SHARING_TABS.length - 1;
		if (nextIndex === null) return;
		event.preventDefault();
		activateTab(nextIndex);
	};

	return (
		<section className="recipient-policy-sharing recipient-policy-sharing-responsive-surface">
			<header className="recipient-policy-sharing-header">
				<h2>Sharing</h2>
				<p className="small">
					See who receives Projects, how Team membership carries Project access, and where to make
					changes.
				</p>
			</header>
			<div
				aria-label="Sharing views"
				className="recipient-policy-sharing-tabs recipient-policy-sharing-responsive-tabs"
				role="tablist"
			>
				{SHARING_TABS.map((tab, index) => (
					<button
						aria-controls={`recipient-policy-sharing-panel-${tab.id}`}
						aria-selected={activeTab === tab.id}
						className={`tab-btn recipient-policy-sharing-tab recipient-policy-sharing-target recipient-policy-sharing-target-24${activeTab === tab.id ? " active" : ""}`}
						id={`recipient-policy-sharing-tab-${tab.id}`}
						key={tab.id}
						onClick={() => setActiveTab(tab.id)}
						onKeyDown={(event) => handleTabKeyDown(event, index)}
						ref={(element) => {
							tabRefs.current[index] = element;
						}}
						role="tab"
						tabIndex={activeTab === tab.id ? 0 : -1}
						type="button"
					>
						{tab.label}
					</button>
				))}
			</div>
			{SHARING_TABS.map((tab) => (
				<div
					aria-labelledby={`recipient-policy-sharing-tab-${tab.id}`}
					className="recipient-policy-sharing-panel"
					hidden={activeTab !== tab.id}
					id={`recipient-policy-sharing-panel-${tab.id}`}
					key={tab.id}
					role="tabpanel"
				>
					{options.loading ? (
						<p aria-live="polite" className="small" role="status">
							Loading Sharing details…
						</p>
					) : options.loadError ? (
						<p aria-live="assertive" role="alert">
							Sharing details are unavailable. Refresh and try again.
						</p>
					) : tab.id === "teams" ? (
						<TeamsView intent={intent} projects={projects} />
					) : tab.id === "identities" ? (
						<IdentitiesView intent={intent} projects={projects} />
					) : (
						<InvitationsView />
					)}
				</div>
			))}
		</section>
	);
}

export function mountRecipientPolicySharing(
	mount: HTMLElement,
	projects: RecipientPolicyManagementProject[],
	intent: RecipientPolicyIntentGraphV1,
	options: RecipientPolicySharingOptions = {},
): void {
	render(<RecipientPolicySharing intent={intent} options={options} projects={projects} />, mount);
}
