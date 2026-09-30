import { formatAuthMethod, formatCredentialSources, formatFailureTimestamp } from "../data/format";

export type ObserverStatusShape = {
	capture_enabled?: boolean | null;
	active?: {
		provider?: string;
		model?: string;
		runtime?: string;
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

function AvailableCredentials({
	available,
	method,
}: {
	available: ObserverStatusShape["available_credentials"];
	method: string | undefined;
}) {
	const entries = Object.entries(available ?? {}).filter(
		([, creds]) => creds && typeof creds === "object",
	);
	if (
		!entries.length ||
		["codex_sidecar", "claude_sidecar", "opencode_v2"].includes(method ?? "")
	) {
		return null;
	}
	return (
		<details className="status-credentials">
			<summary>API keys and saved sign-ins</summary>
			<ul>
				{entries.map(([provider, creds]) => (
					<li key={provider}>
						{provider}: {formatCredentialSources(creds)}
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
	const missingApiKey =
		active?.auth?.token_present === false &&
		(active.runtime === "api_key" || active.auth.method === "none");
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
			{missingApiKey ? (
				<div className="status-token-warning">
					No Direct API key detected. Check your credentials.
				</div>
			) : null}
			<AvailableCredentials
				available={status.available_credentials}
				method={active?.auth?.method}
			/>
		</div>
	);
}
