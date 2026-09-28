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

function credentialIndicator(active: ObserverStatusShape["active"]) {
	if (["codex_sidecar", "claude_sidecar"].includes(active?.auth?.method ?? "")) {
		return { label: "CLI login checked on use", className: "cred-unknown", icon: "terminal" };
	}
	if (active?.auth?.token_present === true) {
		return { label: "token present", className: "cred-ok", icon: "check" };
	}
	return { label: "token missing", className: "cred-none", icon: "x" };
}

function AvailableCredentials({
	available,
}: {
	available: ObserverStatusShape["available_credentials"];
}) {
	const entries = Object.entries(available ?? {}).filter(
		([, creds]) => creds && typeof creds === "object",
	);
	if (!entries.length) return null;
	return (
		<>
			<div className="status-label">Available credentials</div>
			<div className="small">
				Direct API and legacy cache only; OpenCode V2 accounts are separate.
			</div>
			<div>
				{entries.map(([provider, creds], index) => {
					const hasAny = Object.values(creds).some(Boolean);
					return (
						<span key={provider} className="status-cred">
							{index > 0 ? " · " : null}
							<span
								aria-label={hasAny ? "credential available" : "no credential"}
								className={hasAny ? "cred-ok" : "cred-none"}
								role="img"
							>
								{hasAny ? <i aria-hidden="true" data-lucide="check" /> : "–"}
							</span>{" "}
							{provider}: {formatCredentialSources(creds)}
						</span>
					);
				})}
			</div>
		</>
	);
}

export function ObserverStatusBanner({ status, onOpenDiagnostics }: ObserverStatusBannerProps) {
	if (!status) {
		return <div id="observerStatusBanner" className="observer-status-banner" hidden />;
	}

	const active = status.active;
	const credential = credentialIndicator(active);
	const failure = status.latest_failure;

	return (
		<div id="observerStatusBanner" className="observer-status-banner">
			{active ? (
				<>
					<div className="status-label">Active observer</div>
					<div className="status-active">
						{String(active.provider || "unknown")} → {String(active.model || "")} via{" "}
						{formatAuthMethod(active.auth?.method || "none")}{" "}
						<span aria-label={credential.label} className={credential.className} role="img">
							<i aria-hidden="true" data-lucide={credential.icon} />
						</span>
					</div>
				</>
			) : (
				<>
					<div className="status-label">Observer status</div>
					<div className="status-active">Not yet initialized (waiting for first session)</div>
				</>
			)}

			<AvailableCredentials available={status.available_credentials} />

			{failure && typeof failure === "object" ? (
				<>
					<div className="status-label">Latest processing issue</div>
					<div className="status-issue">
						<div className="status-issue-message">
							{typeof failure.error_message === "string" && failure.error_message.trim()
								? failure.error_message.trim()
								: "Raw-event processing failed."}
						</div>
						<div className="status-issue-meta">
							{[
								[
									typeof failure.observer_provider === "string"
										? failure.observer_provider.trim()
										: "",
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
				</>
			) : null}
		</div>
	);
}
