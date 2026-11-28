// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeviceJoinRequest,
	DeviceJoinRequests,
	type DeviceJoinRequestsApi,
	defaultDeviceJoinRequestsApi,
} from "./device-join-requests";

const mocks = vi.hoisted(() => ({
	loadCoordinatorAdminGroupsFiltered: vi.fn(),
	loadCoordinatorAdminJoinRequests: vi.fn(),
	loadCoordinatorAdminStatus: vi.fn(),
	reviewCoordinatorAdminJoinRequest: vi.fn(),
}));

vi.mock("../lib/api/coordinator-admin", () => mocks);

let mount: HTMLElement;

beforeEach(() => {
	vi.resetAllMocks();
	mount = document.createElement("div");
	document.body.append(mount);
});

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

function joinRequest(overrides: Partial<DeviceJoinRequest> = {}): DeviceJoinRequest {
	return {
		requestId: "request-a",
		groupId: "group-a",
		deviceId: "device-a",
		displayName: "Travel laptop",
		fingerprint: "fingerprint-a",
		...overrides,
	};
}

function fakeApi(
	requests: DeviceJoinRequest[],
	overrides: Partial<DeviceJoinRequestsApi> = {},
): DeviceJoinRequestsApi {
	return {
		load: vi.fn(async () => ({ requests, failedGroups: 0 })),
		review: vi.fn(async () => ({ setupWarning: false })),
		...overrides,
	};
}

async function show(api: DeviceJoinRequestsApi, props: { onReviewed?: () => unknown } = {}) {
	await act(() => render(<DeviceJoinRequests api={api} openRevision={1} {...props} />, mount));
	await act(async () => {});
}

function refreshButton() {
	return [...mount.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
		/^Refresh/.test(item.textContent ?? ""),
	);
}

function button(label: string): HTMLButtonElement {
	const found = mount.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (!found) throw new Error(`Missing button ${label}`);
	return found;
}

describe("Devices join requests", () => {
	it("shows nothing when this Viewer cannot administer the coordinator", async () => {
		await show(fakeApi([], { load: vi.fn(async () => null) }));

		expect(mount.textContent).toBe("");
	});

	it("says no request is waiting and still offers a refresh", async () => {
		await show(fakeApi([]));

		expect(mount.textContent).toContain("No join requests are waiting.");
		expect(refreshButton()?.disabled).toBe(false);
	});

	it("lists each waiting device with its details and the number of requests", async () => {
		await show(
			fakeApi([
				joinRequest(),
				joinRequest({ requestId: "request-b", deviceId: "device-b", displayName: "" }),
			]),
		);

		expect(mount.querySelector("h3")?.textContent).toContain("Join requests");
		expect(mount.querySelector("h3")?.textContent).toContain("2");
		expect(mount.textContent).toContain("Travel laptop");
		expect(mount.textContent).toContain("Unnamed device");
		expect(mount.textContent).toContain("Device ID device-a");
		expect(mount.textContent).toContain("Fingerprint fingerprint-a");
		expect(mount.textContent).not.toContain("Group group-a");
		expect(button("Approve join request from Travel laptop")).toBeTruthy();
		expect(button("Deny join request from Unnamed device")).toBeTruthy();
	});

	it("names the group on each row when requests come from more than one group", async () => {
		await show(
			fakeApi([joinRequest(), joinRequest({ requestId: "request-b", groupId: "group-b" })]),
		);

		expect(mount.textContent).toContain("Group group-a");
		expect(mount.textContent).toContain("Group group-b");
	});
});

describe("Devices join request review", () => {
	it("approves a request, reports it, refreshes Devices and moves focus to the status", async () => {
		const requests = [joinRequest()];
		const api = fakeApi(requests, {
			load: vi
				.fn()
				.mockResolvedValueOnce({ requests, failedGroups: 0 })
				.mockResolvedValue({ requests: [], failedGroups: 0 }),
		});
		const onReviewed = vi.fn(async () => true);
		await show(api, { onReviewed });

		await act(async () => button("Approve join request from Travel laptop").click());
		await act(async () => {});

		expect(api.review).toHaveBeenCalledExactlyOnceWith("request-a", "approve");
		expect(onReviewed).toHaveBeenCalledOnce();
		expect(api.load).toHaveBeenCalledTimes(2);
		const status = mount.querySelector<HTMLElement>('[role="status"]');
		expect(status?.textContent).toBe("Approved Travel laptop.");
		expect(status?.dataset.tone).toBe("success");
		await vi.waitFor(() => expect(document.activeElement).toBe(status));
		expect(mount.querySelector("li")).toBeNull();
	});

	it("denies a request", async () => {
		const api = fakeApi([joinRequest()]);
		await show(api);

		await act(async () => button("Deny join request from Travel laptop").click());
		await act(async () => {});

		expect(api.review).toHaveBeenCalledExactlyOnceWith("request-a", "deny");
		expect(mount.querySelector('[role="status"]')?.textContent).toBe("Denied Travel laptop.");
	});

	it("says when approval left the default group access unset", async () => {
		const api = fakeApi([joinRequest()], {
			review: vi.fn(async () => ({ setupWarning: true })),
		});
		await show(api);

		await act(async () => button("Approve join request from Travel laptop").click());
		await act(async () => {});

		const status = mount.querySelector<HTMLElement>('[role="status"]');
		expect(status?.textContent).toBe(
			"Approved Travel laptop, but its default group access could not be set up. Check the coordinator connection.",
		);
		expect(status?.dataset.tone).toBe("warning");
	});

	it.each([
		"join request not found: request-a",
		"Remote coordinator request failed (404): request_not_found",
	])("refreshes the list when the request no longer exists (%s)", async (message) => {
		const api = fakeApi([joinRequest()], {
			review: vi.fn(async () => {
				throw new Error(message);
			}),
		});
		await show(api);

		await act(async () => button("Approve join request from Travel laptop").click());
		await act(async () => {});

		expect(mount.querySelector('[role="status"]')?.textContent).toBe(
			"The join request from Travel laptop no longer exists. The list was refreshed.",
		);
		expect(api.load).toHaveBeenCalledTimes(2);
	});

	it("keeps the coordinator's detail out of the failure message and lets the person retry", async () => {
		const api = fakeApi([joinRequest()], {
			review: vi.fn(async () => {
				throw new Error("private coordinator detail");
			}),
		});
		await show(api);

		await act(async () => button("Deny join request from Travel laptop").click());
		await act(async () => {});

		const status = mount.querySelector('[role="status"]');
		expect(status?.textContent).toBe(
			"Could not deny Travel laptop. Check the coordinator connection and try again.",
		);
		expect(mount.textContent).not.toContain("private coordinator detail");
		expect(button("Deny join request from Travel laptop").disabled).toBe(false);
	});

	it("disables every row while one review is running", async () => {
		let finish: (value: { setupWarning: boolean }) => void = () => {};
		const api = fakeApi(
			[joinRequest(), joinRequest({ requestId: "request-b", displayName: "Desktop" })],
			{
				review: vi.fn(
					() =>
						new Promise<{ setupWarning: boolean }>((resolve) => {
							finish = resolve;
						}),
				),
			},
		);
		await show(api);

		await act(async () => button("Approve join request from Travel laptop").click());

		expect(button("Approve join request from Desktop").disabled).toBe(true);
		expect(button("Deny join request from Travel laptop").disabled).toBe(true);
		await act(async () => {
			finish({ setupWarning: false });
		});
	});
});

describe("Devices join request reload failure", () => {
	it("keeps the approval result and its access warning when the reload fails", async () => {
		const requests = [joinRequest()];
		const api = fakeApi(requests, {
			load: vi
				.fn()
				.mockResolvedValueOnce({ requests, failedGroups: 0 })
				.mockRejectedValueOnce(new Error("coordinator down"))
				.mockResolvedValue({ requests: [], failedGroups: 0 }),
			review: vi.fn(async () => ({ setupWarning: true })),
		});
		await show(api);

		await act(async () => button("Approve join request from Travel laptop").click());
		await act(async () => {});

		const statuses = [...mount.querySelectorAll<HTMLElement>('[role="status"]')];
		expect(statuses[0]?.textContent).toBe(
			"Approved Travel laptop, but its default group access could not be set up. Check the coordinator connection.",
		);
		expect(statuses[0]?.dataset.tone).toBe("warning");
		expect(statuses[1]?.textContent).toBe(
			"Could not reload join requests after this review. Check the coordinator connection, then select Retry.",
		);
		await vi.waitFor(() => expect(document.activeElement).toBe(statuses[0]));

		await act(async () => {
			[...mount.querySelectorAll("button")].find((item) => item.textContent === "Retry")?.click();
		});
		await act(async () => {});
		expect(mount.textContent).not.toContain("Could not reload join requests");
	});
});

describe("Devices join request loading", () => {
	it("offers a retry when the requests cannot be loaded", async () => {
		const requests = [joinRequest()];
		const api = fakeApi(requests, {
			load: vi
				.fn()
				.mockRejectedValueOnce(new Error("coordinator down"))
				.mockResolvedValue({ requests, failedGroups: 0 }),
		});
		await show(api);

		expect(mount.textContent).toContain("Could not load join requests.");
		await act(async () => {
			[...mount.querySelectorAll("button")].find((item) => item.textContent === "Retry")?.click();
		});
		await act(async () => {});

		expect(api.load).toHaveBeenCalledTimes(2);
		expect(mount.textContent).toContain("Travel laptop");
	});

	it("reports groups that could not be read while showing the others", async () => {
		await show(
			fakeApi([], {
				load: vi.fn(async () => ({ requests: [joinRequest()], failedGroups: 1 })),
			}),
		);

		expect(mount.textContent).toContain("Some join requests could not be loaded.");
		expect(mount.textContent).toContain("Travel laptop");
	});

	it("reads the requests when the person opens Devices, not when Devices refreshes", async () => {
		const api = fakeApi([joinRequest()]);
		await show(api);

		// A Devices refresh renders the same section again with the same open revision.
		await act(() => render(<DeviceJoinRequests api={api} openRevision={1} />, mount));
		await act(async () => {});
		expect(api.load).toHaveBeenCalledTimes(1);

		await act(() => render(<DeviceJoinRequests api={api} openRevision={2} />, mount));
		await act(async () => {});
		expect(api.load).toHaveBeenCalledTimes(2);
	});

	it("reads again from Refresh join requests and disables it while reading", async () => {
		let finish: (value: { requests: DeviceJoinRequest[]; failedGroups: number }) => void = () => {};
		const api = fakeApi([joinRequest()], {
			load: vi
				.fn()
				.mockResolvedValueOnce({ requests: [], failedGroups: 0 })
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finish = resolve;
						}),
				),
		});
		await show(api);
		expect(mount.textContent).toContain("No join requests are waiting.");

		await act(async () => refreshButton()?.click());
		expect(refreshButton()?.textContent).toBe("Refreshing…");
		expect(refreshButton()?.disabled).toBe(true);

		await act(async () => finish({ requests: [joinRequest()], failedGroups: 0 }));
		expect(refreshButton()?.textContent).toBe("Refresh join requests");
		expect(mount.textContent).toContain("Travel laptop");
		expect(api.load).toHaveBeenCalledTimes(2);
	});
});

describe("default join request source", () => {
	const signal = new AbortController().signal;

	it.each([
		["setup is incomplete", { readiness: "partial", has_admin_secret: true, groups: ["g"] }],
		["there is no admin secret", { readiness: "ready", has_admin_secret: false, groups: ["g"] }],
	])("returns nothing when %s", async (_name, status) => {
		mocks.loadCoordinatorAdminStatus.mockResolvedValue(status);

		await expect(defaultDeviceJoinRequestsApi.load(signal)).resolves.toBeNull();
		expect(mocks.loadCoordinatorAdminJoinRequests).not.toHaveBeenCalled();
	});

	it("asks for each group the coordinator lists and counts the groups it could not read", async () => {
		mocks.loadCoordinatorAdminStatus.mockResolvedValue({
			readiness: "ready",
			has_admin_secret: true,
			groups: ["group-a"],
		});
		mocks.loadCoordinatorAdminGroupsFiltered.mockResolvedValue({
			items: [
				{ group_id: "group-a" },
				{ group_id: "group-b" },
				{ group_id: "group-c" },
				{ group_id: "group-old", archived_at: "2026-01-01T00:00:00Z" },
			],
		});
		mocks.loadCoordinatorAdminJoinRequests.mockImplementation(async (groupId: string) => {
			if (groupId === "group-b") throw new Error("coordinator down");
			return {
				items: [
					{
						request_id: `${groupId}-request`,
						device_id: `${groupId}-device`,
						display_name: " Laptop ",
					},
					{ device_id: "no-request-id" },
				],
			};
		});

		const loaded = await defaultDeviceJoinRequestsApi.load(signal);

		expect(mocks.loadCoordinatorAdminJoinRequests.mock.calls.map(([groupId]) => groupId)).toEqual([
			"group-a",
			"group-b",
			"group-c",
		]);
		expect(loaded?.failedGroups).toBe(1);
		expect(loaded?.requests).toEqual([
			{
				requestId: "group-a-request",
				groupId: "group-a",
				deviceId: "group-a-device",
				displayName: "Laptop",
				fingerprint: "",
			},
			{
				requestId: "group-c-request",
				groupId: "group-c",
				deviceId: "group-c-device",
				displayName: "Laptop",
				fingerprint: "",
			},
		]);
	});

	it("falls back to the configured groups and reports the gap when the group list fails", async () => {
		mocks.loadCoordinatorAdminStatus.mockResolvedValue({
			readiness: "ready",
			has_admin_secret: true,
			groups: ["group-a"],
		});
		mocks.loadCoordinatorAdminGroupsFiltered.mockRejectedValue(new Error("coordinator down"));
		mocks.loadCoordinatorAdminJoinRequests.mockResolvedValue({ items: [] });

		const loaded = await defaultDeviceJoinRequestsApi.load(signal);

		expect(mocks.loadCoordinatorAdminJoinRequests.mock.calls.map(([groupId]) => groupId)).toEqual([
			"group-a",
		]);
		expect(loaded).toEqual({ requests: [], failedGroups: 1 });
	});

	it("reads every group the coordinator lists, in batches, past the tenth", async () => {
		const groups = Array.from({ length: 23 }, (_, index) => `group-${index + 1}`);
		mocks.loadCoordinatorAdminStatus.mockResolvedValue({
			readiness: "ready",
			has_admin_secret: true,
			groups: ["group-1"],
		});
		mocks.loadCoordinatorAdminGroupsFiltered.mockResolvedValue({
			items: groups.map((group_id) => ({ group_id })),
		});
		let running = 0;
		let mostAtOnce = 0;
		mocks.loadCoordinatorAdminJoinRequests.mockImplementation(async (groupId: string) => {
			running += 1;
			mostAtOnce = Math.max(mostAtOnce, running);
			await Promise.resolve();
			running -= 1;
			return {
				items: groupId === "group-23" ? [{ request_id: "late-request", device_id: "late" }] : [],
			};
		});

		const loaded = await defaultDeviceJoinRequestsApi.load(signal);

		expect(mocks.loadCoordinatorAdminJoinRequests).toHaveBeenCalledTimes(23);
		expect(loaded?.requests).toEqual([
			{
				requestId: "late-request",
				groupId: "group-23",
				deviceId: "late",
				displayName: "",
				fingerprint: "",
			},
		]);
		expect(loaded?.failedGroups).toBe(0);
		expect(mostAtOnce).toBeLessThanOrEqual(5);
	});

	it("fails when no group can be read", async () => {
		mocks.loadCoordinatorAdminStatus.mockResolvedValue({
			readiness: "ready",
			has_admin_secret: true,
			groups: ["group-a"],
		});
		mocks.loadCoordinatorAdminGroupsFiltered.mockResolvedValue({
			items: [{ group_id: "group-a" }],
		});
		mocks.loadCoordinatorAdminJoinRequests.mockRejectedValue(new Error("coordinator down"));

		await expect(defaultDeviceJoinRequestsApi.load(signal)).rejects.toThrow();
	});

	it("reports whether approval left default access unset", async () => {
		mocks.reviewCoordinatorAdminJoinRequest.mockResolvedValue({
			setup_warning: { step: "default_space_grant" },
		});

		await expect(defaultDeviceJoinRequestsApi.review("request-a", "approve")).resolves.toEqual({
			setupWarning: true,
		});
		expect(mocks.reviewCoordinatorAdminJoinRequest).toHaveBeenCalledWith("request-a", "approve");
	});
});
