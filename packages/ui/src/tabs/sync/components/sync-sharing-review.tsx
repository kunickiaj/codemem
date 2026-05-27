import { useState } from "preact/hooks";

import type { LegacySharedReviewReassignmentPreview } from "../../../lib/api/sync";

export interface SyncSharingReviewItem {
	actorDisplayName: string;
	actorId: string;
	peerName: string;
	privateCount: number;
	scopeLabel: string;
	shareableCount: number;
}

export interface SyncLegacySharedReviewItem {
	groups?: SyncLegacySharedReviewGroup[];
	memoryCount: number;
	scopeId: string;
	targetScopes?: SyncLegacySharedReviewTargetScope[];
	totalGroupCount?: number;
}

export interface SyncLegacySharedReviewTargetScope {
	authorityType: string;
	label: string;
	scopeId: string;
}

export interface SyncLegacySharedReviewGroup {
	displayProject: string;
	identitySource: string;
	lastUpdatedAt: string | null;
	memoryCount: number;
	memorySamples?: SyncLegacySharedReviewMemorySample[];
	peerOwnedMemoryCount?: number;
	reassignableMemoryCount?: number;
	suggestedScopeId: string | null;
	suggestionReason: string | null;
	workspaceIdentity: string;
}

export interface SyncLegacySharedReviewMemorySample {
	bodyPreview: string | null;
	createdAt: string | null;
	cwd: string | null;
	gitRemote: string | null;
	id: number;
	kind: string | null;
	ownership: "local" | "peer";
	project: string | null;
	title: string;
	updatedAt: string | null;
}

type SyncSharingReviewProps = {
	items: SyncSharingReviewItem[];
	legacyReview?: SyncLegacySharedReviewItem | null;
	onLegacyReassign?: (
		group: SyncLegacySharedReviewGroup,
		scopeId: string,
		confirmedOldCopies: boolean,
		confirmationToken?: string,
	) => Promise<LegacySharedReviewReassignmentPreview | null>;
	onLegacyReview?: () => void;
	onReview: () => void;
};

function formatIdentitySource(source: string): string {
	switch (source) {
		case "cwd":
			return "Matched by folder";
		case "git_remote":
			return "Matched by git remote";
		case "workspace_id":
			return "Matched by workspace";
		case "project":
			return "Matched by project name";
		case "unmapped":
			return "Missing project identity";
		default:
			return `Matched by ${source.replace(/_/g, " ")}`;
	}
}

function needsProjectCleanup(group: SyncLegacySharedReviewGroup): boolean {
	const label = group.displayProject.toLowerCase();
	return (
		label.includes("fatal:") ||
		label.includes("not a git repository") ||
		label === "unknown project" ||
		group.identitySource === "unmapped"
	);
}

function displayProjectTitle(group: SyncLegacySharedReviewGroup): string {
	return needsProjectCleanup(group) ? "Unclear project identity" : group.displayProject;
}

function canReassignLegacyGroup(group: SyncLegacySharedReviewGroup): boolean {
	return (group.reassignableMemoryCount ?? group.memoryCount) > 0;
}

function suggestedScopeText(
	group: SyncLegacySharedReviewGroup,
	targetScopes: SyncLegacySharedReviewTargetScope[],
): string {
	if (!group.suggestedScopeId) return "";
	const target = targetScopes.find((scope) => scope.scopeId === group.suggestedScopeId);
	return ` · suggested ${target?.label || "Space"}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function targetScopeLabel(
	scopeId: string,
	targetScopes: SyncLegacySharedReviewTargetScope[],
): string {
	return targetScopes.find((scope) => scope.scopeId === scopeId)?.label || "selected Space";
}

function authorityLabel(authorityType: string): string {
	switch (authorityType) {
		case "coordinator":
			return "Team Space";
		case "local":
			return "Local Space";
		default:
			return "Other Space";
	}
}

function formatSampleDate(value: string | null): string {
	if (!value) return "date unavailable";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("en-US", {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
		year: "numeric",
	}).format(date);
}

function sampleOrigin(sample: SyncLegacySharedReviewMemorySample): string {
	if (sample.gitRemote) return sample.gitRemote;
	if (sample.cwd) return sample.cwd;
	if (sample.project) return sample.project;
	return "source identity unavailable";
}

function LegacyMemorySamples({ group }: { group: SyncLegacySharedReviewGroup }) {
	const samples = group.memorySamples ?? [];
	const shownCount = samples.length;
	return (
		<details className="legacy-review-samples">
			<summary>
				Inspect affected memories
				{shownCount ? ` (${shownCount} sample${shownCount === 1 ? "" : "s"})` : ""}
			</summary>
			<div className="legacy-review-cleanup-note">
				Showing representative memories from this project group before reassignment. Local memories
				can be reassigned; peer-owned memories stay in review on this device.
			</div>
			{samples.length > 0 ? (
				<ul className="legacy-review-sample-list">
					{samples.map((sample) => (
						<li className="legacy-review-sample" key={sample.id}>
							<div className="legacy-review-sample-title">{sample.title}</div>
							<div className="legacy-review-group-meta">
								{sample.kind || "memory"} · {formatSampleDate(sample.updatedAt ?? sample.createdAt)}{" "}
								·{" "}
								{sample.ownership === "local"
									? "local, reassignable"
									: "peer-owned, stays in review"}
							</div>
							{sample.bodyPreview ? (
								<div className="legacy-review-sample-body">{sample.bodyPreview}</div>
							) : null}
							<div className="legacy-review-group-meta mono">{sampleOrigin(sample)}</div>
						</li>
					))}
				</ul>
			) : (
				<div className="legacy-review-cleanup-note">
					No samples are available for this group. Refresh Sync and try again before reassigning.
				</div>
			)}
		</details>
	);
}

function formatLegacyReviewError(
	error: unknown,
	scopeId: string,
	targetScopes: SyncLegacySharedReviewTargetScope[],
): string {
	const message =
		error instanceof Error ? error.message : "Unable to reassign legacy review memories.";
	let result = message.replace(/sharing domain/gi, "Space");
	if (scopeId) {
		result = result.replace(
			new RegExp(`\\b${escapeRegExp(scopeId)}\\b`, "g"),
			targetScopeLabel(scopeId, targetScopes),
		);
	}
	return result;
}

function groupSearchText(
	group: SyncLegacySharedReviewGroup,
	targetScopes: SyncLegacySharedReviewTargetScope[],
): string {
	const suggestedScopeLabel = group.suggestedScopeId
		? targetScopes.find((scope) => scope.scopeId === group.suggestedScopeId)?.label
		: "";
	return [
		group.displayProject,
		group.identitySource,
		group.suggestedScopeId ?? "",
		suggestedScopeLabel ?? "",
		group.suggestionReason ?? "",
		group.workspaceIdentity,
	]
		.join(" ")
		.toLowerCase();
}

function SharingReviewRow({
	item,
	onReview,
}: {
	item: SyncSharingReviewItem;
	onReview: () => void;
}) {
	return (
		<div className="actor-row">
			<div className="actor-details">
				<div className="actor-title">
					<strong>{item.peerName}</strong>
					<span className="badge actor-badge">person: {item.actorDisplayName || item.actorId}</span>
				</div>
				<div className="peer-meta">
					{item.shareableCount} share by default · {item.privateCount} marked Only me ·{" "}
					{item.scopeLabel}
				</div>
			</div>
			<div className="actor-actions">
				<button type="button" className="settings-button" onClick={onReview}>
					Review my memories in Feed
				</button>
			</div>
		</div>
	);
}

function LegacySharedReviewRow({
	item,
	onReassign,
	onReview,
}: {
	item: SyncLegacySharedReviewItem;
	onReassign?: (
		group: SyncLegacySharedReviewGroup,
		scopeId: string,
		confirmedOldCopies: boolean,
		confirmationToken?: string,
	) => Promise<LegacySharedReviewReassignmentPreview | null>;
	onReview: () => void;
}) {
	const groups = item.groups ?? [];
	const targetScopes = item.targetScopes ?? [];
	const initialSelections = Object.fromEntries(
		groups.map((group) => [group.workspaceIdentity, group.suggestedScopeId ?? ""]),
	);
	const [pending, setPending] = useState<Record<string, LegacySharedReviewReassignmentPreview>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [selectedScopes, setSelectedScopes] = useState<Record<string, string>>(initialSelections);
	const [selectedGroups, setSelectedGroups] = useState<Record<string, boolean>>({});
	const [filter, setFilter] = useState("all");
	const [query, setQuery] = useState("");
	const [busyIdentity, setBusyIdentity] = useState<string | null>(null);
	const shownGroupCount = groups.length;
	const groupCount = item.totalGroupCount ?? shownGroupCount;
	const cleanupCount = groups.filter(needsProjectCleanup).length;
	const suggestedCount = groups.filter(
		(group) =>
			group.suggestedScopeId && !needsProjectCleanup(group) && canReassignLegacyGroup(group),
	).length;
	const selectedReassignableCount = groups.filter(
		(group) => selectedGroups[group.workspaceIdentity] && canReassignLegacyGroup(group),
	).length;
	const selectedCount = groups.filter(
		(group) =>
			selectedGroups[group.workspaceIdentity] &&
			canReassignLegacyGroup(group) &&
			Boolean(selectedScopes[group.workspaceIdentity]),
	).length;
	const visibleGroups = groups.filter((group) => {
		const cleanup = needsProjectCleanup(group);
		if (filter === "suggested" && (!group.suggestedScopeId || cleanup)) return false;
		if (filter === "cleanup" && !cleanup) return false;
		if (filter === "no-suggestion" && (group.suggestedScopeId || cleanup)) return false;
		if (filter === "selected" && !selectedGroups[group.workspaceIdentity]) return false;
		return (
			!query.trim() || groupSearchText(group, targetScopes).includes(query.trim().toLowerCase())
		);
	});
	async function applyGroup(group: SyncLegacySharedReviewGroup) {
		const selectedScopeId = selectedScopes[group.workspaceIdentity] || group.suggestedScopeId || "";
		if (!selectedScopeId || !onReassign || busyIdentity) return;
		setBusyIdentity(group.workspaceIdentity);
		setErrors((current) => {
			const next = { ...current };
			delete next[group.workspaceIdentity];
			return next;
		});
		try {
			const preview = await onReassign(
				group,
				selectedScopeId,
				Boolean(pending[group.workspaceIdentity]),
				pending[group.workspaceIdentity]?.confirmation_token,
			);
			if (preview) setPending((current) => ({ ...current, [group.workspaceIdentity]: preview }));
			else {
				setPending((current) => {
					const next = { ...current };
					delete next[group.workspaceIdentity];
					return next;
				});
			}
		} catch (error) {
			setErrors((current) => ({
				...current,
				[group.workspaceIdentity]: formatLegacyReviewError(error, selectedScopeId, targetScopes),
			}));
		} finally {
			setBusyIdentity(null);
		}
	}
	function updateSelectedScope(group: SyncLegacySharedReviewGroup, scopeId: string) {
		setSelectedScopes((current) => ({ ...current, [group.workspaceIdentity]: scopeId }));
		setPending((current) => {
			const next = { ...current };
			delete next[group.workspaceIdentity];
			return next;
		});
		setErrors((current) => {
			const next = { ...current };
			delete next[group.workspaceIdentity];
			return next;
		});
	}
	function toggleGroup(group: SyncLegacySharedReviewGroup, checked: boolean) {
		setSelectedGroups((current) => ({ ...current, [group.workspaceIdentity]: checked }));
	}
	function setVisibleSelected(checked: boolean) {
		setSelectedGroups((current) => ({
			...current,
			...Object.fromEntries(
				visibleGroups
					.filter(canReassignLegacyGroup)
					.map((group) => [group.workspaceIdentity, checked]),
			),
		}));
	}
	function selectSuggestedGroups() {
		setSelectedGroups((current) => ({
			...current,
			...Object.fromEntries(
				groups
					.filter(
						(group) =>
							group.suggestedScopeId &&
							!needsProjectCleanup(group) &&
							canReassignLegacyGroup(group),
					)
					.map((group) => [group.workspaceIdentity, true]),
			),
		}));
	}
	async function applySelectedGroups() {
		if (!onReassign || busyIdentity || selectedCount === 0) return;
		const selected = groups.filter(
			(group) =>
				selectedGroups[group.workspaceIdentity] &&
				canReassignLegacyGroup(group) &&
				Boolean(selectedScopes[group.workspaceIdentity]),
		);
		if (selected.every((group) => pending[group.workspaceIdentity])) return;
		setBusyIdentity("bulk");
		try {
			for (const group of selected) {
				if (pending[group.workspaceIdentity]) continue;
				const selectedScopeId =
					selectedScopes[group.workspaceIdentity] || group.suggestedScopeId || "";
				if (!selectedScopeId) continue;
				try {
					const preview = await onReassign(group, selectedScopeId, false);
					setErrors((current) => {
						const next = { ...current };
						delete next[group.workspaceIdentity];
						return next;
					});
					if (preview) {
						setPending((current) => ({ ...current, [group.workspaceIdentity]: preview }));
					}
				} catch (error) {
					setErrors((current) => ({
						...current,
						[group.workspaceIdentity]: formatLegacyReviewError(
							error,
							selectedScopeId,
							targetScopes,
						),
					}));
				}
			}
		} finally {
			setBusyIdentity(null);
		}
	}
	return (
		<div className="legacy-review-card">
			<div className="legacy-review-header">
				<div>
					<div className="actor-title">
						<strong>Legacy shared review</strong>
						<span className="badge badge-offline">Needs project review</span>
					</div>
					<div className="peer-meta legacy-review-summary">
						{groupCount.toLocaleString()} older{" "}
						{groupCount === 1 ? "project needs" : "projects need"} a Space. They contain{" "}
						{item.memoryCount.toLocaleString()} older shared memories total; review the projects,
						not individual memories.
						{shownGroupCount < groupCount
							? ` Showing ${shownGroupCount.toLocaleString()} projects; open Projects to review the rest.`
							: ""}
					</div>
					<div className="peer-meta legacy-review-warning">
						Fix peer-owned projects on their source device. Reassignment updates future sync
						authorization; online compatible peers should converge after syncing, but offline
						devices, backups, copied databases, malicious peers, or old versions may retain old
						copies.
					</div>
				</div>
				<div className="actor-actions">
					<button type="button" className="settings-button" onClick={onReview}>
						Manage all projects
					</button>
				</div>
			</div>
			<div className="legacy-review-toolbar">
				<div className="legacy-review-filter-row">
					{[
						["all", `Showing ${shownGroupCount.toLocaleString()}`],
						["suggested", `Suggested ${suggestedCount.toLocaleString()}`],
						["cleanup", `Needs cleanup ${cleanupCount.toLocaleString()}`],
						["no-suggestion", "No suggestion"],
						["selected", `Selected ${selectedCount.toLocaleString()}`],
					].map(([value, label]) => (
						<button
							className={
								filter === value
									? "settings-button legacy-filter active"
									: "settings-button legacy-filter"
							}
							key={value}
							onClick={() => setFilter(value)}
							type="button"
						>
							{label}
						</button>
					))}
				</div>
				<div className="legacy-review-bulk-row">
					<input
						aria-label="Search legacy project groups"
						className="peer-scope-input legacy-review-search"
						onInput={(event) => setQuery(event.currentTarget.value)}
						placeholder="Search project, signal, or destination…"
						value={query}
					/>
					<button
						className="settings-button"
						onClick={() => setVisibleSelected(true)}
						type="button"
					>
						Select visible
					</button>
					<button className="settings-button" onClick={selectSuggestedGroups} type="button">
						Select suggested
					</button>
					<button
						className="settings-button"
						onClick={() => setVisibleSelected(false)}
						type="button"
					>
						Clear visible
					</button>
					{onReassign && targetScopes.length > 0 ? (
						<button
							className="settings-save"
							disabled={
								busyIdentity != null ||
								selectedCount === 0 ||
								groups
									.filter(
										(group) =>
											selectedGroups[group.workspaceIdentity] &&
											canReassignLegacyGroup(group) &&
											Boolean(selectedScopes[group.workspaceIdentity]),
									)
									.every((group) => pending[group.workspaceIdentity])
							}
							onClick={() => void applySelectedGroups()}
							type="button"
						>
							{busyIdentity === "bulk"
								? "Previewing…"
								: `Preview ${selectedCount.toLocaleString()} selected`}
						</button>
					) : onReassign && selectedReassignableCount > 0 ? (
						<span className="legacy-review-cleanup-note">
							Add or join a Space before bulk reassignment.
						</span>
					) : null}
					{selectedCount > 0 &&
					groups
						.filter(
							(group) =>
								selectedGroups[group.workspaceIdentity] &&
								canReassignLegacyGroup(group) &&
								Boolean(selectedScopes[group.workspaceIdentity]),
						)
						.every((group) => pending[group.workspaceIdentity]) ? (
						<span className="legacy-review-cleanup-note">
							Bulk actions only preview. Confirm each project individually to avoid partial
							reassignment.
						</span>
					) : null}
				</div>
			</div>
			{groups.length > 0 ? (
				<ul className="legacy-review-groups" aria-label="Legacy shared review project groups">
					{visibleGroups.map((group) => (
						<li className="legacy-review-group" key={group.workspaceIdentity}>
							<div className="legacy-review-group-main">
								<div className="legacy-review-title-wrap">
									<input
										aria-label={`Select ${displayProjectTitle(group)}`}
										checked={Boolean(selectedGroups[group.workspaceIdentity])}
										className="cm-checkbox"
										disabled={!canReassignLegacyGroup(group)}
										onChange={(event) => toggleGroup(group, event.currentTarget.checked)}
										type="checkbox"
									/>
									<div>
										<div className="legacy-review-group-title">{displayProjectTitle(group)}</div>
										<div className="legacy-review-group-meta">
											{formatIdentitySource(group.identitySource)}
											{suggestedScopeText(group, targetScopes)}
										</div>
										{!canReassignLegacyGroup(group) ? (
											<div className="legacy-review-cleanup-note">
												Peer-owned only. These older memories were received from another device, so
												this device cannot reassign them to a Space. Assign this project to a Space
												on the source device; after sync, this review should clear here.
											</div>
										) : group.peerOwnedMemoryCount ? (
											<div className="legacy-review-cleanup-note">
												{(group.reassignableMemoryCount ?? group.memoryCount).toLocaleString()}{" "}
												local memor
												{(group.reassignableMemoryCount ?? group.memoryCount) === 1 ? "y" : "ies"}{" "}
												can be reassigned; {group.peerOwnedMemoryCount.toLocaleString()} peer-owned
												memor
												{group.peerOwnedMemoryCount === 1 ? "y" : "ies"} will stay in review.
											</div>
										) : null}
										{needsProjectCleanup(group) ? (
											<div className="legacy-review-cleanup-note">
												Inspect or correct the project identity before assigning old shared data to
												a Space.
											</div>
										) : null}
									</div>
								</div>
								<span className="legacy-review-count">
									{group.memoryCount.toLocaleString()} memor{group.memoryCount === 1 ? "y" : "ies"}
								</span>
							</div>
							{group.suggestionReason ? (
								<div className="legacy-review-reason">{group.suggestionReason}</div>
							) : null}
							{errors[group.workspaceIdentity] ? (
								<div className="legacy-review-confirmation" role="alert">
									{errors[group.workspaceIdentity]}
								</div>
							) : null}
							{pending[group.workspaceIdentity] ? (
								<div className="legacy-review-confirmation" role="alert">
									{pending[group.workspaceIdentity].warning} This will reassign{" "}
									{pending[group.workspaceIdentity].reassignable_memory_count.toLocaleString()} of{" "}
									{pending[group.workspaceIdentity].memory_count.toLocaleString()} memories
									{pending[group.workspaceIdentity].skipped_memory_count
										? `; ${pending[group.workspaceIdentity].skipped_memory_count.toLocaleString()} peer-owned copies will be left unchanged`
										: ""}
									.
								</div>
							) : null}
							<LegacyMemorySamples group={group} />
							{targetScopes.length > 0 && onReassign && canReassignLegacyGroup(group) ? (
								<label className="legacy-review-target">
									<span>Destination Space</span>
									<select
										className="peer-scope-input"
										disabled={busyIdentity != null}
										onChange={(event) => updateSelectedScope(group, event.currentTarget.value)}
										value={selectedScopes[group.workspaceIdentity] || ""}
									>
										<option value="">Choose Space…</option>
										{targetScopes.map((scope) => (
											<option key={scope.scopeId} value={scope.scopeId}>
												{scope.label} · {authorityLabel(scope.authorityType)}
												{scope.scopeId === group.suggestedScopeId ? " · suggested" : ""}
											</option>
										))}
									</select>
								</label>
							) : null}
							{targetScopes.length > 0 && onReassign && canReassignLegacyGroup(group) ? (
								<div className="legacy-review-actions">
									<button
										type="button"
										className="settings-button"
										disabled={busyIdentity != null || !selectedScopes[group.workspaceIdentity]}
										onClick={() => void applyGroup(group)}
									>
										{busyIdentity === group.workspaceIdentity
											? pending[group.workspaceIdentity]
												? "Reassigning…"
												: "Previewing…"
											: pending[group.workspaceIdentity]
												? "I understand, reassign memories"
												: "Preview reassignment"}
									</button>
								</div>
							) : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function SyncSharingReview({
	items,
	legacyReview,
	onLegacyReassign,
	onLegacyReview,
	onReview,
}: SyncSharingReviewProps) {
	return (
		<>
			{legacyReview ? (
				<LegacySharedReviewRow
					item={legacyReview}
					onReassign={onLegacyReassign}
					onReview={onLegacyReview ?? onReview}
				/>
			) : null}
			{items.map((item) => (
				<SharingReviewRow
					key={`${item.peerName}:${item.actorId}:${item.scopeLabel}`}
					item={item}
					onReview={onReview}
				/>
			))}
		</>
	);
}
