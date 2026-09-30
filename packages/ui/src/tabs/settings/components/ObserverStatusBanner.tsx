import { formatAuthMethod, formatCredentialSources, formatFailureTimestamp } from "../data/format";

export type ObserverStatusShape = {
	capture_enabled?: boolean | null;
	active?: {
		provider?: string;
		model?: string;
		auth?: {
			method?: string;
			token_present?: boolean;
		};
	} | null;
	available_credentials?: Record<string, Record<string, boolean>>;
	latest_failure?: {
		error_message?: string;
		observer_provider?: string;
		observer_model?: string;
		observer_runtime?: string;
		updated_at?: string;
		attempt_count?: number;
		impact?: string;
	} | null;
	queue?: {
		pending?: number;
	};
};

type ObserverDiagnosticsActionProps = {
	onOpenDiagnostics?: (options: { severity: "error"; subsystem: "observer" }) => void;
};

type ObserverStatusBannerProps = ObserverDiagnosticsActionProps & {
	status: ObserverStatusShape | null;
};

function ObserverDiagnosticsAction({ onOpenDiagnostics }: ObserverDiagnosticsActionProps) {
	if (!onOpenDiagnostics) return null;
	return (
		<button
			className="settings-button"
			onClick={() => onOpenDiagnostics({ severity: "error", subsystem: "observer" })}
			type="button"
		>
			View observer diagnostics
		</button>
	);
}

function CredentialDetails({ status }: { status: ObserverStatusShape }) {
	const credentialEntries = Object.entries(status.available_credentials || {}).filter(
		([, creds]) => creds && typeof creds === "object",
	);
	if (!credentialEntries.length) return null;
	const method = status.active?.auth?.method;
	const isLocalSession = method === "claude_sidecar" || method === "codex_sidecar";

	return (
		<details className="status-credentials">
			<summary>Direct API credentials</summary>
			<div className="small">
				{isLocalSession
					? "Local sessions use their CLI login; these credentials are only for Direct API mode."
					: "Credentials found for Direct API mode. A listed credential does not guarantee model access."}
			</div>
			<ul>
				{credentialEntries.map(([provider, creds]) => (
					<li key={provider}>
						{String(provider)}: {formatCredentialSources(creds)}
					</li>
				))}
			</ul>
		</details>
	);
}

function ProcessingIssue({
	failure,
	onOpenDiagnostics,
}: {
	failure: NonNullable<ObserverStatusShape["latest_failure"]>;
} & ObserverDiagnosticsActionProps) {
	return (
		<div className="status-issue">
			<div className="status-label">Latest processing issue</div>
			<div className="status-issue-message">
				{typeof failure.error_message === "string" && failure.error_message.trim()
					? failure.error_message.trim()
					: "Raw-event processing failed."}
			</div>
			<div className="status-issue-meta">
				{[
					[
						typeof failure.observer_provider === "string" ? failure.observer_provider.trim() : "",
						typeof failure.observer_model === "string" && failure.observer_model.trim()
							? `→ ${failure.observer_model.trim()}`
							: "",
						typeof failure.observer_runtime === "string" && failure.observer_runtime.trim()
							? `(${failure.observer_runtime.trim()})`
							: "",
					]
						.filter(Boolean)
						.join(" ")
						.replace(/\s+/g, " ")
						.trim(),
					`Last failure ${formatFailureTimestamp(failure.updated_at)}`,
					typeof failure.attempt_count === "number" && Number.isFinite(failure.attempt_count)
						? `Attempts ${failure.attempt_count}`
						: "",
				]
					.filter(Boolean)
					.join(" · ")}
			</div>
			{typeof failure.impact === "string" && failure.impact.trim() ? (
				<div className="status-issue-impact">{failure.impact.trim()}</div>
			) : null}
			<ObserverDiagnosticsAction onOpenDiagnostics={onOpenDiagnostics} />
		</div>
	);
}

export function ObserverStatusBanner({ status, onOpenDiagnostics }: ObserverStatusBannerProps) {
	if (!status) {
		return <div id="observerStatusBanner" className="observer-status-banner" hidden />;
	}

	const active = status.active;
	return (
		<div id="observerStatusBanner" className="observer-status-banner">
			{status.latest_failure ? (
				<ProcessingIssue failure={status.latest_failure} onOpenDiagnostics={onOpenDiagnostics} />
			) : null}
			<div className="status-active">
				<span className="status-label">Current connection</span>
				<span>
					{active ? (
						<>
							{String(active.provider || "unknown")}
							{active.model ? ` · ${String(active.model)}` : ""} ·{" "}
							{formatAuthMethod(active.auth?.method || "none")}
						</>
					) : (
						"Waiting for the first session"
					)}
				</span>
			</div>
			<CredentialDetails status={status} />
		</div>
	);
}
