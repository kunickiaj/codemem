import type { ObserverApplyPayload } from "../data/form-state";

type Tier = NonNullable<NonNullable<ObserverApplyPayload["active"]>["simple"]>;

function tierLabel(tier: Tier | undefined): string {
	if (!tier) return "Not available";
	const effort = tier.reasoningEffort ? ` · ${tier.reasoningEffort} reasoning` : "";
	return `${tier.provider} · ${tier.model}${effort}`;
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
