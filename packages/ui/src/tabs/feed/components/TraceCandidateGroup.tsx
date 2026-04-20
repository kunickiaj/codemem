import { h } from "preact";
import type * as api from "../../../lib/api";

export function TraceCandidateGroup({
	label,
	candidates,
}: {
	label: string;
	candidates: api.PackTraceCandidate[];
}) {
	if (candidates.length === 0) return null;
	return h(
		"div",
		{ className: "trace-group" },
		h("div", { className: "section-meta" }, label),
		h(
			"div",
			{ className: "feed-list" },
			candidates.map((candidate) =>
				h(
					"div",
					{ className: "feed-card", key: `${label}:${candidate.id}` },
					h("div", { className: "feed-card-header" }, [
						h("div", { className: "feed-card-title" }, `${candidate.rank}. ${candidate.title}`),
						h(
							"div",
							{ className: "feed-card-meta" },
							`#${candidate.id} · ${candidate.kind}${candidate.section ? ` · ${candidate.section}` : ""}`,
						),
					]),
					h("div", { className: "feed-card-body" }, [
						h("div", null, candidate.preview || "No preview available."),
						candidate.reasons.length
							? h("div", { className: "section-meta" }, `Reasons: ${candidate.reasons.join(", ")}`)
							: null,
					]),
				),
			),
		),
	);
}
