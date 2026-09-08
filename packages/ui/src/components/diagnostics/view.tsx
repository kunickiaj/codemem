import {
	DIAGNOSTIC_SEVERITIES,
	DIAGNOSTIC_SUBSYSTEMS,
	type DiagnosticEvent,
	type DiagnosticEventSeverity,
	type DiagnosticEventSubsystem,
	type DiagnosticRecoveryHref,
	isDiagnosticRecoveryHref,
} from "../../lib/api/diagnostics";
import { DialogCloseButton } from "../primitives/dialog-close-button";
import { RadixDialog, RadixDialogTitle } from "../primitives/radix-dialog";
import { MAX_ROWS } from "./state";
import type { useDiagnosticsDrawer } from "./use-diagnostics-drawer";

type DrawerController = ReturnType<typeof useDiagnosticsDrawer>;

function severityPresentation(severity: DiagnosticEventSeverity) {
	if (severity === "error") return { icon: "×", label: "Error" };
	if (severity === "warning") return { icon: "!", label: "Warning" };
	return { icon: "i", label: "Info" };
}

function DiagnosticsEventRow({
	event,
	includeTechnical,
	onRecoveryNavigation,
}: {
	event: DiagnosticEvent;
	includeTechnical: boolean;
	onRecoveryNavigation: (href: DiagnosticRecoveryHref) => void;
}) {
	const severity = severityPresentation(event.severity);
	const recoveryHref = event.recovery?.href;
	return (
		<li className={`diagnostics-event diagnostics-event--${event.severity}`}>
			<div className="diagnostics-event-heading">
				<span className="diagnostics-severity">
					<span aria-hidden="true" className="diagnostics-severity-icon">
						{severity.icon}
					</span>
					{severity.label}
				</span>
				<time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString()}</time>
			</div>
			<div className="diagnostics-event-context">
				<span>{event.subsystem}</span>
				<code>{event.code}</code>
			</div>
			<p>{event.message}</p>
			{event.correlation ? (
				<div className="diagnostics-event-meta">
					{event.correlation.kind}: {event.correlation.label}
				</div>
			) : null}
			{includeTechnical && event.technical_detail?.text ? (
				<details className="diagnostics-technical-detail">
					<summary>Technical detail</summary>
					<pre>{event.technical_detail.text}</pre>
				</details>
			) : null}
			{isDiagnosticRecoveryHref(recoveryHref) ? (
				<a
					className="diagnostics-recovery"
					href={recoveryHref}
					onClick={(event) => {
						event.preventDefault();
						onRecoveryNavigation(recoveryHref);
					}}
				>
					{event.recovery?.label}
				</a>
			) : null}
			{event.recovery?.command ? (
				<div className="diagnostics-recovery-command">
					<span>{event.recovery.label}</span>
					<code>{event.recovery.command}</code>
				</div>
			) : null}
		</li>
	);
}

function LoadingRows() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading diagnostics"
			className="diagnostics-loading"
			role="status"
		>
			{["first", "second", "third"].map((row) => (
				<div className="diagnostics-loading-row" key={row}>
					<span />
					<span />
					<span />
				</div>
			))}
		</div>
	);
}

function DrawerControls({ controller }: { controller: DrawerController }) {
	const { state } = controller;
	return (
		<>
			<div className="diagnostics-controls">
				<label>
					<span>Severity</span>
					<select
						aria-label="Diagnostic severity"
						onChange={(event) =>
							controller.setSeverity(event.currentTarget.value as DiagnosticEventSeverity | "")
						}
						value={state.severity}
					>
						<option value="">All severities</option>
						{DIAGNOSTIC_SEVERITIES.map((value) => (
							<option key={value} value={value}>
								{severityPresentation(value).label}
							</option>
						))}
					</select>
				</label>
				<label>
					<span>Subsystem</span>
					<select
						aria-label="Diagnostic subsystem"
						onChange={(event) =>
							controller.setSubsystem(event.currentTarget.value as DiagnosticEventSubsystem | "")
						}
						value={state.subsystem}
					>
						<option value="">All subsystems</option>
						{DIAGNOSTIC_SUBSYSTEMS.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				</label>
				<button className="settings-button" onClick={controller.togglePaused} type="button">
					{state.paused ? "Resume updates" : "Pause updates"}
				</button>
			</div>
			<div className="diagnostics-secondary-controls">
				<button
					className="settings-button"
					disabled={state.includeTechnical || state.loading}
					onClick={controller.revealTechnical}
					type="button"
				>
					{state.includeTechnical ? "Technical details shown" : "Reveal technical details"}
				</button>
				<span className="diagnostics-generated-at">
					{state.generatedAt
						? `Generated ${new Date(state.generatedAt).toLocaleTimeString()}`
						: "Not loaded yet"}
				</span>
			</div>
		</>
	);
}

function DrawerNotices({ controller }: { controller: DrawerController }) {
	const { state } = controller;
	const staleLabel = state.error && state.rows.length ? "Showing stale events." : "";
	return (
		<>
			<div aria-atomic="true" aria-live="polite" className="sr-only">
				{state.announcement}
			</div>
			{state.subsystem || state.severity ? (
				<div className="diagnostics-filter-context">
					Showing{" "}
					{state.severity ? `${severityPresentation(state.severity).label.toLowerCase()} ` : ""}
					{state.subsystem ? `${state.subsystem} ` : ""}events from the recent retained window.
				</div>
			) : null}
			{state.paused ? (
				<div className="diagnostics-notice" role="status">
					Updates are paused. Resume when you are ready to fetch newer events.
				</div>
			) : null}
			{state.error ? (
				<div className="diagnostics-notice diagnostics-notice--error" role="alert">
					<span>Diagnostics could not be refreshed. {staleLabel}</span>
					<button className="settings-button" onClick={() => void controller.retry()} type="button">
						Retry
					</button>
				</div>
			) : null}
			{state.queuedRows.length ? (
				<button className="diagnostics-new-events" onClick={controller.showQueued} type="button">
					Show {state.queuedRows.length} new {state.queuedRows.length === 1 ? "event" : "events"}
				</button>
			) : null}
		</>
	);
}

function DrawerEventList({ controller }: { controller: DrawerController }) {
	const { state } = controller;
	const hasFilters = Boolean(state.severity || state.subsystem);
	const canLoadOlder = Boolean(state.nextCursor) && state.rows.length < MAX_ROWS && !state.loading;
	return (
		<div className="diagnostics-event-list" ref={controller.listRef}>
			{state.loading && !state.rows.length ? <LoadingRows /> : null}
			{!state.loading && !state.error && !state.rows.length ? (
				<div className="diagnostics-empty">
					<p>No events match the recent retained window.</p>
					{hasFilters ? (
						<button className="settings-button" onClick={controller.resetFilters} type="button">
							Reset filters
						</button>
					) : null}
				</div>
			) : null}
			{state.rows.length ? (
				<ul aria-label="Diagnostic events">
					{state.rows.map((event) => (
						<DiagnosticsEventRow
							event={event}
							includeTechnical={state.includeTechnical}
							key={event.id}
							onRecoveryNavigation={controller.navigateToRecovery}
						/>
					))}
				</ul>
			) : null}
			{canLoadOlder ? (
				<button
					className="settings-button diagnostics-load-older"
					onClick={() => void controller.loadOlder()}
					type="button"
				>
					Load older
				</button>
			) : null}
			{state.rows.length >= MAX_ROWS ? (
				<div className="diagnostics-limit-note">Showing the newest {MAX_ROWS} events.</div>
			) : null}
		</div>
	);
}

export function DiagnosticsDrawerView({ controller }: { controller: DrawerController }) {
	return (
		<RadixDialog
			ariaDescribedby="diagnosticsDrawerDescription"
			ariaLabelledby="diagnosticsDrawerTitle"
			contentClassName="diagnostics-drawer"
			contentId="diagnosticsDrawer"
			onCloseAutoFocus={controller.restoreFocus}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				document.getElementById("diagnosticsDrawerTitle")?.focus();
			}}
			onOpenChange={(open) => {
				if (!open) controller.close();
			}}
			open={controller.state.open}
			overlayClassName="diagnostics-drawer-overlay"
			overlayId="diagnosticsDrawerOverlay"
		>
			<header className="diagnostics-drawer-header">
				<div>
					<RadixDialogTitle id="diagnosticsDrawerTitle" tabIndex={-1}>
						Diagnostics
					</RadixDialogTitle>
					<p id="diagnosticsDrawerDescription">
						Recent redacted operational events. Filters apply only to this drawer.
					</p>
				</div>
				<DialogCloseButton ariaLabel="Close diagnostics" onClick={controller.close} />
			</header>
			<DrawerControls controller={controller} />
			<DrawerNotices controller={controller} />
			<DrawerEventList controller={controller} />
		</RadixDialog>
	);
}
