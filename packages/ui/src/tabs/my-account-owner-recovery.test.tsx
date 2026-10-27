import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoveryPreviewRequest } from "./account-owner-recovery-types";
import { MyAccount } from "./my-account";
import {
	deferred,
	operation,
	privateUrl,
	response,
	settle,
	status,
	tick,
} from "./my-account-test-utils";
import {
	blockedAccount,
	ownerAccount,
	recoveryEnvelope,
	recoveryPreview,
} from "./owner-recovery-test-utils";

const ROOT = "/api/account/owner-recovery";
const transport = vi.fn<typeof fetch>();
let mount: HTMLDivElement;
let view: ReturnType<typeof blockedAccount>;
let envelope: ReturnType<typeof recoveryEnvelope>;
let previewReply: (request: RecoveryPreviewRequest) => Response | Promise<Response>;
let confirmReply: (preview: ReturnType<typeof recoveryPreview>) => Response | Promise<Response>;
let profileReply: () => Response | Promise<Response>;
let importReply: () => Response | Promise<Response>;
const calls = (path: string) => transport.mock.calls.filter(([url]) => url === path);
const posts = () => transport.mock.calls.filter(([, options]) => options?.method === "POST");
const body = (path: string, index = 0) => JSON.parse(String(calls(path)[index]?.[1]?.body));
function button(name: string | RegExp) {
	const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
		typeof name === "string"
			? candidate.textContent === name
			: name.test(candidate.textContent ?? ""),
	);
	if (!node) throw new Error(`Missing button: ${name}`);
	return node;
}
async function click(name: string | RegExp) {
	await act(async () => button(name).click());
	await settle();
}
async function input(
	node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
	value: string,
) {
	await act(async () => {
		node.value = value;
		node.dispatchEvent(
			new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
		);
	});
	await settle();
}
function dialog() {
	const node = document.querySelector<HTMLElement>('[role="dialog"]');
	if (!node) throw new Error("Missing ownership recovery dialog");
	return node;
}
function ownerChoice() {
	const node = dialog().querySelector<HTMLSelectElement>("select");
	if (!node) throw new Error("Missing explicit owner choice");
	return node;
}
function ack() {
	const node = [...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
		(candidate) => /I reviewed these records/.test(candidate.parentElement?.textContent ?? ""),
	);
	if (!node) throw new Error("Missing consent checkbox");
	return node;
}
async function show() {
	await act(async () => render(<MyAccount />, mount));
	await settle();
}
async function open() {
	await show();
	await click(/review account ownership|recover account ownership/i);
}
async function preview() {
	await input(ownerChoice(), "identity-a");
	await click("Preview account ownership");
}
async function acknowledge() {
	await act(async () => ack().click());
	await settle();
}
async function submit() {
	await preview();
	await acknowledge();
	await click("Confirm account ownership");
}

beforeEach(() => {
	vi.useFakeTimers();
	view = blockedAccount();
	envelope = recoveryEnvelope();
	previewReply = (request) => response(recoveryPreview(request));
	confirmReply = (review) =>
		response({
			preview: review,
			groups: review.groups.map((groupId) => ({
				groupId,
				status: "confirmed",
				message: "Verified by service.",
			})),
		});
	profileReply = () => response(envelope);
	importReply = () => response({ preview: recoveryPreview(), groups: [] });
	mount = document.createElement("div");
	document.body.append(mount);
	vi.spyOn(window, "open").mockReturnValue(null);
	vi.stubGlobal(
		"fetch",
		transport.mockReset().mockImplementation(async (url, options) => {
			if (url === "/api/account/session")
				return response({ version: 1, csrfToken: "recovery-fixture" });
			if (String(url).startsWith("/api/account/link-status")) return response(view);
			if (url === ROOT) return profileReply();
			if (url === `${ROOT}/preview`) return previewReply(JSON.parse(String(options?.body)));
			if (url === `${ROOT}/confirm`) return confirmReply(JSON.parse(String(options?.body)).preview);
			if (url === `${ROOT}/import`) return importReply();
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
});
afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("My Account recovery through the protected API", () => {
	it("opens with a profile GET only, no selected owner, no mutation and default-No consent", async () => {
		// Arrange
		const storage = vi.spyOn(Storage.prototype, "setItem");
		// Act
		await open();
		// Assert: one suggested owner is not an automatic choice or authority.
		expect(calls(ROOT)).toHaveLength(1);
		expect(posts()).toHaveLength(0);
		expect(ownerChoice().value).toBe("");
		expect(button("Preview account ownership").disabled).toBe(true);
		expect(button("Confirm account ownership").disabled).toBe(true);
		expect(dialog().textContent).toMatch(/identity-b/);
		expect(storage).not.toHaveBeenCalled();
		expect(window.open).not.toHaveBeenCalled();
	});
	it("does not fetch recovery or submit anything just by loading a blocked account", async () => {
		// Arrange
		view = blockedAccount();
		// Act
		await show();
		// Assert
		expect(button(/review account ownership|recover account ownership/i).disabled).toBe(false);
		expect(calls(ROOT)).toHaveLength(0);
		expect(posts()).toHaveLength(0);
	});
	it.each(["conflict", "identity_mismatch", "association_invalid"])(
		"offers the existing dialog for %s without bypassing the block",
		async (reason) => {
			// Arrange
			if (reason === "conflict" && view.remote.kind === "status") {
				view.remote.state = "conflict";
				view.blockedReason = "conflict";
			}
			if (reason === "identity_mismatch") view.blockedReason = "identity_mismatch";
			if (reason === "association_invalid")
				view.remote = { kind: "unavailable", code: "account_owner_association_invalid" };
			// Act
			await open();
			// Assert
			expect(dialog().textContent).toContain("Review account ownership");
			expect(posts()).toHaveLength(0);
			expect(window.open).not.toHaveBeenCalled();
		},
	);
	it("sends the actual server profile and explicit owner/groups, then requires current acknowledgment before confirm", async () => {
		// Arrange
		await open();
		// Act
		await preview();
		// Assert: account view's display context is not the recovery authority context.
		const submitted = body(`${ROOT}/preview`);
		expect(submitted).toMatchObject({
			profile: envelope.profile,
			existingOwnerId: "identity-a",
			groups: ["group-one", "group-two"],
			purpose: "review",
		});
		expect(submitted.profile.contextId).not.toBe(view.contextId);
		expect(button("Confirm account ownership").disabled).toBe(true);
		expect(ack().checked).toBe(false);
		// Act
		await acknowledge();
		await click("Confirm account ownership");
		// Assert
		expect(body(`${ROOT}/confirm`)).toEqual({
			preview: recoveryPreview(submitted),
			approvalDigest: "a".repeat(64),
		});
		expect(calls(`${ROOT}/confirm`)).toHaveLength(1);
	});
});
describe("current recovery choices and request lifetime", () => {
	it("invalidates the preview and consent when the chosen owner changes", async () => {
		// Arrange
		envelope.candidates.push({ id: "identity-other", label: "Other owner" });
		await open();
		await preview();
		await acknowledge();
		// Act
		await input(ownerChoice(), "identity-other");
		// Assert
		expect(button("Confirm account ownership").disabled).toBe(true);
		expect(calls(`${ROOT}/confirm`)).toHaveLength(0);
	});
	it("invalidates consent when a coordinator group is unchecked", async () => {
		// Arrange
		await open();
		await preview();
		await acknowledge();
		const group = [...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
			(node) => node.parentElement?.textContent?.trim() === "group-two",
		);
		if (!group) throw new Error("Missing group-two checkbox");
		// Act
		await act(async () => group.click());
		await settle();
		// Assert
		expect(button("Confirm account ownership").disabled).toBe(true);
		expect(calls(`${ROOT}/confirm`)).toHaveLength(0);
	});
	it("ignores a late profile response after close, even when fetch ignores abort", async () => {
		// Arrange
		const pending = deferred<Response>();
		profileReply = () => pending.promise;
		await open();
		const signal = calls(ROOT)[0][1]?.signal;
		// Act
		await click("Cancel");
		pending.resolve(response(envelope));
		await settle();
		// Assert
		expect(signal?.aborted).toBe(true);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(posts()).toHaveLength(0);
	});
	it("does not let an older opening replace a newer profile", async () => {
		// Arrange
		const pending = deferred<Response>();
		profileReply = () => pending.promise;
		await open();
		await click("Cancel");
		const next = recoveryEnvelope();
		next.profile.contextId = "new-semantic-context";
		next.profile.memoryActorId = "new-author";
		profileReply = () => response(next);
		// Act
		await click(/review account ownership|recover account ownership/i);
		pending.resolve(response(envelope));
		await settle();
		// Assert
		expect(dialog().textContent).toContain("new-author");
		expect(dialog().textContent).not.toContain("identity-b");
		expect(posts()).toHaveLength(0);
	});
	it("discards a pending preview when the current account group/profile changes", async () => {
		// Arrange
		const pending = deferred<Response>();
		let captured = recoveryPreview();
		previewReply = (request) => {
			captured = recoveryPreview(request);
			return pending.promise;
		};
		await open();
		await preview();
		const signal = calls(`${ROOT}/preview`)[0][1]?.signal;
		view = {
			...blockedAccount(),
			contextId: "changed-account-context",
			selectedGroupId: "group-two",
			local: { deviceId: "device-one", fingerprint: "fingerprint", identityId: "other-actor" },
		};
		// Act: refresh the real parent rather than invoking dialog callbacks.
		await click("Check status");
		pending.resolve(response(captured));
		await settle();
		// Assert
		expect(signal?.aborted).toBe(true);
		expect(calls(`${ROOT}/confirm`)).toHaveLength(0);
		const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.textContent === "Confirm account ownership",
		);
		expect(!confirm || confirm.disabled).toBe(true);
	});
});
describe("server recovery preview consent metadata", () => {
	it.each(["scope", "owner", "profile", "groups", "weak metadata", "digest", "request"])(
		"refuses a server preview with mismatched or missing %s",
		async (fault) => {
			// Arrange
			previewReply = (request) => {
				const result: Record<string, unknown> = recoveryPreview(request);
				const faults: Record<string, Record<string, unknown>> = {
					scope: { scope: "all_records" },
					owner: { existingOwnerId: "other-owner" },
					profile: { profile: { ...request.profile, contextId: "other-context" } },
					groups: { groupPreviews: [] },
					"weak metadata": { reviewedWeakLabels: undefined },
					digest: { approvalDigest: "" },
					request: { requestId: "stale-request" },
				};
				Object.assign(result, faults[fault]);
				return response(result);
			};
			// Act
			await open();
			await preview();
			// Assert
			expect(button("Confirm account ownership").disabled).toBe(true);
			expect(calls(`${ROOT}/confirm`)).toHaveLength(0);
			expect(dialog().querySelector('[role="alert"], [role="status"]')?.textContent).toBeTruthy();
		},
	);
	it("shows complete retained history and genuine project weak labels without fabricated assignments", async () => {
		// Arrange
		await open();
		// Act
		await preview();
		// Assert
		const text = dialog().textContent ?? "";
		expect(text).toContain("retained-history-group");
		expect(text).toContain("identity-b");
		expect(text).toContain("project-author-b");
		expect(text).toContain("b".repeat(64));
		expect(text).toMatch(/consumed.project.actor.label|project.*label/i);
		expect(text).toMatch(/account.owner.display.only|display.only/i);
		expect(
			[...dialog().querySelectorAll("li")]
				.filter((node) => node.textContent?.includes("project-author-b"))
				.every(
					(node) =>
						!/Previously included|Previously excluded|Fingerprint/.test(node.textContent ?? ""),
				),
		).toBe(true);
	});
	it("shows an operator upgrade blocker and disables approval even with complete history", async () => {
		// Arrange
		previewReply = (request) =>
			response({
				...recoveryPreview(request),
				groupPreviews: request.groups.map((groupId) => ({
					groupId,
					action: "blocked",
					reason: "resolution_schema_upgrade_required",
				})),
			});
		// Act
		await open();
		await preview();
		// Assert
		expect(dialog().textContent).toMatch(/schema|upgrade/i);
		expect(dialog().textContent).toMatch(
			/^(?![\s\S]*\bowner-resolution-schema\b)[\s\S]*codemem coordinator upgrade-account-schema --owner-resolution --export-sql --json/,
		);
		expect(ack().disabled).toBe(true);
		expect(button("Confirm account ownership").disabled).toBe(true);
		expect(posts()).toHaveLength(1);
	});
	it("keeps unavailable profile errors actionable and read-only", async () => {
		// Arrange
		profileReply = () => response({ error: "account_owner_recovery_unavailable" }, 503);
		// Act
		await open();
		// Assert
		expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
			/check|operator|try|update/i,
		);
		expect(button("Check status").disabled).toBe(false);
		expect(posts()).toHaveLength(0);
	});
});
describe("recovery dispatch and unknown results", () => {
	it("dispatches only one confirmation when the user clicks twice while busy", async () => {
		// Arrange
		const pending = deferred<Response>();
		confirmReply = () => pending.promise;
		await open();
		await preview();
		await acknowledge();
		// Act
		await act(async () => {
			const confirm = button("Confirm account ownership");
			confirm.click();
			confirm.click();
		});
		await settle();
		// Assert
		expect(calls(`${ROOT}/confirm`)).toHaveLength(1);
		expect(button("Confirm account ownership").disabled).toBe(true);
		// Cleanup the deterministic transport without another action.
		pending.resolve(response({ preview: recoveryPreview(body(`${ROOT}/preview`)), groups: [] }));
		await settle();
	});
	it("keeps unknown/partial results on the original submitted target and checks status without reapplying", async () => {
		// Arrange
		confirmReply = (review) =>
			response({
				preview: review,
				groups: [
					{ groupId: "group-one", status: "confirmed", message: "Confirmed." },
					{ groupId: "group-two", status: "unknown", message: "Reply lost. Check review status." },
				],
			});
		await open();
		await submit();
		const original = body(`${ROOT}/preview`);
		// Act
		await click("Check review status");
		// Assert
		expect(body(`${ROOT}/preview`, 1)).toMatchObject({
			profile: original.profile,
			groups: original.groups,
			existingOwnerId: original.existingOwnerId,
			purpose: "check_status",
		});
		expect(body(`${ROOT}/preview`, 1).requestId).not.toBe(original.requestId);
		expect(calls(`${ROOT}/confirm`)).toHaveLength(1);
		expect(calls(`${ROOT}/import`)).toHaveLength(0);
		expect(button("Confirm account ownership").disabled).toBe(true);
		expect(dialog().textContent).toMatch(/unknown|Reply lost/);
	});
	it.each(["", "identity-b"])(
		"displays fresh read-only status for submitted owner A after reopening with owner choice '%s'",
		async (currentOwner) => {
			// Arrange: the submitted A target survives a lost reply, but local choices reset.
			confirmReply = () => Promise.reject(new Error("Lost reply"));
			await open();
			await submit();
			const original = body(`${ROOT}/preview`);
			await click("Close");
			await click(/review account ownership|recover account ownership/i);
			expect(ownerChoice().value).toBe("");
			if (currentOwner) {
				const manualOwner = dialog().querySelector<HTMLInputElement>('input[autocomplete="off"]');
				if (!manualOwner) throw new Error("Missing manual owner input");
				await input(manualOwner, currentOwner);
			}
			expect(calls(`${ROOT}/preview`)).toHaveLength(1);
			previewReply = (request) =>
				response({
					...recoveryPreview(request),
					groupPreviews: request.groups.map((groupId) => ({
						groupId,
						action: "reuse",
						reason: `Existing review found for ${groupId}; local retention not verified.`,
					})),
				});

			// Act: this is the dialog's status read, not the ordinary account "Check status".
			await click("Check review status");

			// Assert dispatch separately: status reads never select a new review or reapply A.
			const checked = body(`${ROOT}/preview`, 1);
			expect(checked).toMatchObject({
				profile: original.profile,
				existingOwnerId: "identity-a",
				groups: ["group-one", "group-two"],
				purpose: "check_status",
			});
			expect(checked.requestId).not.toBe(original.requestId);
			expect(calls(`${ROOT}/preview`)).toHaveLength(2);
			expect(calls(`${ROOT}/confirm`)).toHaveLength(1);
			expect(calls(`${ROOT}/import`)).toHaveLength(0);
			expect(button("Confirm account ownership").disabled).toBe(true);
			const consent = [
				...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
			].filter((node) => /I reviewed these records/.test(node.parentElement?.textContent ?? ""));
			expect(consent.every((node) => node.disabled && !node.checked)).toBe(true);
			expect(mount.textContent).not.toContain("owner-a@example.test");

			// Assert display, not just transport: the current read must show captured A's groups,
			// even when the editable choice is empty or B. Old unknown outcomes alone are insufficient.
			const freshReview = [...dialog().querySelectorAll("section")].find((section) =>
				section.querySelector("h3")?.textContent?.includes("Ownership review for identity-a"),
			);
			const freshText = freshReview?.textContent ?? "";
			expect.soft(freshText).toContain("Ownership review for identity-a");
			for (const groupId of original.groups) {
				expect.soft(freshText).toContain(`${groupId}: Already confirmed`);
				expect
					.soft(freshText)
					.toContain(`Existing review found for ${groupId}; local retention not verified.`);
			}
			expect.soft(freshText).not.toContain("Ownership review for identity-b");
		},
	);
	it("does not replay a confirmation with a lost response on close/reopen", async () => {
		// Arrange
		confirmReply = () => Promise.reject(new Error("Lost reply"));
		await open();
		await submit();
		// Act
		await click("Close");
		await click(/review account ownership|recover account ownership/i);
		// Assert
		expect(calls(`${ROOT}/confirm`)).toHaveLength(1);
		expect(calls(`${ROOT}/import`)).toHaveLength(0);
		expect(dialog().textContent).toMatch(/unknown|check.*status|already sent/i);
		expect(button("Check review status").disabled).toBe(false);
	});
});
describe("noncredential recovery assistance", () => {
	it("copies only a noncredential support request from an explicit user gesture", async () => {
		// Arrange
		envelope.reviewAccess = "request";
		const writeText = vi.fn().mockResolvedValue(undefined);
		const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		try {
			await open();
			expect(writeText).not.toHaveBeenCalled();
			// Act
			await click("Copy support request");
			// Assert
			expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({
				version: 1,
				coordinatorOrigin: envelope.profile.coordinatorOrigin,
				coordinatorId: envelope.profile.coordinatorId,
				deviceId: envelope.profile.deviceId,
				fingerprint: envelope.profile.fingerprint,
				currentMemoryAuthor: "identity-b",
				configuredGroups: envelope.profile.configuredGroups,
			});
			expect(writeText.mock.calls[0][0]).not.toMatch(/csrf|adminSecret|dbPath|keysDir|privateKey/);
			expect(posts()).toHaveLength(0);
		} finally {
			if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
			else Reflect.deleteProperty(navigator, "clipboard");
		}
	});
	it("rejects non-JSON reply locally without import or optimistic owner display", async () => {
		// Arrange
		envelope.reviewAccess = "request";
		await open();
		const reply = dialog().querySelector<HTMLTextAreaElement>("textarea:not([readonly])");
		if (!reply) throw new Error("Missing reply input");
		await input(reply, "not JSON");
		// Act
		await click("Verify operator reply");
		// Assert
		expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(/JSON/);
		expect(calls(`${ROOT}/import`)).toHaveLength(0);
		expect(mount.textContent).not.toContain("owner-a@example.test");
	});
	it("sends reply references to the backend and shows an owner only after refreshing verified account status", async () => {
		// Arrange
		envelope.reviewAccess = "request";
		await open();
		await input(ownerChoice(), "identity-a");
		const reply = dialog().querySelector<HTMLTextAreaElement>("textarea:not([readonly])");
		if (!reply) throw new Error("Missing reply input");
		const text = JSON.stringify({
			version: 1,
			purpose: "existing_account_owner",
			groups: [{ groupId: "group-one", resolutionId: "untrusted-reference" }],
		});
		await input(reply, text);
		const before = transport.mock.calls.filter(([url]) =>
			String(url).includes("link-status"),
		).length;
		importReply = () => {
			view = ownerAccount();
			const preview = recoveryPreview();
			return response({
				preview,
				groups: preview.groups.map((groupId) => ({
					groupId,
					status: "confirmed",
					message: "Verified.",
				})),
			});
		};
		// Act
		await click("Verify operator reply");
		// Assert
		expect(body(`${ROOT}/import`)).toEqual({
			selection: {
				profile: envelope.profile,
				existingOwnerId: "identity-a",
				groups: envelope.profile.configuredGroups,
			},
			replyText: text,
		});
		expect(
			transport.mock.calls.filter(([url]) => String(url).includes("link-status")).length,
		).toBeGreaterThan(before);
		expect(mount.textContent).toMatch(/Google account belongs to/);
		expect(mount.textContent).not.toContain("owner-a@example.test");
		expect(calls(`${ROOT}/confirm`)).toHaveLength(0);
	});
});
describe("recovery errors and focus", () => {
	it("keeps B's sign-in window open when A's verified owner profile arrives with B's unknown result", async () => {
		// Arrange: start a real ordinary actor flow; an owner display is not its completion event.
		view = status({
			local: blockedAccount().local,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				authority: "device_claim",
				identityId: "identity-b",
				identityMatches: true,
				state: "unlinked",
				account: null,
			},
		});
		const popup = { opener: null, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
		vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
		const originalTransport = transport.getMockImplementation();
		if (!originalTransport) throw new Error("Missing protected fixture transport");
		transport.mockImplementation(async (url, options) => {
			if (url === "/api/account/link-operations")
				return response({ version: 1, operation: operation("awaiting_browser") });
			if (String(url).endsWith("/browser-url")) return response({ version: 1, url: privateUrl });
			if (url === "/api/account/link-operations/op-one")
				return response({
					version: 1,
					operation: { ...operation("outcome_unknown"), failure: "cancellation_unconfirmed" },
					current: true,
				});
			return originalTransport(url, options);
		});
		await show();
		await click("Link Google account");
		expect(popup.location.replace).toHaveBeenCalledWith(privateUrl);
		view = {
			...ownerAccount(),
			operation: { ...operation("outcome_unknown"), failure: "cancellation_unconfirmed" },
		};
		// Act
		await tick();
		// Assert: render verified A without interpreting it as successful authentication for B.
		expect(mount.textContent).not.toContain("owner-a@example.test");
		expect(mount.textContent).toMatch(/unknown|couldn.t confirm/i);
		expect(popup.close).not.toHaveBeenCalled();
		expect(calls(`${ROOT}/confirm`)).toHaveLength(0);
	});
	it("does not treat pasted owner metadata as proof when backend import is unavailable", async () => {
		// Arrange
		envelope.reviewAccess = "request";
		await open();
		const reply = dialog().querySelector<HTMLTextAreaElement>("textarea:not([readonly])");
		if (!reply) throw new Error("Missing reply input");
		await input(
			reply,
			JSON.stringify({
				ownerIdentityId: "identity-a",
				profile: { email: "unverified@example.test" },
			}),
		);
		importReply = () => response({ error: "account_owner_recovery_unavailable" }, 503);
		// Act
		await click("Verify operator reply");
		// Assert
		expect(calls(`${ROOT}/import`)).toHaveLength(1);
		expect(mount.textContent).not.toContain("unverified@example.test");
		expect(mount.textContent).not.toContain("Verified Owner A");
		expect(dialog().querySelector('[role="alert"]')?.textContent).toBeTruthy();
		expect(calls(`${ROOT}/confirm`)).toHaveLength(0);
	});
	it("returns focus to the recovery entry and exposes the approved labelled dialog", async () => {
		// Arrange
		await open();
		const titleId = dialog().getAttribute("aria-labelledby");
		// Assert the joined adapter keeps the existing dialog accessibility contract.
		expect(titleId && document.getElementById(titleId)?.textContent).toBe(
			"Review account ownership",
		);
		expect(document.activeElement).toBe(button("Cancel"));
		// Act
		await click("Cancel");
		// Assert
		expect(document.activeElement).toBe(
			button(/review account ownership|recover account ownership/i),
		);
	});
});

describe("ownership review dialog state after a slow or failed confirmation", () => {
	it("clears the earlier unknown results when the user previews again", async () => {
		// Arrange
		confirmReply = (review) =>
			response({
				preview: review,
				groups: review.groups.map((groupId) => ({
					groupId,
					status: "unknown",
					message: "Check coordinator status before trying again.",
				})),
			});
		await open();
		await submit();
		expect(dialog().querySelector('[aria-label="Reported review outcomes"]')).not.toBeNull();
		// Act
		await click("Preview account ownership");
		// Assert
		expect(dialog().querySelector('[aria-label="Reported review outcomes"]')).toBeNull();
		expect(dialog().textContent).toContain("Ready to confirm");
		expect(dialog().textContent).not.toContain("Closing does not undo");
	});

	it("keeps the unknown results and status check when the new preview fails", async () => {
		// Arrange
		confirmReply = (review) =>
			response({
				preview: review,
				groups: review.groups.map((groupId) => ({
					groupId,
					status: "unknown",
					message: "Check coordinator status before trying again.",
				})),
			});
		await open();
		await submit();
		previewReply = () => response({ error: "account_owner_recovery_unavailable" }, 503);
		// Act
		await click("Preview account ownership");
		// Assert
		expect(dialog().querySelector('[aria-label="Reported review outcomes"]')).not.toBeNull();
		expect(button("Check review status").disabled).toBe(false);
	});

	it("names why Confirm is disabled, including an expired preview", async () => {
		// Arrange
		await open();
		const confirm = () => button("Confirm account ownership");
		const reason = () =>
			document.getElementById(confirm().getAttribute("aria-describedby") ?? "")?.textContent;
		expect(reason()).toBe("Preview account ownership first.");
		// Act
		await preview();
		// Assert
		expect(confirm().disabled).toBe(true);
		expect(reason()).toBe("Check the confirmation box first.");
		// Act
		await acknowledge();
		// Assert
		expect(confirm().disabled).toBe(false);
		expect(confirm().hasAttribute("aria-describedby")).toBe(false);
		// Act
		await act(async () => {
			vi.advanceTimersByTime(5 * 60_000);
		});
		// Assert
		expect(confirm().disabled).toBe(true);
		expect(reason()).toBe("This preview expired after 5 minutes. Preview again.");
	});

	it("says that one ownership request runs at a time", async () => {
		// Arrange
		previewReply = () => response({ error: "account_owner_recovery_busy" }, 409);
		await open();
		// Act
		await preview();
		// Assert
		expect(dialog().textContent).toContain("Codemem runs one ownership request at a time.");
		expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
			"possibly in another tab",
		);
	});

	it("shows the fix for an unsafe state directory instead of blaming the coordinator", async () => {
		// Arrange
		const detail =
			"/home/me/.codemem is writable by other users. Run `chmod go-w /home/me/.codemem`, then try again.";
		previewReply = () => response({ error: "account_owner_recovery_storage_unsafe", detail }, 409);
		await open();
		// Act
		await preview();
		// Assert
		const alert = dialog().querySelector('[role="alert"]')?.textContent;
		expect(alert).toContain("chmod go-w /home/me/.codemem");
		expect(alert).not.toContain("coordinator didn't answer");
	});

	it("wraps long IDs and shows a coordinator whose ID is its origin once", async () => {
		// Arrange
		envelope = {
			...envelope,
			profile: { ...envelope.profile, coordinatorId: envelope.profile.coordinatorOrigin },
		};
		// Act
		await open();
		// Assert
		const body = dialog().querySelector(".account-owner-recovery-body");
		expect(body).not.toBeNull();
		const coordinator = [...dialog().querySelectorAll("dt")].find(
			(term) => term.textContent === "Coordinator",
		)?.nextElementSibling?.textContent;
		expect(coordinator).toBe(envelope.profile.coordinatorOrigin);
	});
});
