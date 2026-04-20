/* Context inspector panel — trace a pack query against the memory store
 * and display candidate groupings + the final assembled pack. */

import { Fragment, h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../../lib/api";
import { state } from "../../lib/state";
import { TraceCandidateGroup } from "./trace";

export function syncInspectorQueryDraft(options: {
	feedQuery: string;
	inspectorQuery: string;
	hasInspectorOverride: boolean;
}): string {
	return options.hasInspectorOverride ? options.inspectorQuery : options.feedQuery;
}

export function parseInspectorWorkingSet(value: string): string[] {
	return value
		.split(/\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function packTraceContextKey(options: {
	project: string | null;
	query: string;
	workingSetFiles: string[];
}): string {
	return JSON.stringify([options.project, options.query.trim(), options.workingSetFiles]);
}

export function ContextInspectorPanel({ open }: { open: boolean }) {
	const [inspectorQuery, setInspectorQuery] = useState(() => String(state.feedQuery || ""));
	const [hasSeededInspectorQuery, setHasSeededInspectorQuery] = useState(false);
	const [hasInspectorOverride, setHasInspectorOverride] = useState(false);
	const [workingSetText, setWorkingSetText] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [errorContextKey, setErrorContextKey] = useState("");
	const [trace, setTrace] = useState<api.PackTrace | null>(null);
	const latestTraceRequestId = useRef(0);
	const feedQuery = String(state.feedQuery || "");
	const currentQuery = String(inspectorQuery || "").trim();
	const currentProject = state.currentProject || null;
	const currentWorkingSetFiles = parseInspectorWorkingSet(workingSetText);
	const currentContextKey = packTraceContextKey({
		project: currentProject,
		query: currentQuery,
		workingSetFiles: currentWorkingSetFiles,
	});
	const visibleTrace =
		trace &&
		packTraceContextKey({
			project: trace.inputs.project,
			query: trace.inputs.query,
			workingSetFiles: trace.inputs.working_set_files,
		}) === currentContextKey
			? trace
			: null;
	const visibleError = error && errorContextKey === currentContextKey ? error : "";

	useEffect(() => {
		latestTraceRequestId.current += 1;
		setLoading(false);
		setError("");
		setErrorContextKey("");
		setTrace((currentTrace) => {
			if (!currentTrace) return null;
			if (
				currentTrace.inputs.query !== currentQuery ||
				currentTrace.inputs.project !== currentProject
			) {
				return null;
			}
			return currentTrace;
		});
	}, [currentContextKey]);

	useEffect(() => {
		if (open && !hasSeededInspectorQuery) {
			setInspectorQuery(
				syncInspectorQueryDraft({
					feedQuery,
					hasInspectorOverride,
					inspectorQuery,
				}),
			);
			setHasSeededInspectorQuery(true);
		}
	}, [feedQuery, hasInspectorOverride, hasSeededInspectorQuery, inspectorQuery, open]);

	const runTrace = async () => {
		const context = currentQuery;
		const project = currentProject;
		const workingSetFiles = currentWorkingSetFiles;
		const contextKey = packTraceContextKey({ project, query: context, workingSetFiles });
		const requestId = latestTraceRequestId.current + 1;
		latestTraceRequestId.current = requestId;
		if (!context) {
			setError("Enter a query to inspect.");
			setErrorContextKey(contextKey);
			setTrace(null);
			return;
		}
		setLoading(true);
		setError("");
		setErrorContextKey("");
		try {
			const nextTrace = await api.tracePack({
				context,
				project,
				working_set_files: workingSetFiles,
			});
			if (requestId !== latestTraceRequestId.current) {
				return;
			}
			setTrace(nextTrace);
		} catch (err) {
			if (requestId !== latestTraceRequestId.current) {
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
			setErrorContextKey(contextKey);
			setTrace(null);
		} finally {
			if (requestId === latestTraceRequestId.current) {
				setLoading(false);
			}
		}
	};

	const selected =
		visibleTrace?.retrieval.candidates.filter(
			(candidate) => candidate.disposition === "selected",
		) || [];
	const dropped =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "dropped") ||
		[];
	const deduped =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "deduped") ||
		[];
	const trimmed =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "trimmed") ||
		[];

	return open
		? h(
				"div",
				{ className: "feed-inspector" },
				h(
					"div",
					{ className: "feed-card", id: "contextInspectorPanel", style: "margin-top:12px;" },
					[
						h("div", { className: "feed-card-header" }, [
							h("div", { className: "feed-card-title" }, "Context Inspector"),
							h(
								"div",
								{ className: "feed-card-meta" },
								hasInspectorOverride
									? "Tracing an inspector-specific query"
									: "Seeded from the feed search on first open",
							),
						]),
						h("div", { className: "feed-card-body" }, [
							h("input", {
								className: "feed-search",
								onInput: (event) => {
									setInspectorQuery(String((event.currentTarget as HTMLInputElement).value || ""));
									setHasInspectorOverride(true);
									setTrace(null);
									setError("");
									setErrorContextKey("");
								},
								placeholder: "Trace a pack query…",
								value: inspectorQuery,
							}),
							h(
								"div",
								{ className: "section-meta", style: "margin-top:8px;" },
								hasInspectorOverride
									? "Inspector query is independent from the live feed search."
									: "Inspector query was seeded from the feed search and will stay independent until you change it.",
							),
							h("textarea", {
								className: "feed-inspector-files",
								onInput: (event) =>
									setWorkingSetText(
										String((event.currentTarget as HTMLTextAreaElement).value || ""),
									),
								placeholder: "Optional working-set files, one per line",
								rows: 3,
								value: workingSetText,
							}),
							h(
								"div",
								{ style: "display:flex; gap:8px; margin-top:8px; align-items:center;" },
								h(
									"button",
									{
										className: "toggle-button active",
										disabled: loading,
										onClick: () => void runTrace(),
										type: "button",
									},
									loading ? "Tracing…" : "Run trace",
								),
								visibleTrace
									? h(
											"span",
											{ className: "section-meta" },
											`mode=${visibleTrace.mode.selected} · candidates=${visibleTrace.retrieval.candidate_count} · tokens=${visibleTrace.output.estimated_tokens}`,
										)
									: null,
							),
							trace && !visibleTrace
								? h(
										"div",
										{ className: "section-meta", style: "margin-top:8px;" },
										"Trace inputs changed. Run trace again for the current query, project, and working set.",
									)
								: null,
							visibleError
								? h(
										"div",
										{ className: "section-meta", style: "margin-top:8px; color:#d96c6c;" },
										visibleError,
									)
								: null,
						]),
						visibleTrace
							? h(Fragment, null, [
									h(TraceCandidateGroup, { label: "Selected", candidates: selected }),
									h(TraceCandidateGroup, { label: "Dropped", candidates: dropped }),
									h(TraceCandidateGroup, { label: "Deduped", candidates: deduped }),
									h(TraceCandidateGroup, { label: "Trimmed", candidates: trimmed }),
									h("div", { className: "feed-card-body" }, [
										visibleTrace.assembly.collapsed_groups.length
											? h(
													"div",
													{ className: "section-meta" },
													`Collapsed duplicates: ${visibleTrace.assembly.collapsed_groups
														.map(
															(group) => `kept #${group.kept} from [${group.dropped.join(", ")}]`,
														)
														.join(" · ")}`,
												)
											: null,
										visibleTrace.assembly.trim_reasons.length
											? h(
													"div",
													{ className: "section-meta" },
													`Trim reasons: ${visibleTrace.assembly.trim_reasons.join(", ")}`,
												)
											: null,
										h("div", { className: "section-meta" }, "Final pack"),
										h(
											"pre",
											{ style: "white-space:pre-wrap; overflow:auto;" },
											visibleTrace.output.pack_text,
										),
									]),
								])
							: null,
					],
				),
			)
		: null;
}
