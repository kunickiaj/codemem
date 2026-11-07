import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeviceIdentityInventoryV1, loadSyncStatus } from "../lib/api/sync";
import {
	DeviceEnrollmentIssues,
	type DeviceEnrollmentIssuesProps,
} from "./device-enrollment-issues";

vi.mock("../lib/api/sync", () => ({ loadSyncStatus: vi.fn() }));

let root: HTMLDivElement;
const loadStatus = vi.mocked(loadSyncStatus);
type Issue = {
	kind: "device" | "team_membership";
	reference_id: string;
	code: string;
	status: "open" | "resolved";
};

function issue(overrides: Partial<Issue> = {}): Issue {
	return {
		kind: "device",
		reference_id: "device-1",
		code: "enrollment_invalid",
		status: "open",
		...overrides,
	};
}

function payload(
	issues: Issue[] = [issue()],
	open = issues.filter((item) => item.status === "open").length,
) {
	return { coordinator_enrollment_reconciliation_issues: { counts: { open }, issues } };
}

function respond(value: unknown) {
	loadStatus.mockResolvedValueOnce(value as Awaited<ReturnType<typeof loadSyncStatus>>);
}

function inventory(
	entries: Array<{ name: string; ids: string[]; deviceId?: string }>,
): DeviceIdentityInventoryV1 {
	return {
		version: 1,
		items: entries.map((entry, index) => ({
			version: 1,
			deviceId: entry.deviceId ?? `inventory-${index}`,
			evidenceDeviceIds: entry.ids,
			displayName: entry.name,
			state: "conflicted",
			identityId: null,
			suggestedIdentityId: "suggested-owner",
			validatedFingerprint: null,
			isLocal: false,
			sources: ["coordinator_enrollment"],
			conflictCodes: [],
		})),
		coordinatorEvidence: { availability: "available", safeErrorCode: null },
		truncated: false,
	};
}

function mount(props: DeviceEnrollmentIssuesProps = {}) {
	act(() => render(<DeviceEnrollmentIssues {...props} />, root));
}

function button(label: string): HTMLButtonElement {
	const match = Array.from(root.querySelectorAll("button")).find(
		(item) => item.textContent === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function click(label = "View setup issues") {
	await act(async () => button(label).click());
}

beforeEach(() => {
	loadStatus.mockReset();
	root = document.createElement("div");
	document.body.append(root);
});

afterEach(() => {
	act(() => render(null, root));
	root.remove();
});

describe("DeviceEnrollmentIssues", () => {
	it("requests detailed status only after the user opens issues", async () => {
		// Arrange: mounting and prop updates must not fetch details or assign ownership.
		respond(payload());
		const onNavigate = vi.fn();
		mount({ onNavigate });
		expect(loadStatus).not.toHaveBeenCalled();
		expect(root.querySelector("li")).toBeNull();
		mount({ inventory: inventory([{ name: "Laptop", ids: ["device-1"] }]), onNavigate });
		expect(loadStatus).not.toHaveBeenCalled();
		// Act
		await click();
		// Assert
		expect(loadStatus).toHaveBeenCalledExactlyOnceWith(true);
		expect(root.textContent).toContain("Laptop");
		expect(button("Refresh setup issues").disabled).toBe(false);
		expect(onNavigate).not.toHaveBeenCalled();
		expect(Array.from(root.querySelectorAll("button"), (item) => item.textContent)).toEqual([
			"Refresh setup issues",
			"Open sync diagnostics",
		]);
		expect(root.querySelector("select, input, form")).toBeNull();
	});

	it("announces loading and disables repeated requests while a request is pending", async () => {
		// Arrange
		let resolve!: (value: Awaited<ReturnType<typeof loadSyncStatus>>) => void;
		loadStatus.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mount();
		// Act
		await click();
		await click();
		// Assert
		expect(button("View setup issues").disabled).toBe(true);
		expect(root.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
		expect(root.querySelector('[role="status"]')?.textContent).toBe("Loading setup issues…");
		expect(loadStatus).toHaveBeenCalledTimes(1);
		await act(async () => resolve(payload() as Awaited<ReturnType<typeof loadSyncStatus>>));
		expect(root.querySelector("section")?.getAttribute("aria-busy")).toBe("false");
		expect(button("Refresh setup issues").disabled).toBe(false);
	});

	it("shows open records only and reports truncated counts using open records", async () => {
		// Arrange
		respond(payload([issue(), issue({ reference_id: "resolved-secret", status: "resolved" })], 8));
		mount();
		// Act
		await click();
		// Assert
		expect(root.querySelectorAll("li")).toHaveLength(1);
		expect(root.textContent).toContain("Showing 1 of 8 open issues");
		expect(root.textContent).not.toContain("resolved-secret");
	});
});

describe("DeviceEnrollmentIssues labels and counts", () => {
	it.each([0, 1])(
		"does not claim truncation when all %i open records are present",
		async (count) => {
			// Arrange
			respond(payload(Array.from({ length: count }, () => issue())));
			mount({ onNavigate: vi.fn() });
			// Act
			await click();
			// Assert
			expect(root.textContent).not.toContain("Showing");
			expect(root.querySelectorAll("li")).toHaveLength(count);
			if (count === 0) {
				expect(root.querySelector('[role="status"]')?.textContent).toBe("No open setup issues.");
				expect(root.textContent).not.toContain("Open sync diagnostics");
			}
		},
	);

	it.each([
		{
			label: "exact evidence ID",
			entries: [{ name: "Known laptop", ids: ["device-1"] }],
			expected: "Known laptop",
		},
		{
			label: "ambiguous evidence",
			entries: [
				{ name: "First", ids: ["device-1"] },
				{ name: "Second", ids: ["device-1"] },
			],
			expected: "Device name unavailable",
		},
		{
			label: "device ID without evidence",
			entries: [{ name: "Guessed", ids: [], deviceId: "device-1" }],
			expected: "Device name unavailable",
		},
		{
			label: "partial evidence ID",
			entries: [{ name: "Partial", ids: ["device-10"] }],
			expected: "Device name unavailable",
		},
		{
			label: "blank name",
			entries: [{ name: "  ", ids: ["device-1"] }],
			expected: "Device name unavailable",
		},
		{ label: "unknown device", entries: [], expected: "Device name unavailable" },
	])("uses truthful device names for $label", async ({ entries, expected }) => {
		// Arrange
		respond(payload());
		mount({ inventory: inventory(entries) });
		// Act
		await click();
		// Assert
		expect(root.querySelector("li strong")?.textContent).toBe(expected);
	});

	it("labels membership references as Team invitations even if a device shares the reference", async () => {
		// Arrange
		respond(payload([issue({ kind: "team_membership", code: "team_invite_invalid" })]));
		mount({ inventory: inventory([{ name: "Unrelated laptop", ids: ["device-1"] }]) });
		// Act
		await click();
		// Assert
		expect(root.querySelector("li strong")?.textContent).toBe("Team invitation");
		expect(root.textContent).not.toContain("Unrelated laptop");
	});
});

describe("DeviceEnrollmentIssues guidance", () => {
	it.each(["future_issue_code", "constructor", "toString", "__proto__"])(
		"uses the generic reason for unknown code %s",
		async (code) => {
			// Arrange: server-provided codes must not resolve inherited object properties.
			respond(payload([issue({ code })]));
			mount();
			// Act
			await click();
			// Assert
			expect(root.querySelector("li p")?.textContent).toBe("Enrollment issue");
			expect(root.textContent).toContain(
				"Ask a coordinator administrator to review the error code and reference ID below.",
			);
		},
	);

	it.each([
		[
			"enrollment_invalid",
			"Invalid device enrollment",
			"Ask a coordinator administrator to check the device enrollment's status, group, and IDs.",
		],
		[
			"identity_not_active",
			"Identity unavailable",
			"Review the assigned Identity and confirm that the coordinator uses the same active Identity.",
		],
		[
			"device_identity_conflict",
			"Device ownership conflict",
			"Compare the device's current Identity with its coordinator enrollment before reassigning the device.",
		],
		[
			"device_trust_conflict",
			"Device key or ownership conflict",
			"Compare the enrolled device key and owner with the paired device before updating trust.",
		],
		[
			"team_invite_invalid",
			"Invalid Team invitation",
			"Ask a coordinator administrator to check the Team invitation's status, group, and IDs.",
		],
		[
			"policy_team_not_active",
			"Team unavailable",
			"Confirm that the invitation names an active Team.",
		],
		[
			"membership_not_active",
			"Team membership conflict",
			"Review the existing Team membership before accepting the invitation.",
		],
	])("explains %s with a reason and next action", async (code, reason, guidance) => {
		// Arrange
		respond(payload([issue({ code })]));
		mount();
		// Act
		await click();
		// Assert
		expect(root.textContent).toContain(reason);
		expect(root.textContent).toContain(guidance);
		expect(Array.from(root.querySelectorAll("button"), (item) => item.textContent)).toEqual([
			"Refresh setup issues",
		]);
	});

	it("uses a truthful fallback for unknown codes and exposes escaped technical details", async () => {
		// Arrange: untrusted codes, references, and names must remain text.
		const code = '<img src=x onerror="alert(1)">';
		const reference = '<script>alert("reference")</script>';
		const name = '<svg onload="alert(2)">';
		respond(payload([issue({ code, reference_id: reference })]));
		mount({ inventory: inventory([{ name, ids: [reference] }]) });
		// Act
		await click();
		const details = root.querySelector("details");
		act(() => root.querySelector("summary")?.click());
		// Assert
		expect(root.querySelector("li p")?.textContent).toBe("Enrollment issue");
		expect(root.textContent).toContain(
			"Ask a coordinator administrator to review the error code and reference ID below.",
		);
		expect(root.querySelector("strong")?.textContent).toBe(name);
		expect(details?.open).toBe(true);
		expect(root.querySelector("summary")?.textContent).toBe("Technical details");
		expect(Array.from(root.querySelectorAll("dt"), (item) => item.textContent)).toEqual([
			"Error code",
			"Reference ID",
		]);
		expect(Array.from(root.querySelectorAll("dd code"), (item) => item.textContent)).toEqual([
			code,
			reference,
		]);
		expect(root.querySelector("img, script, svg")).toBeNull();
	});
});

describe("DeviceEnrollmentIssues recovery", () => {
	it.each([
		null,
		{},
		{ coordinator_enrollment_reconciliation_issues: [] },
		{ coordinator_enrollment_reconciliation_issues: { counts: {}, issues: [] } },
		...[-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1"].map(
			(open) => ({
				coordinator_enrollment_reconciliation_issues: { counts: { open }, issues: [] },
			}),
		),
		{ coordinator_enrollment_reconciliation_issues: { counts: { open: 1 }, issues: {} } },
		...[
			null,
			[],
			{},
			issue({ kind: "unknown" as Issue["kind"] }),
			issue({ status: "pending" as Issue["status"] }),
			{ ...issue(), code: 42 },
			{ ...issue(), reference_id: 42 },
		].map((invalid) => ({
			coordinator_enrollment_reconciliation_issues: {
				counts: { open: 1 },
				issues: [issue(), invalid],
			},
		})),
	])("offers retry without partial data for malformed response %#", async (invalid) => {
		// Arrange
		respond(invalid);
		mount();
		// Act
		await click();
		// Assert
		expect(root.querySelector('[role="alert"]')?.textContent).toBe(
			"Could not load setup issues. Retry loading the details.",
		);
		expect(button("Retry loading setup issues").disabled).toBe(false);
		expect(root.querySelector("li")).toBeNull();
		expect(root.textContent).not.toContain("No open setup issues");
	});

	it("hides raw API errors and recovers when retry succeeds", async () => {
		// Arrange
		loadStatus.mockRejectedValueOnce(new Error("private API failure with credential detail"));
		respond(payload());
		mount();
		// Act
		await click();
		// Assert
		expect(root.querySelector('[role="alert"]')).not.toBeNull();
		expect(root.textContent).not.toContain("private API failure");
		// Act: an explicit retry replaces the failure with current data.
		await click("Retry loading setup issues");
		// Assert
		expect(root.querySelector('[role="alert"]')).toBeNull();
		expect(root.querySelectorAll("li")).toHaveLength(1);
		expect(loadStatus.mock.calls).toEqual([[true], [true]]);
	});

	it("hides old issues and diagnostics during refresh and after a failed refresh", async () => {
		// Arrange
		respond(payload([issue({ reference_id: "old-reference" })]));
		let reject!: (reason: Error) => void;
		loadStatus.mockReturnValueOnce(
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
		);
		respond(payload([], 0));
		mount({ onNavigate: vi.fn() });
		await click();
		expect(root.textContent).toContain("old-reference");
		// Act
		await click("Refresh setup issues");
		// Assert
		expect(root.textContent).not.toContain("old-reference");
		expect(root.textContent).not.toContain("Open sync diagnostics");
		// Act
		await act(async () => reject(new Error("private refresh failure")));
		// Assert
		expect(root.textContent).not.toContain("old-reference");
		expect(root.textContent).not.toContain("private refresh failure");
		expect(root.textContent).not.toContain("Open sync diagnostics");
		// Act
		await click("Retry loading setup issues");
		// Assert
		expect(root.textContent).toContain("No open setup issues.");
		expect(root.querySelector('[role="alert"]')).toBeNull();
	});

	it("navigates to diagnostics only on explicit click without another status request", async () => {
		// Arrange
		const onNavigate = vi.fn();
		respond(payload());
		mount({ onNavigate });
		await click();
		expect(onNavigate).not.toHaveBeenCalled();
		// Act
		await click("Open sync diagnostics");
		// Assert
		expect(onNavigate).toHaveBeenCalledExactlyOnceWith("advanced_sync");
		expect(loadStatus).toHaveBeenCalledTimes(1);
	});
});
