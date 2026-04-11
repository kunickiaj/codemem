import { isSummaryLikeMemory } from "./summary-memory.js";

export type DerivedMemoryRole = "recap" | "durable" | "ephemeral" | "general";

export interface DerivedMemoryRoleResult {
	role: DerivedMemoryRole;
	reason: string;
}

export interface InferMemoryRoleInput {
	kind: string;
	title: string;
	body_text: string;
	metadata?: Record<string, unknown> | null;
	project?: string | null;
	session_minutes?: number | null;
}

function classifyProjectQuality(project: unknown): "normal" | "empty" | "garbage_like" | "unknown" {
	if (project === undefined) return "unknown";
	const value = typeof project === "string" ? project.trim() : "";
	if (!value) return "empty";
	if (value === "T" || value === "adam" || value === "opencode" || value.startsWith("fatal:")) {
		return "garbage_like";
	}
	return "normal";
}

function hasAnyMarker(text: string, markers: string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

function inferMicroSession(
	sessionMinutes: number | null | undefined,
	metadata: Record<string, unknown>,
): boolean {
	if (typeof sessionMinutes === "number") return sessionMinutes < 1;
	const sessionClass = String(metadata.session_class ?? "")
		.trim()
		.toLowerCase();
	return ["trivial_turn", "micro_low_value", "micro_high_signal"].includes(sessionClass);
}

export function inferMemoryRole(input: InferMemoryRoleInput): DerivedMemoryRoleResult {
	const metadata = input.metadata ?? {};
	const isSummary = isSummaryLikeMemory({ kind: input.kind, metadata });
	if (isSummary) {
		return {
			role: "recap",
			reason: input.kind === "session_summary" ? "session_summary_kind" : "legacy_summary_metadata",
		};
	}

	const text = `${input.title} ${input.body_text}`.toLowerCase();
	const projectQuality = classifyProjectQuality(input.project);
	const microSession = inferMicroSession(input.session_minutes, metadata);
	const nonNormalProject = projectQuality === "empty" || projectQuality === "garbage_like";
	const hasTaskMarkers = hasAnyMarker(text, [
		"task:",
		"todo",
		"need to",
		"next step",
		"follow up",
		"continue ",
	]);
	const hasRecapMarkers = hasAnyMarker(text, [
		"## request",
		"## completed",
		"## learned",
		"user asked",
		"the session",
		"the goal was",
	]);
	const hasInvestigativeMarkers = hasAnyMarker(text, [
		"identified",
		"discovered",
		"confirm",
		"confirmed",
		"verified",
		"investigate",
		"investigated",
		"determine whether",
		"clarified",
		"resolved",
	]);

	if (["decision", "bugfix", "discovery", "exploration"].includes(input.kind)) {
		if (nonNormalProject)
			return { role: "general", reason: "durable_kind_with_non_normal_project" };
		if (hasTaskMarkers && !hasInvestigativeMarkers) {
			return { role: "ephemeral", reason: "durable_kind_task_markers_without_resolution" };
		}
		return { role: "durable", reason: "durable_kind" };
	}

	if (["feature", "refactor"].includes(input.kind)) {
		if (hasRecapMarkers) return { role: "recap", reason: "implementation_kind_with_recap_markers" };
		if (microSession && hasTaskMarkers) {
			return { role: "ephemeral", reason: "micro_session_implementation_task" };
		}
		return { role: "durable", reason: "implementation_kind" };
	}

	if (input.kind === "change") {
		if (hasRecapMarkers) {
			return { role: "recap", reason: "change_with_recap_markers" };
		}
		if (microSession) return { role: "ephemeral", reason: "micro_session_change" };
		if (nonNormalProject) return { role: "general", reason: "change_with_non_normal_project" };
		if (hasInvestigativeMarkers && !hasTaskMarkers) {
			return { role: "durable", reason: "change_with_investigative_markers" };
		}
		return { role: "ephemeral", reason: "default_change_ephemeral" };
	}

	return nonNormalProject
		? { role: "general", reason: "fallback_non_normal_project" }
		: { role: "ephemeral", reason: "fallback_ephemeral" };
}
