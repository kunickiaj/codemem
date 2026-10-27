import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountOwnerRecovery, type AccountOwnerRecoveryProps } from "./account-owner-recovery";
import type {
	RecoveryPreview,
	RecoveryPreviewRequest,
	RecoveryProfile,
} from "./account-owner-recovery-types";

// Inert component tests: fixtures represent adapter data, not verified server authority.
const profile: RecoveryProfile = {
	contextId: "context-c",
	memoryActorId: "author-c",
	deviceId: "device-c",
	fingerprint: "fingerprint-c",
	coordinatorOrigin: "https://coordinator.example",
	coordinatorId: "coordinator-one",
	configuredGroups: ["group-one", "group-two"],
};
let mount: HTMLDivElement;
let trigger: HTMLButtonElement;
let props: AccountOwnerRecoveryProps;

function draw(changes: Partial<AccountOwnerRecoveryProps> = {}) {
	props = { ...props, ...changes };
	act(() => render(<AccountOwnerRecovery {...props} />, mount));
}
function button(text: string): HTMLButtonElement {
	const found = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}
function input(label: string): HTMLInputElement {
	const found = [...document.querySelectorAll("label")].find((item) =>
		item.textContent?.includes(label),
	);
	const control = found?.querySelector("input") ?? document.getElementById(found?.htmlFor ?? "");
	if (!(control instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`);
	return control;
}
function textarea(label: string): HTMLTextAreaElement {
	const found = [...document.querySelectorAll("label")].find((item) => item.textContent === label);
	const control = document.getElementById(found?.htmlFor ?? "");
	if (!(control instanceof HTMLTextAreaElement)) throw new Error(`Missing textarea: ${label}`);
	return control;
}
function click(element: HTMLElement) {
	act(() => element.click());
}
function choose(owner = "owner-a") {
	const select = document.querySelector("select");
	if (!select) throw new Error("Missing owner select");
	act(() => {
		select.value = owner;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
function typeReply(value: string) {
	const field = textarea("Noncredential operator approval reply (JSON)");
	act(() => {
		field.value = value;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function request(): RecoveryPreviewRequest {
	click(button("Preview account ownership"));
	const calls = vi.mocked(props.onPreview).mock.calls;
	return calls[calls.length - 1][0];
}
function previewFor(requested: RecoveryPreviewRequest): RecoveryPreview {
	return {
		scope: "historical_included_owner_labels_only",
		profile: requested.profile,
		existingOwnerId: requested.existingOwnerId,
		groups: requested.groups,
		requestId: requested.requestId,
		approvalDigest: "approval-digest",
		groupPreviews: requested.groups.map((groupId) => ({
			groupId,
			action: "new",
			reason: "Review needed",
		})),
		history: {
			complete: true,
			rows: [
				{
					id: "row-one",
					groupId: "group-one",
					deviceId: "device-c",
					fingerprint: "fingerprint-c",
					identityId: "author-c",
					assignment: "included",
					relation: "exact_subject",
					reason: "Retained annotation",
				},
			],
		},
	};
}
function review(): RecoveryPreview {
	choose();
	const preview = previewFor(request());
	draw({ preview });
	return preview;
}
function acknowledge() {
	click(input("I reviewed these records and groups"));
}
function expectReadOnlyStatus() {
	expect(() => input("I reviewed these records and groups")).toThrow();
	expect(document.querySelector('[aria-label="Read-only review status"]')).not.toBeNull();
}

function deferredCopy<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	mount = document.createElement("div");
	trigger = document.createElement("button");
	trigger.textContent = "Open recovery";
	document.body.append(trigger, mount);
	trigger.focus();
	props = {
		open: true,
		profile,
		candidates: [
			{ id: "owner-a", label: "Owner A" },
			{ id: "owner-b", label: "Owner B" },
		],
		reviewAccess: "operator",
		preview: null,
		busy: false,
		returnFocus: { current: trigger },
		onClose: vi.fn(),
		onPreview: vi.fn(),
		onConfirm: vi.fn(),
	};
});
afterEach(async () => {
	await act(async () => render(null, mount));
	mount.remove();
	trigger.remove();
	vi.restoreAllMocks();
});

describe("ownership choices and read-only preview", () => {
	it("requires an explicit owner even with one candidate and starts with every group selected", () => {
		// Arrange
		draw({ candidates: [{ id: "owner-a", label: "Owner A" }] });
		// Act
		click(button("Preview account ownership"));
		// Assert
		expect(document.querySelector("select")?.value).toBe("");
		expect(input("group-one").checked).toBe(true);
		expect(input("group-two").checked).toBe(true);
		expect(props.onPreview).not.toHaveBeenCalled();
		expect(button("Confirm account ownership").disabled).toBe(true);
	});
	it("dispatches selected owner and groups with fresh review request IDs", () => {
		// Arrange
		draw();
		choose();
		// Act
		const first = request();
		click(input("group-two"));
		const second = request();
		// Assert
		expect(first).toMatchObject({
			profile,
			existingOwnerId: "owner-a",
			groups: profile.configuredGroups,
			purpose: "review",
		});
		expect(second.groups).toEqual(["group-one"]);
		expect(second.requestId).not.toBe(first.requestId);
		expect(props.onConfirm).not.toHaveBeenCalled();
	});
	it("rejects empty group scope and busy preview requests", () => {
		// Arrange
		draw();
		choose();
		// Act
		click(input("group-one"));
		click(input("group-two"));
		click(button("Preview account ownership"));
		draw({ busy: true });
		click(button("Preview account ownership"));
		// Assert
		expect(props.onPreview).not.toHaveBeenCalled();
		expect(document.querySelector("fieldset")?.disabled).toBe(true);
	});
	it("explains owner A versus unchanged author C, sharing and controller authority", () => {
		// Arrange
		draw();
		// Act
		review();
		// Assert
		expect(document.body.textContent).toContain("Selected account owner: owner-a");
		expect(document.body.textContent).toContain("group-one: Ready to confirm");
		expect(document.body.textContent).toContain(
			"Pick the Identity that is linked to your Google account",
		);
		expect(document.body.textContent).toContain("Memories keep their author, author-c");
		expect(document.body.textContent).toContain(
			"Team membership, Project access, and old records don't change",
		);
		expect(document.body.textContent).toContain(
			"future ownership checks, which can allow account changes",
		);
		expect(document.querySelector("a")).toBeNull();
	});
});

describe("approval is tied to the exact current review", () => {
	it("requires explicit acknowledgement and dispatches only once before parent busy updates", () => {
		// Arrange
		draw();
		const preview = review();
		click(button("Confirm account ownership"));
		expect(props.onConfirm).not.toHaveBeenCalled();
		acknowledge();
		// Act: two clicks in the same batch exercise the synchronous duplicate guard.
		const confirm = button("Confirm account ownership");
		act(() => {
			confirm.click();
			confirm.click();
		});
		// Assert
		expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith({
			preview,
			approvalDigest: "approval-digest",
		});
		expect(button("Confirm account ownership").disabled).toBe(true);
	});

	const mismatches: [string, (preview: RecoveryPreview) => RecoveryPreview][] = [
		["profile context", (p) => ({ ...p, profile: { ...profile, contextId: "other-context" } })],
		["device", (p) => ({ ...p, profile: { ...profile, deviceId: "other-device" } })],
		["fingerprint", (p) => ({ ...p, profile: { ...profile, fingerprint: "other-key" } })],
		[
			"coordinator",
			(p) => ({ ...p, profile: { ...profile, coordinatorOrigin: "https://other.example" } }),
		],
		["owner", (p) => ({ ...p, existingOwnerId: "owner-b" })],
		["group selection", (p) => ({ ...p, groups: ["group-one"] })],
		["request", (p) => ({ ...p, requestId: "stale-request" })],
		["duplicate scope", (p) => ({ ...p, groups: ["group-one", "group-one"] })],
		[
			"duplicate group previews",
			(p) => ({ ...p, groupPreviews: [p.groupPreviews[0], p.groupPreviews[0]] }),
		],
	];
	it.each(mismatches)("does not approve a mismatched %s", (_name, alter) => {
		// Arrange
		draw();
		choose();
		const preview = alter(previewFor(request()));
		// Act
		draw({ preview });
		click(button("Confirm account ownership"));
		// Assert
		expect(document.body.textContent).toContain("The preview is not current");
		expect(document.querySelector('[aria-label="Server ownership preview"]')).toBeNull();
		expect(props.onConfirm).not.toHaveBeenCalled();
	});

	it.each(["incomplete", "blocked", "no digest", "busy", "error", "request access"])(
		"cannot approve when %s",
		(condition) => {
			// Arrange
			draw();
			const preview = review();
			if (condition === "incomplete")
				preview.history = { complete: false, rows: [], operatorHelp: "Contact operator" };
			if (condition === "blocked")
				preview.groupPreviews = [
					{ ...preview.groupPreviews[0], action: "blocked" },
					preview.groupPreviews[1],
				];
			if (condition === "no digest") preview.approvalDigest = "";
			draw({
				preview,
				busy: condition === "busy",
				error: condition === "error" ? "Review failed" : null,
				reviewAccess: condition === "request access" ? "request" : "operator",
			});
			// Act
			if (condition !== "request access") acknowledge();
			click(button("Confirm account ownership"));
			// Assert
			expect(button("Confirm account ownership").disabled).toBe(true);
			expect(props.onConfirm).not.toHaveBeenCalled();
			if (condition === "incomplete")
				expect(document.querySelector('[role="alert"]')?.textContent).toContain(
					"We could not load all ownership records",
				);
		},
	);
});

describe("historical recovery scope and readable review labels", () => {
	it.each(["missing", "null", "controller_only"])(
		"rejects %s scope without presenting an ownership claim",
		(scope) => {
			// Arrange: model legacy or malformed runtime data without weakening the required DTO.
			draw();
			choose();
			const candidate: Record<string, unknown> = { ...previewFor(request()) };
			if (scope === "missing") delete candidate.scope;
			else candidate.scope = scope === "null" ? null : scope;
			// Act
			draw({ preview: candidate as unknown as RecoveryPreview });
			click(button("Confirm account ownership"));
			// Assert
			expect(button("Confirm account ownership").disabled).toBe(true);
			expect(props.onConfirm).not.toHaveBeenCalled();
			expect(document.body.textContent).toContain("The preview is not current");
			expect(document.querySelector('[aria-label="Server ownership preview"]')).toBeNull();
			expect(document.querySelector('[aria-label="Reported review outcomes"]')).toBeNull();
			expect(
				[...document.querySelectorAll("label")].some((label) =>
					label.textContent?.includes("I reviewed these records"),
				),
			).toBe(false);
		},
	);

	it("uses readable group and historical assignment labels without raw metadata enums", () => {
		// Arrange
		draw();
		choose();
		const preview = previewFor(request());
		preview.groupPreviews = [
			{
				groupId: "group-one",
				action: "reuse",
				reason: "Existing approval",
				metadata: { purpose: "account_owner_target", recoveryReceipt: "reused" },
			},
			{ groupId: "group-two", action: "blocked", reason: "Operator needed" },
		];
		const row = preview.history.rows[0];
		preview.history = {
			complete: true,
			rows: [
				row,
				{ ...row, id: "alias-row", relation: "alias", assignment: "excluded" },
				{ ...row, id: "other-row", relation: "other" },
			],
		};
		// Act
		draw({ preview });
		// Assert
		const text = document.querySelector('[aria-label="Server ownership preview"]')?.textContent;
		for (const label of [
			"Already confirmed",
			"Blocked",
			"Previously included",
			"Previously excluded",
			"This device",
			"Same device key",
			"Another recorded device",
		])
			expect(text).toContain(label);
		expect(text).not.toContain("account_owner_target");
		expect(text).not.toContain("exact_subject");
		expect(button("Confirm account ownership").disabled).toBe(true);
	});
});

describe("consent invalidation and retained history", () => {
	it.each([
		"owner round trip",
		"group round trip",
		"new preview",
		"new request",
		"context",
		"reopen",
	])("resets consent after %s", (change) => {
		// Arrange
		draw();
		const preview = review();
		acknowledge();
		expect(button("Confirm account ownership").disabled).toBe(false);
		// Act
		if (change === "owner round trip") {
			choose("owner-b");
			choose("owner-a");
		}
		if (change === "group round trip") {
			click(input("group-two"));
			click(input("group-two"));
		}
		if (change === "new preview") draw({ preview: { ...preview } });
		if (change === "new request") request();
		if (change === "context") draw({ profile: { ...profile, contextId: "context-new" } });
		if (change === "reopen") {
			draw({ open: false });
			draw({ open: true });
		}
		click(button("Confirm account ownership"));
		// Assert
		expect(button("Confirm account ownership").disabled).toBe(true);
		expect(props.onConfirm).not.toHaveBeenCalled();
		if (change === "context" || change === "reopen")
			expect(document.querySelector("select")?.value).toBe("");
	});

	it("ignores a late old preview after requesting a newer review", () => {
		// Arrange
		draw();
		const old = review();
		acknowledge();
		// Act
		const current = request();
		draw({ preview: old });
		click(button("Confirm account ownership"));
		// Assert
		expect(current.requestId).not.toBe(old.requestId);
		expect(props.onConfirm).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("The preview is not current");
	});

	it("renders every provided history row and escapes untrusted labels and reasons", () => {
		// Arrange
		const malicious = '<img src=x onerror="alert(1)">';
		draw({ candidates: [{ id: "owner-a", label: malicious }] });
		choose();
		const preview = previewFor(request());
		preview.history = {
			complete: true,
			rows: Array.from({ length: 125 }, (_, index) => ({
				...preview.history.rows[0],
				id: `row-${index}`,
				reason: `${malicious} row ${index}`,
			})),
		};
		// Act
		draw({ preview });
		acknowledge();
		// Assert
		expect(document.querySelectorAll("ol > li")).toHaveLength(125);
		expect(document.body.textContent).toContain(`${malicious} row 124`);
		expect(document.querySelector("option[value='owner-a']")?.textContent).toContain(malicious);
		expect(document.querySelector("img")).toBeNull();
		expect(button("Confirm account ownership").disabled).toBe(false);
	});
});

describe("reported outcomes and dialog access", () => {
	it("offers Close after sending approval and warns that closing does not undo it", () => {
		// Arrange
		draw();
		const preview = review();
		acknowledge();
		// Act
		click(button("Confirm account ownership"));
		draw({ busy: true });
		// Assert
		expect(
			[...document.querySelectorAll("button")].some((item) => item.textContent === "Cancel"),
		).toBe(false);
		expect(
			[...document.querySelectorAll('[role="status"]')].some((item) =>
				item.textContent?.includes("Closing does not undo an approval already sent"),
			),
		).toBe(true);
		expect(document.body.textContent).toContain(
			"If the result is unknown, check review status before retrying",
		);
		// Act
		click(button("Close"));
		click(button("Confirm account ownership"));
		// Assert: closing dispatches only a close intent, not cancellation or a second approval.
		expect(props.onClose).toHaveBeenCalledOnce();
		expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith({
			preview,
			approvalDigest: "approval-digest",
		});
		expect(props.onPreview).toHaveBeenCalledOnce();
	});

	it("checks partial and unknown outcomes without automatically reapplying approval", () => {
		// Arrange
		draw();
		const preview = review();
		acknowledge();
		draw({
			result: {
				preview,
				groups: [{ groupId: "group-one", status: "failed", message: "Try status first" }],
			},
		});
		// Act
		click(button("Confirm account ownership"));
		click(button("Check review status"));
		const checked = vi.mocked(props.onPreview).mock.calls.at(-1)?.[0];
		if (!checked) throw new Error("Missing status request");
		draw({ preview: previewFor(checked) });
		expectReadOnlyStatus();
		click(button("Confirm account ownership"));
		// Assert
		expect(document.body.textContent).toContain("group-one: failed");
		expect(document.body.textContent).toContain("group-two: unknown");
		expect(checked.purpose).toBe("check_status");
		expect(checked.requestId).not.toBe(preview.requestId);
		expect(props.onConfirm).not.toHaveBeenCalled();
		expect(
			document.querySelector('[aria-label="Reported review outcomes"]')?.getAttribute("aria-live"),
		).toBe("polite");
	});
	it("reports explicitly supplied confirmation but never treats a missing group as confirmed", () => {
		// Arrange
		draw();
		const preview = review();
		// Act
		draw({
			result: {
				preview,
				groups: [{ groupId: "group-one", status: "confirmed", message: "Server confirmed" }],
			},
		});
		// Assert
		expect(document.body.textContent).toContain("group-one: confirmed");
		expect(document.body.textContent).toContain("group-two: unknown");
		expect(button("Close").disabled).toBe(false);
		expect(props.onConfirm).not.toHaveBeenCalled();
	});
	it("uses labelled native controls, Cancel initial focus and restores the opener", async () => {
		// Arrange
		await act(async () => draw());
		// Act
		const dialog = document.querySelector('[role="dialog"]');
		// Assert
		expect(document.activeElement).toBe(button("Cancel"));
		expect(
			document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")?.textContent,
		).toBe("Review account ownership");
		expect(document.querySelector<HTMLLabelElement>("label[for]")?.htmlFor).toBe(
			document.querySelector("select")?.id,
		);
		expect([...document.querySelectorAll("legend")].map((item) => item.textContent)).toEqual([
			"Existing account owner",
			"Coordinator groups to review",
		]);
		// Act
		// Radix defers its unmount autofocus event with setTimeout(0).
		vi.useFakeTimers();
		click(button("Cancel"));
		draw({ open: false });
		await act(async () => {
			await vi.runOnlyPendingTimersAsync();
		});
		vi.useRealTimers();
		// Assert
		expect(props.onClose).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(trigger);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
	it.each(["Cancel", "Escape"])(
		"allows %s while pending without dispatching approval",
		async (dismiss) => {
			// Arrange
			await act(async () => draw({ busy: true, error: "Status unavailable. Try again." }));
			// Act
			if (dismiss === "Cancel") click(button("Cancel"));
			else
				act(() => {
					document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
				});
			// Assert
			expect(props.onClose).toHaveBeenCalledOnce();
			expect(props.onConfirm).not.toHaveBeenCalled();
			expect(document.querySelector('[role="alert"]')?.textContent).toBe(
				"Status unavailable. Try again.",
			);
			expect(
				[...document.querySelectorAll('[role="status"]')].some((item) =>
					item.textContent?.includes("Waiting for the coordinator to answer"),
				),
			).toBe(true);
		},
	);
});

describe("read-only status lookup keeps the submitted approval scope", () => {
	function submitOwnerA() {
		draw();
		const submitted = review();
		acknowledge();
		click(button("Confirm account ownership"));
		return submitted;
	}
	function expectStatusTarget(submitted: RecoveryPreview) {
		const lookup = vi.mocked(props.onPreview).mock.calls.at(-1)?.[0];
		expect(lookup).toEqual({
			profile: submitted.profile,
			existingOwnerId: submitted.existingOwnerId,
			groups: submitted.groups,
			purpose: "check_status",
			requestId: expect.any(String),
		});
		expect(lookup?.requestId).not.toBe(submitted.requestId);
		const ids = vi.mocked(props.onPreview).mock.calls.map(([args]) => args.requestId);
		expect(new Set(ids).size).toBe(ids.length);
		return lookup;
	}

	it("offers status lookup after an approval error without a result", () => {
		// Arrange
		const submitted = submitOwnerA();
		draw({ error: "The approval outcome is unknown. Check status.", result: null });
		// Act
		const check = button("Check review status");
		expect(check.disabled).toBe(false);
		click(check);
		// Assert
		expectStatusTarget(submitted);
		expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith({
			preview: submitted,
			approvalDigest: submitted.approvalDigest,
		});
	});

	it.each(["owner and group changed", "all current choices empty"])(
		"checks approved A rather than editable choices when %s",
		(change) => {
			// Arrange
			const submitted = submitOwnerA();
			draw({ result: { preview: submitted, groups: [] } });
			choose(change === "all current choices empty" ? "" : "owner-b");
			click(input("group-two"));
			if (change === "all current choices empty") click(input("group-one"));
			// Act
			const check = button("Check review status");
			expect(check.disabled).toBe(false);
			click(check);
			// Assert
			expectStatusTarget(submitted);
			expect(
				document.querySelector('[aria-label="Reported review outcomes"]')?.textContent,
			).toContain("Reported results for owner owner-a");
			expect(props.onConfirm).toHaveBeenCalledOnce();
			// Act: repeated status requests must also get fresh IDs, never reapply approval.
			click(button("Check review status"));
			// Assert
			expectStatusTarget(submitted);
			expect(props.onConfirm).toHaveBeenCalledOnce();
		},
	);

	it("can check a same-profile result after reopening without choosing a local owner", () => {
		// Arrange
		const submitted = submitOwnerA();
		draw({ open: false, result: { preview: submitted, groups: [] } });
		draw({ open: true });
		expect(document.querySelector("select")?.value).toBe("");
		// Act
		const check = button("Check review status");
		expect(check.disabled).toBe(false);
		click(check);
		// Assert
		expectStatusTarget(submitted);
		expect(props.onConfirm).toHaveBeenCalledOnce();
	});

	it("does not query a foreign-profile result using the current profile", () => {
		// Arrange
		const submitted = submitOwnerA();
		draw({
			profile: { ...profile, contextId: "different-context", deviceId: "different-device" },
			result: { preview: submitted, groups: [] },
		});
		choose("owner-b");
		vi.mocked(props.onPreview).mockClear();
		// Act: hiding the unsafe action or disabling it both prevent cross-profile queries.
		const check = [...document.querySelectorAll("button")].find(
			(item) => item.textContent === "Check review status",
		);
		if (check) click(check);
		// Assert
		expect(check === undefined || check.disabled).toBe(true);
		expect(props.onPreview).not.toHaveBeenCalled();
		expect(props.onConfirm).toHaveBeenCalledOnce();
		const outcomes = document.querySelector('[aria-label="Reported review outcomes"]');
		if (outcomes) {
			expect(outcomes.textContent).toContain(submitted.profile.deviceId);
			expect(outcomes.textContent).toContain(submitted.profile.coordinatorOrigin);
		}
	});

	it("does not show old A outcomes as the status target of a newer submitted B approval", () => {
		// Arrange
		const submittedA = submitOwnerA();
		draw({ result: { preview: submittedA, groups: [] } });
		choose("owner-b");
		click(input("group-two"));
		const submittedB = previewFor(request());
		draw({ preview: submittedB });
		acknowledge();
		// Act
		click(button("Confirm account ownership"));
		draw({ error: "Latest approval outcome unknown" });
		// Assert: obsolete A results must not label the generic lookup for pending B.
		expect(
			document.querySelector('[aria-label="Reported review outcomes"]')?.textContent ?? "",
		).not.toContain("Reported results for owner owner-a");
		// Act
		click(button("Check review status"));
		// Assert
		expectStatusTarget(submittedB);
		expect(props.onConfirm).toHaveBeenCalledTimes(2);
	});
});

describe("operator assistance without credentials or local authority", () => {
	it("copies only explicitly allowed noncredential fields, not unknown runtime profile fields", () => {
		// Arrange
		const extras = {
			password: "synthetic-password",
			adminSecret: "synthetic-admin",
			privateKey: "synthetic-key",
			dbPath: "synthetic-db",
			cookies: "synthetic-cookie",
		};
		const extended = { ...profile, ...extras } as RecoveryProfile;
		const onCopyRequest = vi.fn();
		draw({ profile: extended, reviewAccess: "request", onCopyRequest });
		choose();
		// Act
		click(button("Copy support request"));
		// Assert
		const expected = {
			version: 1,
			coordinatorOrigin: profile.coordinatorOrigin,
			coordinatorId: profile.coordinatorId,
			deviceId: profile.deviceId,
			fingerprint: profile.fingerprint,
			currentMemoryAuthor: "author-c",
			configuredGroups: profile.configuredGroups,
			chosenExistingOwnerId: "owner-a",
		};
		expect(JSON.parse(textarea("Support request (no credentials)").value)).toEqual(expected);
		expect(props.onCopyRequest).toHaveBeenCalledExactlyOnceWith({
			request: expected,
			text: JSON.stringify(expected, null, 2),
		});
		for (const secret of Object.values(extras)) {
			expect(document.body.textContent).not.toContain(secret);
			expect(textarea("Support request (no credentials)").value).not.toContain(secret);
			expect(JSON.stringify(onCopyRequest.mock.calls)).not.toContain(secret);
		}
		expect(textarea("Support request (no credentials)").readOnly).toBe(true);
		expect(document.body.textContent).toContain(
			"Send this request directly to your coordinator operator",
		);
		expect(document.body.textContent).toContain(
			"contains device and group identifiers, so do not post it publicly",
		);
		expect(document.body.textContent?.toLowerCase()).not.toContain("public request");
	});
	it("omits an unchosen owner and provides a selectable request without a copy adapter", () => {
		// Arrange
		draw({ reviewAccess: "request" });
		// Act
		const request = textarea("Support request (no credentials)");
		act(() => {
			request.focus();
			request.select();
		});
		// Assert
		expect(JSON.parse(request.value)).not.toHaveProperty("chosenExistingOwnerId");
		expect(request.selectionEnd - request.selectionStart).toBe(request.value.length);
		expect(document.body.textContent).not.toContain("Copy support request");
		expect(button("Verify operator reply").disabled).toBe(true);
	});
	it("announces copy failure and keeps the read-only select-and-copy fallback", () => {
		// Arrange: no real clipboard access; false represents a failed adapter copy.
		draw({ reviewAccess: "request", onCopyRequest: vi.fn(() => false) });
		// Act
		click(button("Copy support request"));
		// Assert
		expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/copy|select/i);
		expect(textarea("Support request (no credentials)").readOnly).toBe(true);
	});
	it("rejects invalid JSON and clears its announced error when the user edits", () => {
		// Arrange
		draw({ reviewAccess: "request", onImportReply: vi.fn() });
		// Act
		typeReply("{broken");
		click(button("Verify operator reply"));
		// Assert
		expect(props.onImportReply).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("not valid JSON");
		expect(
			textarea("Noncredential operator approval reply (JSON)").getAttribute("aria-invalid"),
		).toBe("true");
		// Act
		typeReply("{}");
		// Assert
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});
	it("forwards valid but untrusted JSON with current selection, never granting authority", () => {
		// Arrange
		draw({ reviewAccess: "request", onImportReply: vi.fn() });
		choose();
		const reply = JSON.stringify({
			contextId: "attacker-context",
			adminSecret: "pasted-synthetic-secret",
			verified: true,
		});
		// Act
		typeReply(reply);
		click(button("Verify operator reply"));
		// Assert
		expect(props.onImportReply).toHaveBeenCalledExactlyOnceWith({
			selection: { profile, existingOwnerId: "owner-a", groups: profile.configuredGroups },
			replyText: reply,
		});
		expect(props.onConfirm).not.toHaveBeenCalled();
		expect(button("Confirm account ownership").disabled).toBe(true);
		expect(document.body.textContent).not.toContain("pasted-synthetic-secret");
		expect(document.querySelector('[aria-label="Reported review outcomes"]')).toBeNull();
		expect(document.body.textContent).toContain(
			"The coordinator must verify it for this device before it can be used",
		);
		expect(document.body.textContent).toContain(
			"do not post it publicly or paste admin credentials",
		);
	});
	it("does not import a reply while busy or without a verifier callback", () => {
		// Arrange
		draw({ reviewAccess: "request", onImportReply: vi.fn() });
		typeReply("{}");
		// Act
		draw({ busy: true });
		click(button("Verify operator reply"));
		// Assert
		expect(props.onImportReply).not.toHaveBeenCalled();
		// Act
		draw({ busy: false, onImportReply: undefined });
		click(button("Verify operator reply"));
		// Assert
		expect(button("Verify operator reply").disabled).toBe(true);
	});
});

describe("copy feedback follows the current noncredential request", () => {
	it("announces a synchronous exception without exposing its private details", () => {
		// Arrange
		draw({
			reviewAccess: "request",
			onCopyRequest: vi.fn(() => {
				throw new Error("synthetic-private-copy-secret");
			}),
		});
		// Act
		click(button("Copy support request"));
		// Assert
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Copy did not work. Select and copy the request text.",
		);
		expect(document.body.textContent).not.toContain("synthetic-private-copy-secret");
		expect(button("Copy support request").disabled).toBe(false);
	});

	it.each(["false", "rejection"])(
		"announces asynchronous %s with a selectable fallback",
		async (outcome) => {
			// Arrange
			const onCopyRequest = vi.fn(() =>
				outcome === "false"
					? Promise.resolve(false)
					: Promise.reject(new Error("synthetic-private-copy-secret")),
			);
			draw({ reviewAccess: "request", onCopyRequest });
			// Act
			await act(async () => {
				button("Copy support request").click();
			});
			const field = textarea("Support request (no credentials)");
			act(() => {
				field.focus();
				field.select();
			});
			// Assert
			expect(document.querySelector('[role="alert"]')?.textContent).toBe(
				"Copy did not work. Select and copy the request text.",
			);
			expect(document.body.textContent).not.toContain("synthetic-private-copy-secret");
			expect(field.readOnly).toBe(true);
			expect(field.selectionEnd - field.selectionStart).toBe(field.value.length);
			expect(button("Copy support request").disabled).toBe(false);
		},
	);

	it("clears an earlier failure on retry and re-enables copying after Promise<void> success", async () => {
		// Arrange
		const pending = deferredCopy<void>();
		const onCopyRequest = vi
			.fn<NonNullable<AccountOwnerRecoveryProps["onCopyRequest"]>>()
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(pending.promise);
		draw({ reviewAccess: "request", onCopyRequest });
		click(button("Copy support request"));
		expect(document.querySelector('[role="alert"]')).not.toBeNull();
		// Act
		click(button("Copy support request"));
		// Assert
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(button("Copy support request").disabled).toBe(true);
		// Act
		await act(async () => {
			pending.resolve(undefined);
			await pending.promise;
		});
		// Assert
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(button("Copy support request").disabled).toBe(false);
		expect(onCopyRequest).toHaveBeenCalledTimes(2);
	});

	it("dispatches only one copy for same-batch duplicate clicks and stays disabled in flight", async () => {
		// Arrange
		const pending = deferredCopy<boolean>();
		const onCopyRequest = vi.fn(() => pending.promise);
		draw({ reviewAccess: "request", onCopyRequest });
		const copy = button("Copy support request");
		// Act
		act(() => {
			copy.click();
			copy.click();
		});
		// Assert
		expect(onCopyRequest).toHaveBeenCalledOnce();
		expect(copy.disabled).toBe(true);
		// Act
		await act(async () => {
			pending.resolve(true);
			await pending.promise;
		});
		// Assert
		expect(copy.disabled).toBe(false);
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});
});

describe("copy results cannot cross request contexts", () => {
	it.each(["owner", "public profile", "context only", "unmount"])(
		"ignores a late failure after changing %s",
		async (change) => {
			// Arrange
			const old = deferredCopy<boolean>();
			const current = deferredCopy<void>();
			const onCopyRequest = vi
				.fn<NonNullable<AccountOwnerRecoveryProps["onCopyRequest"]>>()
				.mockReturnValueOnce(old.promise)
				.mockReturnValueOnce(current.promise);
			draw({ reviewAccess: "request", onCopyRequest });
			choose();
			const previousText = textarea("Support request (no credentials)").value;
			click(button("Copy support request"));
			// Act
			if (change === "owner") choose("owner-b");
			if (change === "public profile") {
				draw({ profile: { ...profile, deviceId: "device-new" } });
				choose();
			}
			if (change === "context only") {
				draw({ profile: { ...profile, contextId: "context-new" } });
				choose();
			}
			if (change === "unmount") {
				draw({ open: false });
				draw({ open: true });
				choose();
			}
			// Assert: a different context can have exactly the same serialized support request.
			expect(button("Copy support request").disabled).toBe(false);
			if (change === "context only" || change === "unmount")
				expect(textarea("Support request (no credentials)").value).toBe(previousText);
			// Act
			click(button("Copy support request"));
			await act(async () => {
				old.resolve(false);
				await old.promise;
			});
			// Assert: the old failure must neither paint feedback nor unlock the new pending copy.
			expect(onCopyRequest).toHaveBeenCalledTimes(2);
			expect(document.querySelector('[role="alert"]')).toBeNull();
			expect(button("Copy support request").disabled).toBe(true);
			// Act
			await act(async () => {
				current.resolve(undefined);
				await current.promise;
			});
			// Assert
			expect(button("Copy support request").disabled).toBe(false);
			expect(document.querySelector('[role="alert"]')).toBeNull();
		},
	);
});

describe("owner suggestions and blocked confirmation", () => {
	it("opens manual owner entry and explains when no owner is recorded", () => {
		// Arrange
		draw({ candidates: [] });
		// Act
		const select = document.querySelector("select");
		// Assert
		expect(select?.disabled).toBe(true);
		expect(select?.textContent).toBe("No recorded owners");
		expect(document.querySelector("details")?.open).toBe(true);
		expect(document.body.textContent).toContain("No recorded owner was found for this device");
	});

	it("names the blocked groups next to the disabled acknowledgement", () => {
		// Arrange
		draw();
		choose();
		const requested = request();
		const preview = previewFor(requested);
		preview.groupPreviews = [
			{ groupId: "group-one", action: "blocked", reason: "account_owner_target_unavailable" },
			{ groupId: "group-two", action: "new", reason: "Review needed" },
		];
		// Act
		draw({ preview });
		// Assert
		const ack = input("I reviewed these records and groups");
		expect(ack.disabled).toBe(true);
		const reason = document.getElementById(ack.getAttribute("aria-describedby") ?? "");
		expect(reason?.textContent).toBe(
			"You can't confirm yet because group-one is blocked. Clear blocked groups or fix them, then preview again.",
		);
		expect(button("Confirm account ownership").disabled).toBe(true);
	});

	it("explains known blocker codes in plain language and keeps the code in operator details", () => {
		// Arrange
		draw();
		choose();
		const preview = previewFor(request());
		preview.groupPreviews = [
			{
				groupId: "group-one",
				action: "blocked",
				reason: "account_owner_target_unavailable: verify the selected account connection",
			},
			{ groupId: "group-two", action: "new", reason: "Review needed" },
		];
		// Act
		draw({ preview });
		// Assert
		const text = document.querySelector('[aria-label="Server ownership preview"]')?.textContent;
		expect(text).toContain(
			"group-one: Blocked — The coordinator has no Google account link for this Identity.",
		);
		const details = [...document.querySelectorAll("details")].find(
			(item) => item.querySelector("summary")?.textContent === "Operator details",
		);
		expect(details?.open).toBe(false);
		expect(details?.textContent).toContain(
			"account_owner_target_unavailable: verify the selected account connection",
		);
	});

	it("translates every joined blocker code and keeps unknown codes readable", () => {
		// Arrange
		draw();
		choose();
		const preview = previewFor(request());
		preview.groupPreviews = [
			{
				groupId: "group-one",
				action: "blocked",
				reason: "account_owner_conflict: inspect; invite_identity_mismatch",
			},
			{ groupId: "group-two", action: "new", reason: "Review needed" },
		];
		// Act
		draw({ preview });
		// Assert
		const text = document.querySelector('[aria-label="Server ownership preview"]')?.textContent;
		expect(text).toContain(
			"group-one: Blocked — The coordinator records a different owner for this Google account. invite_identity_mismatch",
		);
	});

	it("describes what confirming allows when the acknowledgement is available", () => {
		// Arrange
		draw();
		// Act
		review();
		// Assert
		const ack = input("I reviewed these records and groups");
		const description = document.getElementById(ack.getAttribute("aria-describedby") ?? "");
		expect(ack.disabled).toBe(false);
		expect(description?.textContent).toContain("which can allow account changes");
	});

	it("does not render empty reviewed-label sections or ready-state filler reasons", () => {
		// Arrange
		draw();
		// Act
		const preview = review();
		draw({ preview: { ...preview, reviewedWeakLabels: [] } });
		// Assert
		const text = document.querySelector('[aria-label="Server ownership preview"]')?.textContent;
		expect(text).not.toContain("Reviewed labels");
		expect(text).toContain("group-one: Ready to confirm");
		expect(text).not.toContain("Review needed");
	});
});
