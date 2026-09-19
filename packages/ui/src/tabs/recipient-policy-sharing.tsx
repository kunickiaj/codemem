import { type ComponentChildren, h, render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { LoadingCardList } from "../components/LoadingCardList";
import { Chip } from "../components/primitives/chip";
import { TextInput } from "../components/primitives/text-input";
import type {
	DeviceIdentityInventoryV1,
	LegacyTeamSetupPendingCandidateSummaryV1,
	LegacyTeamSetupSummaryResponseV1,
	RecipientPolicyIntentGraphV1,
} from "../lib/api/sync";
import { deviceIdentityAttentionItems } from "../lib/device-identity-inventory";
import { ProvenanceChip } from "./feed/components/ProvenanceChip";
import { TagChip } from "./feed/components/TagChip";
import { RecipientPolicyInvitations } from "./recipient-policy-invitations";
import {
	openRecipientPolicyManagement,
	type RecipientPolicyManagementProject,
} from "./recipient-policy-management";
import type { ReceivedProjectShare } from "./recipient-policy-projects";
import { RecipientPolicyTeamSettings } from "./recipient-policy-team-settings";

export interface RecipientPolicySharingOptions {
	loading?: boolean;
	loadError?: boolean;
	refreshError?: boolean;
	deviceInventoryUnavailable?: boolean;
	received?: ReceivedProjectShare[];
	deviceInventory?: DeviceIdentityInventoryV1;
	onOpenTeamSetup?: (candidateRef: string) => void;
	onReviewDevices?: (deviceId?: string) => void;
	onTeamRenamed?: () => Promise<unknown> | unknown;
	renameTeam?: typeof import("../lib/api/sync").renameRecipientPolicyTeam;
	coordinatorEnrollmentIssueCount?: number;
	teamSetupSummary?: LegacyTeamSetupSummaryResponseV1;
	teamSetupLoading?: boolean;
	teamSetupUnavailable?: boolean;
}

type PendingTeamSetupStatus = LegacyTeamSetupPendingCandidateSummaryV1["status"];

const TEAM_SETUP_STATUS_LABELS: Record<PendingTeamSetupStatus, string> = {
	needs_setup: "Ready to review",
	in_progress: "Migration in progress",
	stale: "Migration review needs update",
};

const TEAM_SETUP_STATUS_CLASSES: Record<PendingTeamSetupStatus, string> = {
	needs_setup: "needs_attention",
	in_progress: "suggested",
	stale: "needs_attention",
};

// Safari/VoiceOver can drop list semantics when CSS removes native markers.
const EXPLICIT_LIST_ROLE = { role: "list" } as const;
const EXPLICIT_LIST_ITEM_ROLE = { role: "listitem" } as const;

function teamSetupStatusLabel(status: unknown): string {
	return typeof status === "string" && Object.hasOwn(TEAM_SETUP_STATUS_LABELS, status)
		? TEAM_SETUP_STATUS_LABELS[status as PendingTeamSetupStatus]
		: "Ready to review";
}

function teamSetupStatusClass(status: unknown): string {
	return typeof status === "string" && Object.hasOwn(TEAM_SETUP_STATUS_CLASSES, status)
		? TEAM_SETUP_STATUS_CLASSES[status as PendingTeamSetupStatus]
		: "needs_attention";
}

interface TeamSetupCandidateGroup {
	displayName: string;
	candidates: LegacyTeamSetupPendingCandidateSummaryV1[];
}

function teamSetupCandidateGroups(
	candidates: LegacyTeamSetupPendingCandidateSummaryV1[],
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
	candidates: LegacyTeamSetupPendingCandidateSummaryV1[];
	onOpenTeamSetup?: (candidateRef: string) => void;
}) {
	if (candidates.length === 0) return null;
	const groups = teamSetupCandidateGroups(candidates);
	return (
		<aside
			aria-labelledby="sharing-team-setup-heading"
			className="peer-card peer-card--padded recipient-policy-sharing-attention"
		>
			<h3 id="sharing-team-setup-heading">Legacy groups to migrate</h3>
			<p>Review current devices before migrating Team membership or project access.</p>
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
										? `Review and migrate ${group.displayName} ${ordinal}: ${safeSummary}`
										: `Review and migrate ${candidate.displayName}: ${safeSummary}`;
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
												<>
													<strong>{candidate.displayName}</strong>
													<span className="small"> · {safeSummary}</span>
												</>
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
											{onOpenTeamSetup ? (
												<button
													aria-label={actionLabel}
													className="settings-button recipient-policy-sharing-target-24"
													onClick={() => onOpenTeamSetup(candidate.candidateRef)}
													type="button"
												>
													Review and migrate
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

let pendingSharingTab: SharingTab | null = null;

export function requestSharingNavigation(tab: SharingTab): void {
	pendingSharingTab = tab;
	window.dispatchEvent(new CustomEvent("codemem:navigate-sharing", { detail: tab }));
}

const SHARING_TABS: Array<{ id: SharingTab; label: string }> = [
	{ id: "teams", label: "Teams" },
	{ id: "identities", label: "Identities" },
	{ id: "received", label: "From other devices" },
	{ id: "invitations", label: "Invitations" },
];

function useSharingNavigation(setActiveTab: (tab: SharingTab) => void): void {
	useEffect(() => {
		const navigate = (event: Event) => {
			const tab = (event as CustomEvent<SharingTab>).detail;
			if (!SHARING_TABS.some((candidate) => candidate.id === tab)) return;
			pendingSharingTab = null;
			setActiveTab(tab);
		};
		window.addEventListener("codemem:navigate-sharing", navigate);
		if (pendingSharingTab) {
			const tab = pendingSharingTab;
			pendingSharingTab = null;
			setActiveTab(tab);
		}
		return () => window.removeEventListener("codemem:navigate-sharing", navigate);
	}, [setActiveTab]);
}

function SharingTabPanel({
	children,
	hidden,
	tabId,
}: {
	children: ComponentChildren;
	hidden: boolean;
	tabId: SharingTab;
}) {
	// APG keeps tab panels keyboard-reachable when their content has no focusable control.
	return h(
		"div",
		{
			"aria-labelledby": `recipient-policy-sharing-tab-${tabId}`,
			className: "recipient-policy-sharing-panel",
			hidden,
			id: `recipient-policy-sharing-panel-${tabId}`,
			role: "tabpanel",
			tabIndex: 0,
		},
		children,
	);
}

function SharingTabPanelContent({
	active,
	intent,
	options,
	projects,
	tabId,
}: {
	active: boolean;
	intent: RecipientPolicyIntentGraphV1;
	options: RecipientPolicySharingOptions;
	projects: RecipientPolicyManagementProject[];
	tabId: SharingTab;
}) {
	if (options.loading) {
		if (!active) return null;
		return <LoadingCardList detailRowCount={4} label="Loading Sharing details" />;
	}
	if (options.loadError) {
		if (!active) return null;
		return (
			<p
				aria-live="assertive"
				className="recipient-policy-sharing-state recipient-policy-sharing-error"
				role="alert"
			>
				Sharing details are unavailable. Refresh and try again.
			</p>
		);
	}

	switch (tabId) {
		case "teams":
			return (
				<TeamsView
					disableMutations={options.refreshError === true}
					intent={intent}
					onTeamRenamed={options.onTeamRenamed}
					projects={projects}
					renameTeam={options.renameTeam}
				/>
			);
		case "identities":
			return (
				<IdentitiesView
					disableMutations={options.refreshError === true}
					intent={intent}
					projects={projects}
				/>
			);
		case "received":
			return <ReceivedView received={options.received ?? []} />;
		case "invitations":
			return <RecipientPolicyInvitations intent={intent} />;
		default:
			return null;
	}
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function activeProjectNames(
	projectIds: Iterable<string>,
	projectsById: Map<string, RecipientPolicyManagementProject>,
): string[] {
	return [
		...new Set(
			[...new Set(projectIds)].map(
				(projectId) => projectsById.get(projectId)?.displayName ?? "Unavailable Project",
			),
		),
	].sort((left, right) => left.localeCompare(right));
}

function firstName(displayName: string): string {
	return displayName.trim().split(/\s+/)[0] || "Unknown member";
}

const PROJECT_CHIP_LIMIT = 8;

function ProjectChips({ names }: { names: string[] }) {
	const [expanded, setExpanded] = useState(false);
	if (names.length === 0) return <>None</>;
	const visibleNames = expanded ? names : names.slice(0, PROJECT_CHIP_LIMIT);
	const hiddenCount = names.length - visibleNames.length;
	return (
		<div className="recipient-policy-sharing-chips">
			{visibleNames.map((name) => (
				<TagChip key={name} tag={name} />
			))}
			{hiddenCount > 0 ? (
				<button
					className="recipient-policy-sharing-more"
					onClick={() => setExpanded(true)}
					type="button"
				>
					+{hiddenCount} more
				</button>
			) : null}
		</div>
	);
}

function RecipientActions({
	disabled,
	displayName,
	recipient,
}: {
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
		<div className="peer-actions recipient-policy-sharing-actions recipient-policy-sharing-responsive-actions">
			<button
				aria-disabled={disabled ? "true" : undefined}
				aria-label={`Add projects for ${displayName}`}
				className="settings-save recipient-policy-sharing-target recipient-policy-sharing-target-24"
				onClick={() => {
					if (!disabled) openAdd();
				}}
				type="button"
			>
				Add projects
			</button>
			<button
				aria-disabled={disabled ? "true" : undefined}
				aria-label={`Manage projects for ${displayName}`}
				className="settings-button recipient-policy-sharing-target recipient-policy-sharing-target-24"
				onClick={() => {
					if (!disabled) openManagement();
				}}
				type="button"
			>
				Manage projects
			</button>
		</div>
	);
}

function TeamsView({
	disableMutations,
	intent,
	onTeamRenamed,
	projects,
	renameTeam,
}: {
	disableMutations: boolean;
	intent: RecipientPolicyIntentGraphV1;
	onTeamRenamed?: () => Promise<unknown> | unknown;
	projects: RecipientPolicyManagementProject[];
	renameTeam?: typeof import("../lib/api/sync").renameRecipientPolicyTeam;
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
	const viewerIdentityId = intent.identities.find(
		(identity) => identity.status === "active" && identity.verification === "local",
	)?.identityId;

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
				const memberNames = memberIds.map((identityId) => {
					const name = firstName(activeIdentitiesById.get(identityId)?.displayName ?? "");
					return identityId === viewerIdentityId ? `${name} (you)` : name;
				});
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
				return (
					<article
						aria-labelledby={titleId}
						className="peer-card peer-card--padded recipient-policy-sharing-card recipient-policy-sharing-team-card"
						key={team.teamId}
					>
						<div className="recipient-policy-sharing-card-header">
							<div className="peer-title recipient-policy-sharing-card-title">
								<h3 id={titleId}>{team.displayName}</h3>
								<Chip tone="actor-badge" variant="badge">
									Team
								</Chip>
								<Chip tone="badge-online" variant="badge">
									Auto-shares with new members
								</Chip>
							</div>
							<div className="recipient-policy-sharing-card-actions">
								<RecipientActions
									disabled={disableMutations}
									displayName={team.displayName}
									recipient={{ recipientKind: "team", teamId: team.teamId }}
								/>
								<RecipientPolicyTeamSettings
									disabled={disableMutations}
									displayName={team.displayName}
									onRenamed={onTeamRenamed}
									renameTeam={renameTeam}
									teamId={team.teamId}
								/>
							</div>
						</div>
						<div className="recipient-policy-sharing-stats">
							<div>
								<strong>{memberNames.length}</strong>
								<span>
									{memberNames.length === 1 ? "Member" : "Members"} ·{" "}
									{memberNames.join(", ") || "None"}
								</span>
							</div>
							<div>
								<strong>{activeDeviceCount}</strong>
								<span>Registered devices</span>
							</div>
							<div>
								<strong>{projectNames.length}</strong>
								<span>Shared projects · {projectNames.join(", ") || "None"}</span>
							</div>
						</div>
						<div className="recipient-policy-sharing-projects">
							<strong>Shared projects</strong>
							<ProjectChips names={projectNames} />
						</div>
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
				const titleId = `recipient-policy-sharing-identity-title-${index}`;
				return (
					<article
						aria-labelledby={titleId}
						className="peer-card peer-card--padded recipient-policy-sharing-card recipient-policy-sharing-identity-card"
						key={identity.identityId}
					>
						<div className="recipient-policy-sharing-card-header">
							<div className="peer-title recipient-policy-sharing-card-title">
								<h3 id={titleId}>{identity.displayName}</h3>
								<Chip tone="actor-badge local" variant="badge">
									Local identity
								</Chip>
							</div>
							<RecipientActions
								disabled={disableMutations}
								displayName={identity.displayName}
								recipient={{ recipientKind: "identity", identityId: identity.identityId }}
							/>
						</div>
						<div className="recipient-policy-sharing-identity-rows">
							<div>
								<strong>Devices · {activeDevices.length}</strong>
								<div className="recipient-policy-sharing-chips">
									{activeDevices.map((device) => (
										<ProvenanceChip
											key={device.deviceId}
											label={device.displayName}
											variant="device"
										/>
									))}
								</div>
							</div>
							<div>
								<strong>Teams · {teamNames.length}</strong>
								<div className="recipient-policy-sharing-chips">
									{teamNames.map((name) => (
										<ProvenanceChip key={name} label={name} variant="workspace" />
									))}
								</div>
							</div>
							<div>
								<strong>Shared directly</strong>
								<ProjectChips names={directProjectNames} />
							</div>
						</div>
					</article>
				);
			})}
		</div>
	);
}

function receivedFromLabel(originDevices: ReceivedProjectShare["originDevices"]): string {
	const distinctOrigins = [
		...new Map(originDevices.map((device) => [device.deviceId, device])).values(),
	];
	const names = distinctOrigins
		.map((device) => device.displayName?.trim())
		.filter((name): name is string => Boolean(name));
	if (names.length === 0) {
		return distinctOrigins.length <= 1
			? "Unknown device"
			: `${distinctOrigins.length.toLocaleString()} unknown devices`;
	}
	const visibleNames = names.slice(0, 2);
	const hiddenCount = distinctOrigins.length - visibleNames.length;
	return hiddenCount > 0
		? `${visibleNames.join(" · ")} · +${hiddenCount}`
		: visibleNames.join(" · ");
}

function ReceivedView({ received }: { received: ReceivedProjectShare[] }) {
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visibleShares = received.filter((share) =>
		share.displayName.toLocaleLowerCase().includes(normalizedQuery),
	);
	if (received.length === 0) {
		return (
			<p className="small recipient-policy-sharing-empty" role="status">
				No projects from other devices yet
			</p>
		);
	}
	return (
		<div className="recipient-policy-sharing-received">
			<div className="recipient-policy-sharing-toolbar">
				<label htmlFor="recipient-policy-sharing-search">
					<span className="sr-only">Search projects</span>
					<TextInput
						id="recipient-policy-sharing-search"
						onInput={(event) => setQuery(event.currentTarget.value)}
						placeholder="Search…"
						type="search"
						value={query}
					/>
				</label>
				<Chip tone="actor-badge" variant="badge">
					Read-only
				</Chip>
			</div>
			<table className="recipient-policy-sharing-received-table">
				<thead>
					<tr className="recipient-policy-sharing-received-head">
						<th scope="col">Project</th>
						<th scope="col">From</th>
						<th scope="col">Memories on this device</th>
						<th scope="col">Last session</th>
					</tr>
				</thead>
				<tbody>
					{visibleShares.map((share) => (
						<tr
							className="recipient-policy-sharing-received-row"
							key={share.canonicalProjectIdentity}
						>
							<td>
								<strong>{share.displayName}</strong>
							</td>
							<td data-label="From">{receivedFromLabel(share.originDevices)}</td>
							<td data-label="Memories on this device">
								{share.existingMemoryCount.toLocaleString()}
							</td>
							<td data-label="Last session">
								{share.latestSessionAt
									? new Date(share.latestSessionAt).toLocaleString()
									: "No recent sessions"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{visibleShares.length === 0 ? (
				<p className="small recipient-policy-sharing-empty" role="status">
					No matching projects
				</p>
			) : null}
		</div>
	);
}

function TeamSetupStatus({ options }: { options: RecipientPolicySharingOptions }) {
	return (
		<>
			<TeamSetupOverview
				candidates={options.teamSetupSummary?.candidates ?? []}
				onOpenTeamSetup={options.onOpenTeamSetup}
			/>
			{options.teamSetupLoading && !options.teamSetupSummary ? (
				<p aria-live="polite" className="small recipient-policy-sharing-empty" role="status">
					Team setup status is loading.
				</p>
			) : null}
			{options.teamSetupUnavailable ? (
				<p aria-live="polite" className="small recipient-policy-sharing-empty" role="status">
					{options.teamSetupSummary
						? "Team setup status is temporarily unavailable. The previous Team setup status is being shown."
						: "Team setup status is temporarily unavailable."}
				</p>
			) : null}
		</>
	);
}

function DeviceSetupStatus({ options }: { options: RecipientPolicySharingOptions }) {
	if (options.deviceInventoryUnavailable) {
		return (
			<p aria-live="polite" className="small recipient-policy-sharing-empty" role="status">
				Device Identity information is unavailable. Devices needing setup or review cannot be shown
				until a refresh succeeds.
			</p>
		);
	}
	const items = deviceIdentityAttentionItems(options.deviceInventory);
	if (items.length === 0) return null;
	return (
		<aside
			aria-labelledby="sharing-device-setup-heading"
			className="peer-card peer-card--padded recipient-policy-sharing-attention"
		>
			<h3 id="sharing-device-setup-heading">Identity setup needed</h3>
			<p>
				{items.length.toLocaleString()} {items.length === 1 ? "device needs" : "devices need"}{" "}
				setup, pairing, or review before ownership can be shown.
			</p>
			{options.onReviewDevices ? (
				<button
					className="settings-button recipient-policy-sharing-target-24"
					onClick={() => options.onReviewDevices?.(items[0]?.deviceId)}
					type="button"
				>
					Review devices
				</button>
			) : null}
		</aside>
	);
}

function ReconciliationStatus({ options }: { options: RecipientPolicySharingOptions }) {
	const count = options.coordinatorEnrollmentIssueCount ?? 0;
	if (count === 0) return null;
	return (
		<aside
			aria-labelledby="sharing-coordinator-reconciliation-heading"
			className="peer-card peer-card--padded recipient-policy-sharing-attention"
		>
			<h3 id="sharing-coordinator-reconciliation-heading">
				Device setup reconciliation needs attention
			</h3>
			<p>
				{count.toLocaleString()} coordinator enrollment{count === 1 ? " needs" : "s need"} device
				review.
			</p>
			{options.onReviewDevices ? (
				<button
					className="settings-button recipient-policy-sharing-target-24"
					onClick={() => options.onReviewDevices?.()}
					type="button"
				>
					Review devices
				</button>
			) : null}
		</aside>
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
	const explicitSelection = useRef(false);
	useSharingNavigation((tab) => {
		explicitSelection.current = true;
		setActiveTab(tab);
	});
	const initialSelectionPending = useRef(options.loading === true || options.loadError === true);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const hasActiveTeams = intent.teams.some((team) => team.status === "active");
	const tabCounts: Partial<Record<SharingTab, number>> = {
		teams: intent.teams.filter((team) => team.status === "active").length,
		identities: intent.identities.filter((identity) => identity.status === "active").length,
		received: options.received?.length ?? 0,
	};
	useEffect(() => {
		if (initialSelectionPending.current && !options.loading && !options.loadError) {
			initialSelectionPending.current = false;
			setActiveTab(hasActiveTeams ? "teams" : "identities");
			return;
		}
		if (!hasActiveTeams && !explicitSelection.current) {
			setActiveTab((current) => (current === "teams" ? "identities" : current));
		}
	}, [hasActiveTeams, options.loadError, options.loading]);

	const activateTab = (index: number) => {
		const tab = SHARING_TABS[index];
		if (!tab) return;
		explicitSelection.current = true;
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
			</header>
			<TeamSetupStatus options={options} />
			<DeviceSetupStatus options={options} />
			<ReconciliationStatus options={options} />
			{options.refreshError ? (
				<p
					aria-live="assertive"
					className="recipient-policy-sharing-state recipient-policy-sharing-error"
					role="alert"
				>
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
						{tabCounts[tab.id] === undefined ? null : (
							<span className="tertiary"> {tabCounts[tab.id]}</span>
						)}
					</button>
				))}
			</div>
			{SHARING_TABS.map((tab) => (
				<SharingTabPanel hidden={activeTab !== tab.id} key={tab.id} tabId={tab.id}>
					<SharingTabPanelContent
						active={activeTab === tab.id}
						intent={intent}
						options={options}
						projects={projects}
						tabId={tab.id}
					/>
				</SharingTabPanel>
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
