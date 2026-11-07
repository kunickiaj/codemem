import { useState } from "preact/hooks";
import { type DeviceIdentityInventoryV1, loadSyncStatus } from "../lib/api/sync";

export interface DeviceEnrollmentIssuesProps {
	inventory?: DeviceIdentityInventoryV1;
	onNavigate?: (target: "advanced_sync") => void;
}

interface EnrollmentIssue {
	kind: "device" | "team_membership";
	reference_id: string;
	code: string;
	status: "open" | "resolved";
}

interface EnrollmentIssueSummary {
	open: number;
	issues: EnrollmentIssue[];
}

const ISSUE_GUIDANCE = new Map<string, string>([
	[
		"enrollment_invalid",
		"Ask a coordinator administrator to check the device enrollment's status, group, and IDs.",
	],
	[
		"identity_not_active",
		"Review the assigned Identity and confirm that the coordinator uses the same active Identity.",
	],
	[
		"device_identity_conflict",
		"Compare the device's current Identity with its coordinator enrollment before reassigning the device.",
	],
	[
		"device_trust_conflict",
		"Compare the enrolled device key and owner with the paired device before updating trust.",
	],
	[
		"team_invite_invalid",
		"Ask a coordinator administrator to check the Team invitation's status, group, and IDs.",
	],
	["policy_team_not_active", "Confirm that the invitation names an active Team."],
	["membership_not_active", "Review the existing Team membership before accepting the invitation."],
]);

const ISSUE_REASONS = new Map<string, string>([
	["enrollment_invalid", "Invalid device enrollment"],
	["identity_not_active", "Identity unavailable"],
	["device_identity_conflict", "Device ownership conflict"],
	["device_trust_conflict", "Device key or ownership conflict"],
	["team_invite_invalid", "Invalid Team invitation"],
	["policy_team_not_active", "Team unavailable"],
	["membership_not_active", "Team membership conflict"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEnrollmentIssue(value: unknown): value is EnrollmentIssue {
	return (
		isRecord(value) &&
		(value.kind === "device" || value.kind === "team_membership") &&
		typeof value.reference_id === "string" &&
		typeof value.code === "string" &&
		(value.status === "open" || value.status === "resolved")
	);
}

function readEnrollmentIssues(payload: unknown): EnrollmentIssueSummary {
	const summary = isRecord(payload) ? payload.coordinator_enrollment_reconciliation_issues : null;
	if (
		!isRecord(summary) ||
		!isRecord(summary.counts) ||
		typeof summary.counts.open !== "number" ||
		!Number.isSafeInteger(summary.counts.open) ||
		summary.counts.open < 0 ||
		!Array.isArray(summary.issues) ||
		!summary.issues.every(isEnrollmentIssue)
	) {
		throw new Error("Enrollment issue details unavailable");
	}
	return {
		open: summary.counts.open,
		issues: summary.issues
			.filter((issue) => issue.status === "open")
			.map((issue) => ({
				kind: issue.kind,
				reference_id: issue.reference_id,
				code: issue.code,
				status: issue.status,
			})),
	};
}

function issueLabel(issue: EnrollmentIssue, inventory?: DeviceIdentityInventoryV1): string {
	// Team membership references identify invitations, not devices.
	if (issue.kind === "team_membership") return "Team invitation";
	const matches = inventory?.items.filter((item) =>
		item.evidenceDeviceIds.includes(issue.reference_id),
	);
	if (matches?.length === 1 && matches[0]?.displayName.trim()) return matches[0].displayName;
	return "Device name unavailable";
}

function EnrollmentIssueList({
	summary,
	inventory,
}: {
	summary: EnrollmentIssueSummary;
	inventory?: DeviceIdentityInventoryV1;
}) {
	if (summary.open === 0)
		return (
			<p class="small" role="status">
				No open setup issues.
			</p>
		);
	return (
		<div>
			{summary.open > summary.issues.length && (
				<p class="small">
					Showing {summary.issues.length} of {summary.open} open issues
				</p>
			)}
			<ul class="small">
				{summary.issues.map((issue, index) => (
					<li key={`${issue.kind}:${issue.reference_id}:${issue.code}:${index}`}>
						<strong>{issueLabel(issue, inventory)}</strong>
						<p>{ISSUE_REASONS.get(issue.code) ?? "Enrollment issue"}</p>
						<p>
							{ISSUE_GUIDANCE.get(issue.code) ??
								"Ask a coordinator administrator to review the error code and reference ID below."}
						</p>
						<details>
							<summary>Technical details</summary>
							<dl>
								<dt>Error code</dt>
								<dd>
									<code>{issue.code}</code>
								</dd>
								<dt>Reference ID</dt>
								<dd>
									<code>{issue.reference_id}</code>
								</dd>
							</dl>
						</details>
					</li>
				))}
			</ul>
		</div>
	);
}

export function DeviceEnrollmentIssues({ inventory, onNavigate }: DeviceEnrollmentIssuesProps) {
	const [summary, setSummary] = useState<EnrollmentIssueSummary | null>(null);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	async function loadIssues() {
		if (loading) return;
		setLoading(true);
		setFailed(false);
		try {
			setSummary(readEnrollmentIssues(await loadSyncStatus(true)));
		} catch {
			setFailed(true);
		} finally {
			setLoading(false);
		}
	}
	let buttonLabel = "View setup issues";
	if (failed) buttonLabel = "Retry loading setup issues";
	else if (summary) buttonLabel = "Refresh setup issues";
	return (
		<section
			className="device-enrollment-issues"
			aria-label="Coordinator setup issue details"
			aria-busy={loading}
		>
			<button type="button" class="settings-button" disabled={loading} onClick={loadIssues}>
				{buttonLabel}
			</button>
			{loading && (
				<p class="small" role="status">
					Loading setup issues…
				</p>
			)}
			{failed && (
				<p class="small" role="alert">
					Could not load setup issues. Retry loading the details.
				</p>
			)}
			{summary && !loading && !failed && (
				<EnrollmentIssueList summary={summary} inventory={inventory} />
			)}
			{summary && !loading && !failed && summary.open > 0 && onNavigate && (
				<button type="button" class="settings-button" onClick={() => onNavigate("advanced_sync")}>
					Open sync diagnostics
				</button>
			)}
		</section>
	);
}
