// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DevicesToReview,
	type DiscoveredDevicesApi,
	reviewableDiscoveredRows,
} from "./device-discovered";
import type { TeamSyncDiscoveredRow } from "./sync/team-sync/discovered-devices";

let mount: HTMLElement;

beforeEach(() => {
	mount = document.createElement("div");
	document.body.append(mount);
});

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

function row(overrides: Partial<TeamSyncDiscoveredRow> = {}): TeamSyncDiscoveredRow {
	return {
		actionMessage: null,
		actionLabel: "Approve on this device",
		approvalBadgeLabel: "Needs your approval",
		approvalState: "needs-local-approval",
		availabilityLabel: "Available",
		connectionLabel: "Paired on this device",
		coordinatorUrl: "https://coord.example.test",
		deviceId: "device-a",
		displayName: "Desk Mini",
		displayTitle: "device-a",
		fingerprint: "fingerprint-a",
		groupId: "team-a",
		incomingRequestId: "request-a",
		mode: "accept",
		note: "No fresh addresses",
		pairedMessage: null,
		...overrides,
	};
}

function fakeApi(overrides: Partial<DiscoveredDevicesApi> = {}): DiscoveredDevicesApi {
	return { review: vi.fn(async () => null), disconnect: vi.fn(async () => null), ...overrides };
}

async function show(rows: TeamSyncDiscoveredRow[], api = fakeApi(), onDone = vi.fn()) {
	await act(() => render(<DevicesToReview api={api} onDone={onDone} rows={rows} />, mount));
	return { api, onDone };
}

describe("Devices waiting for review", () => {
	it("shows nothing when no device needs review", async () => {
		await show([row({ mode: "paired" }), row({ mode: "none" }), row({ mode: "scope-pending" })]);

		expect(mount.textContent).toBe("");
	});

	it("lists the devices to act on and not the ones already paired", () => {
		const rows = [row(), row({ deviceId: "device-b", mode: "paired" })];

		expect(reviewableDiscoveredRows(rows).map((item) => item.deviceId)).toEqual(["device-a"]);
	});

	it.each(["Available", "Offline"])("keeps the badge markup when %s", async (availabilityLabel) => {
		const item = row({
			availabilityLabel,
			approvalBadgeLabel: availabilityLabel === "Offline" ? null : "Needs your approval",
		});

		await show([item]);

		const badges = [...mount.querySelectorAll(".peer-title .badge")];
		expect(badges.map((badge) => [badge.tagName, badge.className, badge.textContent])).toEqual([
			[
				"SPAN",
				availabilityLabel === "Offline" ? "badge actor-badge" : "badge actor-badge local",
				availabilityLabel,
			],
			["SPAN", "badge actor-badge", "Paired on this device"],
			...(item.approvalBadgeLabel ? [["SPAN", "badge actor-badge", item.approvalBadgeLabel]] : []),
		]);
	});

	it("shows an approval already sent as status without another approval action", async () => {
		await show([
			row({
				actionMessage:
					"Waiting for refreshed coordinator status. You do not need to approve again.",
				actionLabel: null,
				approvalBadgeLabel: "Approval sent",
				approvalState: "approval-pending",
				mode: "approval-pending",
			}),
		]);

		expect(mount.textContent).toContain("Approval sent");
		expect(mount.textContent).toContain("You do not need to approve again.");
		expect(mount.querySelector("button")).toBeNull();
	});

	it("pairs a device, reports the result and refreshes Devices", async () => {
		const api = fakeApi({
			review: vi.fn(async () => ({ message: "Approval sent.", tone: "success" as const })),
		});
		const { onDone } = await show([row()], api);

		await act(async () => mount.querySelector("button")?.click());
		await act(async () => {});

		expect(api.review).toHaveBeenCalledOnce();
		expect(mount.querySelector('[role="status"]')?.textContent).toContain("Approval sent.");
		expect(onDone).toHaveBeenCalledOnce();
	});

	it("keeps a failed approval retryable and does not refresh", async () => {
		const api = fakeApi({
			review: vi.fn(async () => ({
				message: "Approval failed before submission. Try again.",
				tone: "warning" as const,
			})),
		});
		const { onDone } = await show([row()], api);
		const button = mount.querySelector("button") as HTMLButtonElement;

		await act(async () => button.click());
		await act(async () => {});

		expect(button.textContent).toBe("Retry");
		expect(button.disabled).toBe(false);
		expect(mount.querySelector('[role="alert"]')?.textContent).toContain(
			"Approval failed before submission",
		);
		expect(onDone).toHaveBeenCalledOnce();
	});

	it("does not refresh when the person cancels the naming step", async () => {
		const { onDone } = await show([row()], fakeApi({ review: vi.fn(async () => null) }));

		await act(async () => mount.querySelector("button")?.click());

		expect(onDone).not.toHaveBeenCalled();
	});

	it("offers to unpair a pairing that conflicts with the team's device", async () => {
		const api = fakeApi({
			disconnect: vi.fn(async () => ({
				message: "Unpaired this device from Desk Mini.",
				tone: "success" as const,
			})),
		});
		const { onDone } = await show([row({ mode: "conflict", approvalBadgeLabel: null })], api);

		expect(mount.textContent).toContain(
			"The pairing saved on this device does not match the device your team lists.",
		);
		await act(async () =>
			mount.querySelector<HTMLButtonElement>('[aria-label="Unpair Desk Mini"]')?.click(),
		);
		await act(async () => {});

		expect(api.disconnect).toHaveBeenCalledOnce();
		expect(onDone).toHaveBeenCalledOnce();
		expect(mount.textContent).toContain("Unpaired this device from Desk Mini.");
	});
});

describe("Devices waiting for review results", () => {
	it("keeps the result visible after the paired device leaves the list", async () => {
		const api = fakeApi({
			review: vi.fn(async () => ({
				message:
					"Step 1 complete on this device for Desk Mini. Finish onboarding on the other device so both sides trust each other for sync.",
				tone: "success" as const,
			})),
		});
		const onDone = vi.fn();
		await show([row({ approvalState: "not-required" })], api, onDone);
		await act(async () => mount.querySelector("button")?.click());
		await act(async () => {});

		// The refresh moves the device out of the review list.
		await act(() => render(<DevicesToReview api={api} onDone={onDone} rows={[]} />, mount));

		expect(mount.querySelector("li")).toBeNull();
		expect(mount.querySelector('[role="status"]')?.textContent).toContain(
			"Finish onboarding on the other device",
		);
	});

	it("keeps a naming warning visible after the device leaves the list", async () => {
		const api = fakeApi({
			review: vi.fn(async () => ({
				message: "Approval was sent, but naming did not finish. You do not need to approve again.",
				tone: "warning" as const,
			})),
		});
		await show([row()], api);
		await act(async () => mount.querySelector("button")?.click());
		await act(async () => {});

		await act(() => render(<DevicesToReview api={api} onDone={vi.fn()} rows={[]} />, mount));

		expect(mount.querySelector('[role="alert"]')?.textContent).toContain("naming did not finish");
	});
});
