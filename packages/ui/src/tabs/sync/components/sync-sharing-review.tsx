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
	suggestedScopeId: string | null;
	suggestionReason: string | null;
	workspaceIdentity: string;
}

type SyncSharingReviewProps = {
	items: SyncSharingReviewItem[];
	legacyReview?: SyncLegacySharedReviewItem | null;
	onLegacyReassign?: (
		group: SyncLegacySharedReviewGroup,
		scopeId: string,
		confirmedOldCopies: boolean,
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

function groupSearchText(group: SyncLegacySharedReviewGroup): string {
	return [
		group.displayProject,
		group.identitySource,
		group.suggestedScopeId ?? "",
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
	) => Promise<LegacySharedReviewReassignmentPreview | null>;
	onReview: () => void;
}) {
	const groups = item.groups ?? [];
	const targetScopes = item.targetScopes ?? [];
	const firstTargetScopeId = targetScopes[0]?.scopeId ?? null;
	const initialSelections = Object.fromEntries(
		groups.map((group) => [
			group.workspaceIdentity,
			group.suggestedScopeId ?? firstTargetScopeId ?? "",
		]),
	);
	const [pending, setPending] = useState<Record<string, LegacySharedReviewReassignmentPreview>>({});
	const [selectedScopes, setSelectedScopes] = useState<Record<string, string>>(initialSelections);
	const [selectedGroups, setSelectedGroups] = useState<Record<string, boolean>>({});
	const [filter, setFilter] = useState("all");
	const [query, setQuery] = useState("");
	const [busyIdentity, setBusyIdentity] = useState<string | null>(null);
	const shownGroupCount = groups.length;
	const groupCount = item.totalGroupCount ?? shownGroupCount;
	const cleanupCount = groups.filter(needsProjectCleanup).length;
	const suggestedCount = groups.filter(
		(group) => group.suggestedScopeId && !needsProjectCleanup(group),
	).length;
	const selectedCount = groups.filter((group) => selectedGroups[group.workspaceIdentity]).length;
	const visibleGroups = groups.filter((group) => {
		const cleanup = needsProjectCleanup(group);
		if (filter === "suggested" && (!group.suggestedScopeId || cleanup)) return false;
		if (filter === "cleanup" && !cleanup) return false;
		if (filter === "no-suggestion" && (group.suggestedScopeId || cleanup)) return false;
		if (filter === "selected" && !selectedGroups[group.workspaceIdentity]) return false;
		return !query.trim() || groupSearchText(group).includes(query.trim().toLowerCase());
	});
	async function applyGroup(group: SyncLegacySharedReviewGroup) {
		const selectedScopeId = selectedScopes[group.workspaceIdentity] || group.suggestedScopeId || "";
		if (!selectedScopeId || !onReassign || busyIdentity) return;
		setBusyIdentity(group.workspaceIdentity);
		try {
			const preview = await onReassign(
				group,
				selectedScopeId,
				Boolean(pending[group.workspaceIdentity]),
			);
			if (preview) setPending((current) => ({ ...current, [group.workspaceIdentity]: preview }));
			else {
				setPending((current) => {
					const next = { ...current };
					delete next[group.workspaceIdentity];
					return next;
				});
			}
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
	}
	function toggleGroup(group: SyncLegacySharedReviewGroup, checked: boolean) {
		setSelectedGroups((current) => ({ ...current, [group.workspaceIdentity]: checked }));
	}
	function setVisibleSelected(checked: boolean) {
		setSelectedGroups((current) => ({
			...current,
			...Object.fromEntries(visibleGroups.map((group) => [group.workspaceIdentity, checked])),
		}));
	}
	function selectSuggestedGroups() {
		setSelectedGroups((current) => ({
			...current,
			...Object.fromEntries(
				groups
					.filter((group) => group.suggestedScopeId && !needsProjectCleanup(group))
					.map((group) => [group.workspaceIdentity, true]),
			),
		}));
	}
	async function applySelectedGroups() {
		if (!onReassign || busyIdentity || selectedCount === 0) return;
		const selected = groups.filter((group) => selectedGroups[group.workspaceIdentity]);
		const allPreviewed = selected.every((group) => pending[group.workspaceIdentity]);
		setBusyIdentity("bulk");
		try {
			for (const group of selected) {
				const selectedScopeId =
					selectedScopes[group.workspaceIdentity] || group.suggestedScopeId || "";
				if (!selectedScopeId) continue;
				const preview = await onReassign(group, selectedScopeId, allPreviewed);
				if (preview) {
					setPending((current) => ({ ...current, [group.workspaceIdentity]: preview }));
				} else if (allPreviewed) {
					setPending((current) => {
						const next = { ...current };
						delete next[group.workspaceIdentity];
						return next;
					});
					setSelectedGroups((current) => ({ ...current, [group.workspaceIdentity]: false }));
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
						{groupCount === 1 ? "project needs" : "projects need"} a Sharing domain. They contain{" "}
						{item.memoryCount.toLocaleString()} older shared memories total; review the projects,
						not individual memories.
						{shownGroupCount < groupCount
							? ` Showing the first ${shownGroupCount.toLocaleString()} projects by memory count.`
							: ""}
					</div>
					<div className="peer-meta legacy-review-warning">
						Nothing moves automatically. Reassignment changes future sync authorization; it does not
						erase copies peers already received.
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
							disabled={busyIdentity != null || selectedCount === 0}
							onClick={() => void applySelectedGroups()}
							type="button"
						>
							{busyIdentity === "bulk"
								? "Working…"
								: selectedCount > 0 &&
										groups
											.filter((group) => selectedGroups[group.workspaceIdentity])
											.every((group) => pending[group.workspaceIdentity])
									? `Apply ${selectedCount.toLocaleString()} selected`
									: `Preview ${selectedCount.toLocaleString()} selected`}
						</button>
					) : onReassign && selectedCount > 0 ? (
						<span className="legacy-review-cleanup-note">
							Add or join a Sharing domain before bulk reassignment.
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
										aria-label={`Select ${group.displayProject}`}
										checked={Boolean(selectedGroups[group.workspaceIdentity])}
										className="cm-checkbox"
										onChange={(event) => toggleGroup(group, event.currentTarget.checked)}
										type="checkbox"
									/>
									<div>
										<div className="legacy-review-group-title">{group.displayProject}</div>
										<div className="legacy-review-group-meta">
											{formatIdentitySource(group.identitySource)}
											{group.suggestedScopeId ? ` · suggested ${group.suggestedScopeId}` : ""}
										</div>
										{needsProjectCleanup(group) ? (
											<div className="legacy-review-cleanup-note">
												Unclear project identity. Inspect or correct the project before trusting a
												domain.
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
							{targetScopes.length > 0 && onReassign ? (
								<label className="legacy-review-target">
									<span>Destination Sharing domain</span>
									<select
										className="peer-scope-input"
										disabled={busyIdentity != null}
										onChange={(event) => updateSelectedScope(group, event.currentTarget.value)}
										value={selectedScopes[group.workspaceIdentity] || group.suggestedScopeId || ""}
									>
										{targetScopes.map((scope) => (
											<option key={scope.scopeId} value={scope.scopeId}>
												{scope.label} · {scope.authorityType}
												{scope.scopeId === group.suggestedScopeId ? " · suggested" : ""}
											</option>
										))}
									</select>
								</label>
							) : null}
							{targetScopes.length > 0 && onReassign ? (
								<div className="legacy-review-actions">
									<button
										type="button"
										className="settings-button"
										disabled={busyIdentity != null}
										onClick={() => void applyGroup(group)}
									>
										{busyIdentity === group.workspaceIdentity
											? "Reassigning…"
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
