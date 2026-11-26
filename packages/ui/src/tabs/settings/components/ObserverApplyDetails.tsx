import type { ObserverApplyPayload, ObserverTierPreview } from "../data/form-state";

const FALLBACK_REASONS: Record<string, string> = {
	variant_not_listed: "model doesn't offer it",
	variants_unavailable: "model list unavailable",
	variant_rejected: "OpenCode rejected it",
};

/** The configured effort, then what the last request applied, or that it failed, when the connection reports it. */
function reasoningLabel(tier: ObserverTierPreview | undefined): string {
	if (!tier?.reasoningEffort) return "";
	const requested = ` · Requested reasoning: ${tier.reasoningEffort}`;
	const applied = tier.appliedReasoning;
	if (!applied) return requested;
	if (!applied.requestSucceeded) return `${requested} · Last request failed`;
	if (applied.effort) return `${requested} · Applied: ${applied.effort}`;
	const reason = applied.fallbackReason ? FALLBACK_REASONS[applied.fallbackReason] : undefined;
	return `${requested} · Applied: OpenCode default${reason ? ` (${reason})` : ""}`;
}

function tierLabel(tier: ObserverTierPreview | undefined): string {
	if (!tier) return "Not available";
	return `${tier.provider} · ${tier.model}${reasoningLabel(tier)}`;
}

function ActiveRouting({ active }: { active: NonNullable<ObserverApplyPayload["active"]> }) {
	return (
		<details className="settings-note observer-routing-details">
			<summary>Models in use</summary>
			{active.tierRoutingEnabled ? (
				<dl className="observer-routing-list">
					<div>
						<dt>Simple requests</dt>
						<dd>{tierLabel(active.simple)}</dd>
					</div>
					<div>
						<dt>Rich requests</dt>
						<dd>{tierLabel(active.rich)}</dd>
					</div>
				</dl>
			) : (
				<dl className="observer-routing-list">
					<div>
						<dt>All requests</dt>
						<dd>
							{active.provider} · {active.model}
							{reasoningLabel(active.simple)}
						</dd>
					</div>
				</dl>
			)}
		</details>
	);
}

export function ObserverApplyDetails({
	status,
	onRetry,
	onRefresh,
}: {
	status: ObserverApplyPayload | null;
	onRetry: () => void;
	onRefresh: () => void;
}) {
	if (!status) return null;
	return (
		<>
			{status.active ? <ActiveRouting active={status.active} /> : null}
			{status.state === "applying" ? (
				<div role="status">Applying observer settings. New events will wait.</div>
			) : null}
			{status.state === "failed" ? (
				<div role="alert">
					{status.message ?? "Observer settings were saved but are not active."}{" "}
					<button className="settings-button" onClick={onRetry} type="button">
						Retry applying observer settings
					</button>
				</div>
			) : null}
			{status.state !== "active" ? (
				<button className="settings-link-button" onClick={onRefresh} type="button">
					Check observer status
				</button>
			) : null}
		</>
	);
}
