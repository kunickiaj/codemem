import { useEffect, useMemo, useState } from "preact/hooks";
import { RadixSelect } from "../../../components/primitives/radix-select";
import * as api from "../../../lib/api";
import type {
	ProjectScopeCandidate,
	SharingDomainScope,
	SharingDomainSettings,
} from "../../../lib/api/sync";
import { showGlobalNotice } from "../../../lib/notice";

type Drafts = Record<string, string>;

function domainLabel(scope: SharingDomainScope): string {
	const qualifier = scope.authority_type === "local" ? "local" : scope.authority_type;
	return `${scope.label || scope.scope_id} · ${qualifier}`;
}

function projectSubtitle(project: ProjectScopeCandidate): string {
	if (project.git_remote) return `Matched by git remote · ${project.git_remote}`;
	if (project.cwd) return `Matched by path · ${project.cwd}`;
	return `Matched by ${project.identity_source} · ${project.workspace_identity}`;
}

function resolutionLabel(reason: string): string {
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

function scopeName(scopes: SharingDomainScope[], scopeId: string): string {
	return scopes.find((scope) => scope.scope_id === scopeId)?.label || scopeId;
}

function resetDrafts(settings: SharingDomainSettings): Drafts {
	return Object.fromEntries(
		settings.projects.map((project) => [project.workspace_identity, project.resolved_scope_id]),
	);
}

export function SharingDomainsPanel() {
	const [settings, setSettings] = useState<SharingDomainSettings | null>(null);
	const [drafts, setDrafts] = useState<Drafts>({});
	const [loading, setLoading] = useState(false);
	const [savingKey, setSavingKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = async () => {
		setLoading(true);
		setError(null);
		try {
			const next = await api.loadSharingDomainSettings();
			setSettings(next);
			setDrafts(resetDrafts(next));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unable to load Sharing domains");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void reload();
	}, []);

	const scopeOptions = useMemo(
		() =>
			(settings?.scopes ?? []).map((scope) => ({
				value: scope.scope_id,
				label: domainLabel(scope),
			})),
		[settings?.scopes],
	);

	const saveProject = async (project: ProjectScopeCandidate) => {
		const scopeId = drafts[project.workspace_identity] ?? project.resolved_scope_id;
		setSavingKey(project.workspace_identity);
		setError(null);
		try {
			await api.saveSharingDomainProjectMapping({
				workspace_identity: project.workspace_identity,
				project_pattern: project.display_project,
				scope_id: scopeId,
			});
			showGlobalNotice("Project Sharing domain updated. Device access grants are unchanged.");
			await reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unable to save Sharing domain mapping");
		} finally {
			setSavingKey(null);
		}
	};

	const resetProject = async (project: ProjectScopeCandidate) => {
		if (!project.mapping_id) return;
		setSavingKey(project.workspace_identity);
		setError(null);
		try {
			await api.deleteSharingDomainProjectMapping(project.mapping_id);
			showGlobalNotice("Project Sharing domain mapping removed. The next fallback now applies.");
			await reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unable to reset Sharing domain mapping");
		} finally {
			setSavingKey(null);
		}
	};

	return (
		<div className="settings-group">
			<h3 className="settings-group-title">Sharing domains</h3>
			<div className="small">
				Map known projects to their default Sharing domain. This changes local scope resolution for
				future writes; it does not grant any peer or coordinator member access by itself.
			</div>
			<div className="small">
				Unmapped and unknown projects stay on Local only until you assign a domain.
			</div>
			{loading && !settings ? <div className="small">Loading Sharing domains…</div> : null}
			{error ? <div className="settings-note">{error}</div> : null}
			{settings && settings.projects.length === 0 ? (
				<div className="small">No projects with memories are available yet.</div>
			) : null}
			{settings?.projects.map((project, index) => {
				const fieldId = `sharingDomainProject-${index}`;
				const currentValue = drafts[project.workspace_identity] ?? project.resolved_scope_id;
				const saving = savingKey === project.workspace_identity;
				const unchanged = currentValue === project.resolved_scope_id;
				const currentScopeName = scopeName(settings.scopes, project.resolved_scope_id);
				const canRemoveProjectMapping =
					project.mapping_id != null && project.resolution_reason === "exact_mapping";
				return (
					<div className="field" key={project.workspace_identity}>
						<label htmlFor={fieldId}>{project.display_project}</label>
						<div className="small">{projectSubtitle(project)}</div>
						<RadixSelect
							ariaLabel={`Sharing domain for ${project.display_project}`}
							contentClassName="settings-select-content"
							disabled={saving || scopeOptions.length === 0}
							id={fieldId}
							itemClassName="settings-select-item"
							onValueChange={(value) =>
								setDrafts((prev) => ({ ...prev, [project.workspace_identity]: value }))
							}
							options={scopeOptions}
							placeholder="Choose Sharing domain"
							triggerClassName="settings-select-trigger"
							value={currentValue}
							viewportClassName="settings-select-viewport"
						/>
						<div className="small">
							Current default: {currentScopeName} · {resolutionLabel(project.resolution_reason)}
						</div>
						<div className="section-actions">
							<button
								className="settings-button"
								disabled={saving || unchanged}
								onClick={() => void saveProject(project)}
								type="button"
							>
								{saving ? "Saving…" : "Save Sharing domain"}
							</button>
							<button
								className="settings-button"
								disabled={saving || !canRemoveProjectMapping}
								onClick={() => void resetProject(project)}
								type="button"
							>
								Remove project mapping
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}
