import type { ObserverApplyPayload } from "../data/form-state";

type Tier = NonNullable<NonNullable<ObserverApplyPayload["active"]>["simple"]>;

function tierLabel(tier: Tier | undefined): string {
	if (!tier) return "Not available";
	const effort = tier.reasoningEffort ? ` · ${tier.reasoningEffort} reasoning` : "";
	return `${tier.provider} / ${tier.model}${effort}`;
}

function ActiveRouting({ active }: { active: NonNullable<ObserverApplyPayload["active"]> }) {
	return (
		<section className="settings-note" aria-label="Active observer model routing">
			<div>
				Running: {active.provider} / {active.model} via {active.runtime}
			</div>
			{active.tierRoutingEnabled ? (
				<>
					<div>Simple: {tierLabel(active.simple)}</div>
					<div>Rich: {tierLabel(active.rich)}</div>
				</>
			) : (
				<div>Simple/rich routing is off.</div>
			)}
			<div>
				Listed models may be unavailable to the active account; check the result after an observer
				request.
			</div>
		</section>
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
