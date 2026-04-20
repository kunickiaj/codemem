import { formatAuthMethod, formatCredentialSources, formatFailureTimestamp } from "../data/format";

export type ObserverStatusShape = {
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
};

export function ObserverStatusBanner({ status }: { status: ObserverStatusShape | null }) {
	if (!status) {
		return <div id="observerStatusBanner" className="observer-status-banner" hidden />;
	}

	const active = status.active;
	const available = status.available_credentials || {};
	const failure = status.latest_failure;
	const credentialEntries = Object.entries(available).filter(
		([, creds]) => creds && typeof creds === "object",
	);

	return (
		<div id="observerStatusBanner" className="observer-status-banner">
			{active ? (
				<>
					<div className="status-label">Active observer</div>
					<div className="status-active">
						{String(active.provider || "unknown")} → {String(active.model || "")} via{" "}
						{formatAuthMethod(active.auth?.method || "none")}{" "}
						<span
							aria-label={active.auth?.token_present === true ? "token present" : "token missing"}
							className={active.auth?.token_present === true ? "cred-ok" : "cred-none"}
							role="img"
						>
							<i
								aria-hidden="true"
								data-lucide={active.auth?.token_present === true ? "check" : "x"}
							/>
						</span>
					</div>
				</>
			) : (
				<>
					<div className="status-label">Observer status</div>
					<div className="status-active">Not yet initialized (waiting for first session)</div>
				</>
			)}

			{credentialEntries.length ? (
				<>
					<div className="status-label">Available credentials</div>
					<div>
						{credentialEntries.map(([provider, creds], index) => {
							const normalizedCreds = creds as Record<string, boolean>;
							const hasAny = Object.values(normalizedCreds).some(Boolean);
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
									{String(provider)}: {formatCredentialSources(normalizedCreds)}
								</span>
							);
						})}
					</div>
				</>
			) : null}

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
					</div>
				</>
			) : null}
		</div>
	);
}
