import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { LoadingCardList } from "../components/LoadingCardList";
import type {
	DeviceIdentityInventoryV1,
	LegacyTeamSetupCandidateSummaryV1,
	LegacyTeamSetupStatusV1,
	LegacyTeamSetupSummaryResponseV1,
	RecipientPolicyIntentGraphV1,
} from "../lib/api/sync";
import { deviceIdentityAttentionItems } from "../lib/device-identity-inventory";
import {
	type ProjectIdentityPresentationItem,
	projectIdentitySummaryGroups,
} from "../lib/project-identity-presentation";
import { RecipientPolicyInvitations } from "./recipient-policy-invitations";
import {
	openRecipientPolicyManagement,
	type RecipientPolicyManagementProject,
} from "./recipient-policy-management";
import type { ReceivedProjectShare } from "./recipient-policy-projects";

export interface RecipientPolicySharingOptions {
	loading?: boolean;
	loadError?: boolean;
	refreshError?: boolean;
	deviceInventoryUnavailable?: boolean;
	received?: ReceivedProjectShare[];
	deviceInventory?: DeviceIdentityInventoryV1;
	onOpenTeamSetup?: (candidateRef: string) => void;
	onReviewDevices?: (deviceId?: string) => void;
	coordinatorEnrollmentIssueCount?: number;
	teamSetupSummary?: LegacyTeamSetupSummaryResponseV1;
	teamSetupLoading?: boolean;
	teamSetupUnavailable?: boolean;
}

const TEAM_SETUP_STATUS_LABELS: Record<LegacyTeamSetupStatusV1, string> = {
	needs_setup: "Needs setup",
	in_progress: "In progress",
	stale: "Needs setup",
	ready: "Ready",
};

const TEAM_SETUP_STATUS_CLASSES: Record<LegacyTeamSetupStatusV1, string> = {
	needs_setup: "needs_attention",
	in_progress: "suggested",
	stale: "needs_attention",
	ready: "",
};

// Safari/VoiceOver can drop list semantics when CSS removes native markers.
const EXPLICIT_LIST_ROLE = { role: "list" } as const;
const EXPLICIT_LIST_ITEM_ROLE = { role: "listitem" } as const;

function teamSetupStatusLabel(status: unknown): string {
	return typeof status === "string" && Object.hasOwn(TEAM_SETUP_STATUS_LABELS, status)
		? TEAM_SETUP_STATUS_LABELS[status as LegacyTeamSetupStatusV1]
		: "Needs setup";
}

function teamSetupStatusClass(status: unknown): string {
	return typeof status === "string" && Object.hasOwn(TEAM_SETUP_STATUS_CLASSES, status)
		? TEAM_SETUP_STATUS_CLASSES[status as LegacyTeamSetupStatusV1]
		: "needs_attention";
}

interface TeamSetupCandidateGroup {
	displayName: string;
	candidates: LegacyTeamSetupCandidateSummaryV1[];
}

function teamSetupCandidateGroups(
	candidates: LegacyTeamSetupCandidateSummaryV1[],
): TeamSetupCandidateGroup[] {
	const groups = new Map<string, TeamSetupCandidateGroup>();
	for (const candidate of candidates) {
		const key = candidate.displayName.trim().toLowerCase();
		const group = groups.get(key);
		if (group) groups.set(key, { ...group, candidates: [...group.candidates, candidate] });
		else groups.set(key, { displayName: candidate.displayName, candidates: [candidate] });
	}
	return [...groups.values()].map((group) => ({
		...group,
		candidates: [...group.candidates].sort((left, right) =>
			left.candidateRef < right.candidateRef ? -1 : left.candidateRef > right.candidateRef ? 1 : 0,
		),
	}));
}

function TeamSetupOverview({
	candidates,
	onOpenTeamSetup,
}: {
	candidates: LegacyTeamSetupCandidateSummaryV1[];
	onOpenTeamSetup?: (candidateRef: string) => void;
}) {
	if (candidates.length === 0) return null;
	const pending = candidates.filter((candidate) => candidate.status !== "ready");
	const groups = teamSetupCandidateGroups(candidates);
	return (
		<aside
			aria-labelledby="sharing-team-setup-heading"
			className="peer-card peer-card--padded recipient-policy-sharing-attention"
		>
			<h3 id="sharing-team-setup-heading">
				{pending.length > 0
					? `${pending.length} ${pending.length === 1 ? "Team needs" : "Teams need"} setup`
					: "Team setup"}
			</h3>
			{pending.length > 0 ? (
				<p>Tell Codemem who uses each device before using these Teams for sharing.</p>
			) : null}
			<ul
				{...EXPLICIT_LIST_ROLE}
				className="recipient-policy-sharing-team-setup-list"
				aria-label="Team setup status"
			>
				{groups.map((group) => (
					<li
						{...EXPLICIT_LIST_ITEM_ROLE}
						className="recipient-policy-sharing-team-setup-group"
						key={group.displayName}
					>
						{group.candidates.length > 1 ? (
							<div className="recipient-policy-sharing-team-setup-group-title">
								<strong>{group.displayName}</strong>
								<span className="small">{group.candidates.length} Teams</span>
							</div>
						) : null}
						<div className="recipient-policy-sharing-team-setup-rows">
							{group.candidates.map((candidate, index) => {
								const ordinal = `${index + 1} of ${group.candidates.length}`;
								const safeSummary = `${countLabel(candidate.deviceCount, "device")}, ${countLabel(candidate.projectCount, "Project")}`;
								const actionLabel =
									group.candidates.length > 1
										? `Continue setup for ${group.displayName} ${ordinal}: ${safeSummary}`
										: `Continue setup for ${candidate.displayName}`;
								return (
									<div
										className="recipient-policy-sharing-team-setup-row"
										key={candidate.candidateRef}
									>
										<span className="recipient-policy-sharing-team-setup-label">
											{group.candidates.length > 1 ? (
												<span className="small">
													Team {ordinal} · {safeSummary}
												</span>
											) : (
												<strong>{candidate.displayName}</strong>
											)}
											<span
												aria-hidden="true"
												className="recipient-policy-sharing-team-setup-separator"
											>
												{" "}
												—{" "}
											</span>
										</span>
										<span className="recipient-policy-sharing-team-setup-status">
											<span
												className={`project-status-badge ${teamSetupStatusClass(candidate.status)}`.trim()}
											>
												{teamSetupStatusLabel(candidate.status)}
											</span>
										</span>
										<span className="recipient-policy-sharing-team-setup-action">
											{candidate.status !== "ready" && onOpenTeamSetup ? (
												<button
													aria-label={actionLabel}
													className="settings-button recipient-policy-sharing-target-24"
													onClick={() => onOpenTeamSetup(candidate.candidateRef)}
													type="button"
												>
													Continue setup
												</button>
											) : null}
										</span>
									</div>
								);
							})}
						</div>
					</li>
				))}
			</ul>
		</aside>
	);
}

type SharingTab = "teams" | "identities" | "received" | "invitations";

const SHARING_TABS: Array<{ id: SharingTab; label: string }> = [
	{ id: "teams", label: "Teams" },
	{ id: "identities", label: "Identities" },
	{ id: "received", label: "Received" },
	{ id: "invitations", label: "Invitations" },
];

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function namesLabel(names: string[], empty: string): string {
	return names.length ? names.join(", ") : empty;
}

function activeProjectIdentities(
	projectIds: Iterable<string>,
	projectsById: Map<string, RecipientPolicyManagementProject>,
): ProjectIdentityPresentationItem[] {
	return [...new Set(projectIds)].map((projectId) => {
		const project = projectsById.get(projectId);
		return {
			canonicalId: projectId,
			displayName: project?.displayName ?? "Unavailable Project",
		};
	});
}

const PROJECT_GROUP_PREVIEW_LIMIT = 3;

function ProjectIdentitySummary({
	empty,
	identities,
	qualifier,
}: {
	empty: string;
	identities: ProjectIdentityPresentationItem[];
	qualifier: string;
}) {
	if (identities.length === 0) return <>{empty}</>;
	const groups = projectIdentitySummaryGroups(identities);
	const groupLabel = (group: (typeof groups)[number]) =>
		group.identityCount > 1
			? `${group.displayName} (${countLabel(group.identityCount, "identity", "identities")})`
			: group.displayName;
	const preview = groups.slice(0, PROJECT_GROUP_PREVIEW_LIMIT);
	return (
		<>
			{countLabel(
				identities.length,
				`${qualifier} Project identity`,
				`${qualifier} Project identities`,
			)}{" "}
			— {preview.map(groupLabel).join(", ")}
			{groups.length > PROJECT_GROUP_PREVIEW_LIMIT ? (
				<>
					<span aria-hidden="true">, …</span>
					<details className="recipient-policy-sharing-project-details">
						<summary>View all {countLabel(groups.length, "Project name group")}</summary>
						<ul {...EXPLICIT_LIST_ROLE} aria-label={`All ${qualifier} Project identity groups`}>
							{groups.map((group) => (
								<li {...EXPLICIT_LIST_ITEM_ROLE} key={group.displayName}>
									{groupLabel(group)}
								</li>
							))}
						</ul>
					</details>
				</>
			) : null}
		</>
	);
}

function RecipientActions({
	descriptionId,
	disabled,
	displayName,
	recipient,
}: {
	descriptionId: string;
	disabled: boolean;
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
					disabled={disabled}
					onClick={openAdd}
					type="button"
				>
					Add projects
				</button>
				<button
					aria-label={`Manage Projects for ${displayName}`}
					className="settings-button recipient-policy-sharing-target recipient-policy-sharing-target-24"
					disabled={disabled}
					onClick={openManagement}
					type="button"
				>
					Manage projects
				</button>
			</div>
			<p className="small" id={descriptionId}>
				{disabled
					? "Team and Identity Project changes are disabled until a refresh succeeds."
					: "Add projects only adds the selected Projects after you preview the exact changes."}
			</p>
		</>
	);
}

function TeamsView({
	disableMutations,
	intent,
	projects,
}: {
	disableMutations: boolean;
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
				const projectIdentities = activeProjectIdentities(
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
									<ProjectIdentitySummary
										empty="No Projects shared"
										identities={projectIdentities}
										qualifier="active shared"
									/>
								</dd>
							</div>
							<div>
								<dt>Future Team members</dt>
								<dd>Yes — future Team members inherit the Team’s shared Projects.</dd>
							</div>
						</dl>
						<RecipientActions
							descriptionId={addDescriptionId}
							disabled={disableMutations}
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
	disableMutations,
	intent,
	projects,
}: {
	disableMutations: boolean;
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
				const directProjectIdentities = activeProjectIdentities(
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
									<ProjectIdentitySummary
										empty="No Projects shared directly"
										identities={directProjectIdentities}
										qualifier="directly shared active"
									/>
								</dd>
							</div>
						</dl>
						<p className="small">
							Team Projects are shown on Team cards because per-device eligibility cannot be
							inferred from Identity membership alone.
						</p>
						<RecipientActions
							descriptionId={addDescriptionId}
							disabled={disableMutations}
							displayName={identity.displayName}
							recipient={{ recipientKind: "identity", identityId: identity.identityId }}
						/>
					</article>
				);
			})}
		</div>
	);
}

function ReceivedView({ received }: { received: ReceivedProjectShare[] }) {
	if (received.length === 0) {
		return (
			<p className="small recipient-policy-sharing-empty" role="status">
				No received Projects on this device. Accepted invitations appear here once their first sync
				completes.
			</p>
		);
	}
	return (
		<div className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
			{received.map((share, index) => {
				const titleId = `recipient-policy-sharing-received-title-${index}`;
				return (
					<article
						aria-labelledby={titleId}
						className="peer-card peer-card--padded recipient-policy-sharing-card recipient-policy-sharing-received-card"
						key={share.canonicalProjectIdentity}
					>
						<div className="peer-title recipient-policy-sharing-card-title">
							<h3 id={titleId}>{share.displayName}</h3>
							<span className="badge actor-badge">Received</span>
						</div>
						<dl className="recipient-policy-sharing-details">
							<div>
								<dt>Memories on this device</dt>
								<dd>{countLabel(share.existingMemoryCount, "memory", "memories")}</dd>
							</div>
							<div>
								<dt>Latest activity</dt>
								<dd>
									{share.latestSessionAt
										? new Date(share.latestSessionAt).toLocaleString()
										: "No recent sessions"}
								</dd>
							</div>
						</dl>
						<p className="small">
							This Project is received from another device. Access is managed where the Project is
							shared from; this device keeps it read-only.
						</p>
					</article>
				);
			})}
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
	const [activeTab, setActiveTab] = useState<SharingTab>(() =>
		intent.teams.some((team) => team.status === "active") ? "teams" : "identities",
	);
	const initialSelectionPending = useRef(options.loading === true || options.loadError === true);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const setupAttentionItems = deviceIdentityAttentionItems(options.deviceInventory);
	const setupAttentionCount = setupAttentionItems.length;
	const reconciliationIssueCount = options.coordinatorEnrollmentIssueCount ?? 0;
	const hasActiveTeams = intent.teams.some((team) => team.status === "active");
	useEffect(() => {
		if (initialSelectionPending.current && !options.loading && !options.loadError) {
			initialSelectionPending.current = false;
			setActiveTab(hasActiveTeams ? "teams" : "identities");
			return;
		}
		if (!hasActiveTeams) setActiveTab((current) => (current === "teams" ? "identities" : current));
	}, [hasActiveTeams, options.loadError, options.loading]);

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
			<TeamSetupOverview
				candidates={options.teamSetupSummary?.candidates ?? []}
				onOpenTeamSetup={options.onOpenTeamSetup}
			/>
			{options.teamSetupLoading ? (
				<p aria-live="polite" className="small recipient-policy-sharing-empty" role="status">
					{options.teamSetupSummary
						? "Team setup status is being refreshed. The previous Team setup status is being shown."
						: "Team setup status is loading."}
				</p>
			) : null}
			{options.teamSetupUnavailable ? (
				<p aria-live="polite" className="small recipient-policy-sharing-empty" role="status">
					{options.teamSetupSummary
						? "Team setup status is temporarily unavailable. The previous Team setup status is being shown."
						: "Team setup status is temporarily unavailable."}
				</p>
			) : null}
			{options.deviceInventoryUnavailable ? (
				<p aria-live="polite" className="small recipient-policy-sharing-empty" role="status">
					Device Identity information is unavailable. Devices needing setup or review cannot be
					shown until a refresh succeeds.
				</p>
			) : null}
			{setupAttentionCount > 0 && !options.deviceInventoryUnavailable ? (
				<aside
					aria-labelledby="sharing-device-setup-heading"
					className="peer-card peer-card--padded recipient-policy-sharing-attention"
				>
					<h3 id="sharing-device-setup-heading">Identity setup needed</h3>
					<p>
						{setupAttentionCount.toLocaleString()}{" "}
						{setupAttentionCount === 1 ? "device needs" : "devices need"} setup, pairing, or review
						before ownership can be shown accurately.
					</p>
					<p className="small">
						Identity setup records device ownership only. It does not grant Projects, Team
						membership, or sync access.
					</p>
					{options.onReviewDevices ? (
						<button
							className="settings-button recipient-policy-sharing-target-24"
							onClick={() => options.onReviewDevices?.(setupAttentionItems[0]?.deviceId)}
							type="button"
						>
							Review Devices
						</button>
					) : null}
				</aside>
			) : null}
			{reconciliationIssueCount > 0 ? (
				<aside
					aria-labelledby="sharing-coordinator-reconciliation-heading"
					className="peer-card peer-card--padded recipient-policy-sharing-attention"
				>
					<h3 id="sharing-coordinator-reconciliation-heading">
						Device setup reconciliation needs attention
					</h3>
					<p>
						{reconciliationIssueCount.toLocaleString()} coordinator enrollment
						{reconciliationIssueCount === 1 ? " could" : "s could"} not be safely reconciled.
						Sharing remains unchanged until the device evidence is valid.
					</p>
					<p className="small">
						Coordinator groups are discovery boundaries, not policy Teams, and do not prove device
						ownership.
					</p>
					{options.onReviewDevices ? (
						<button
							className="settings-button recipient-policy-sharing-target-24"
							onClick={() => options.onReviewDevices?.()}
							type="button"
						>
							Review Devices
						</button>
					) : null}
				</aside>
			) : null}
			{options.refreshError ? (
				<p aria-live="assertive" role="alert">
					Refresh failed; showing previous Sharing details. Team and Identity Project changes are
					disabled until a refresh succeeds.
				</p>
			) : null}
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
						activeTab === tab.id ? (
							<LoadingCardList detailRowCount={4} label="Loading Sharing details" />
						) : null
					) : options.loadError ? (
						activeTab === tab.id ? (
							<p aria-live="assertive" role="alert">
								Sharing details are unavailable. Refresh and try again.
							</p>
						) : null
					) : tab.id === "teams" ? (
						<TeamsView
							disableMutations={options.refreshError === true}
							intent={intent}
							projects={projects}
						/>
					) : tab.id === "identities" ? (
						<IdentitiesView
							disableMutations={options.refreshError === true}
							intent={intent}
							projects={projects}
						/>
					) : tab.id === "received" ? (
						<ReceivedView received={options.received ?? []} />
					) : (
						<RecipientPolicyInvitations intent={intent} />
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
