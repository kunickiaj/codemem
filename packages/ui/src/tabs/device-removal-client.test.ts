import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READ_DEADLINE_MS } from "../lib/read-request";
import {
	confirmAndCommitDeviceRemoval,
	DeviceRemovalCommitError,
	type DeviceRemovalResult,
} from "./device-removal-confirmation";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

vi.mock("./sync/sync-dialogs", () => ({ openSyncConfirmDialog: vi.fn() }));

const device = { deviceId: "old/laptop ?#", displayName: "Old laptop" };
const preview = {
	device_id: device.deviceId,
	rejoin: "invitation",
	expected_digest: "a".repeat(64),
	key_id: null,
	coordinator_origin: "https://coordinator.example",
};
const result: DeviceRemovalResult = {
	state: "removed",
	removal_id: "removal-1",
	removal_seq: 1,
	evidence: "receipt",
	local_cleanup: "applied",
	refresh_pending: false,
};

beforeEach(() => {
	vi.mocked(openSyncConfirmDialog).mockReset().mockResolvedValue(true);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected request")));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function mockResponses(commitResponse: Response | Promise<Response>) {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(preview))
		.mockImplementationOnce(() => commitResponse);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

describe("confirmAndCommitDeviceRemoval", () => {
	it("uses the default requests and commits exactly the confirmed coordinator and digest", async () => {
		const fetch = mockResponses(Response.json({ ...result, progress: { done: 0, total: 2 } }));
		const confirm = vi.fn(async () => {
			expect(fetch).toHaveBeenCalledTimes(1);
			return true;
		});

		expect(await confirmAndCommitDeviceRemoval(device, { confirm })).toEqual({
			...result,
			progress: null,
		});
		expect(confirm).toHaveBeenCalledOnce();
		expect(openSyncConfirmDialog).not.toHaveBeenCalled();
		expect(fetch.mock.calls).toEqual([
			[
				"/api/sync/devices/old%2Flaptop%20%3F%23/remove/preview",
				{ method: "POST", signal: expect.any(AbortSignal) },
			],
			[
				"/api/sync/devices/old%2Flaptop%20%3F%23/remove",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						coordinator_origin: preview.coordinator_origin,
						expected_digest: preview.expected_digest,
					}),
				},
			],
		]);
	});

	it("preserves verified removal when cleanup or refresh is pending", async () => {
		const deferred = {
			...result,
			evidence: "listing",
			local_cleanup: "deferred",
			refresh_pending: true,
		};
		mockResponses(Response.json(deferred));
		expect(await confirmAndCommitDeviceRemoval(device)).toEqual(deferred);
	});

	it("commits the reviewed device even when the selection changes in the dialog", async () => {
		const fetch = mockResponses(Response.json(result));
		const selection = { ...device };
		await confirmAndCommitDeviceRemoval(selection, {
			confirm: async () => {
				selection.deviceId = "replacement";
				return true;
			},
		});
		expect(fetch.mock.calls[1]?.[0]).toBe(
			`/api/sync/devices/${encodeURIComponent(device.deviceId)}/remove`,
		);
	});

	it("returns null on injected cancellation without committing", async () => {
		const fetch = mockResponses(Response.json(result));
		expect(await confirmAndCommitDeviceRemoval(device, { confirm: async () => false })).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not commit when the preview is invalid", async () => {
		const fetch = vi.fn().mockResolvedValue(Response.json({ ...preview, expected_digest: "bad" }));
		vi.stubGlobal("fetch", fetch);
		await expect(confirmAndCommitDeviceRemoval(device)).rejects.toMatchObject({
			code: "device_removal_preview_invalid",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(openSyncConfirmDialog).not.toHaveBeenCalled();
	});

	it.each(["removal_preview_stale", "coordinator_admin_required", "removal_outcome_unknown"])(
		"preserves the server's fixed %s code without retrying",
		async (code) => {
			const fetch = mockResponses(Response.json({ error: code }, { status: 409 }));
			await expect(confirmAndCommitDeviceRemoval(device)).rejects.toMatchObject({
				code,
				statusCode: 409,
			});
			expect(fetch).toHaveBeenCalledTimes(2);
		},
	);

	it("reports a lost response as unknown without retrying", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json(preview))
			.mockRejectedValueOnce(new Error("Connection lost"));
		vi.stubGlobal("fetch", fetch);
		await expect(confirmAndCommitDeviceRemoval(device)).rejects.toMatchObject({
			code: "removal_outcome_unknown",
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		new Response("malformed"),
		new Response("malformed", { status: 503 }),
		Response.json({ error: "untrusted_server_text" }, { status: 503 }),
		Response.json(result, { status: 202 }),
		Response.json(null),
		Response.json([]),
		Response.json({ ...result, state: "rejected" }),
		Response.json({ ...result, removal_id: "" }),
		Response.json({ ...result, removal_seq: 0 }),
		Response.json({ ...result, removal_seq: 1.5 }),
		Response.json({ ...result, removal_seq: Number.MAX_SAFE_INTEGER + 1 }),
		Response.json({ ...result, evidence: "unverified" }),
		Response.json({ ...result, local_cleanup: "failed" }),
		Response.json({ ...result, refresh_pending: undefined }),
	])("reports an unverifiable response as unknown: %#", async (response) => {
		const fetch = mockResponses(response);
		const pending = confirmAndCommitDeviceRemoval(device);
		await expect(pending).rejects.toBeInstanceOf(DeviceRemovalCommitError);
		await expect(pending).rejects.toMatchObject({ code: "removal_outcome_unknown" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

it.each([
	["coordinator_update_required", 503],
	["device_removal_unavailable", 503],
	["coordinator_admin_required", 409],
] as const)(
	"preserves a refused preview's %s code without opening confirmation",
	async (code, statusCode) => {
		const fetch = vi.fn().mockResolvedValue(Response.json({ error: code }, { status: statusCode }));
		vi.stubGlobal("fetch", fetch);

		await expect(confirmAndCommitDeviceRemoval(device)).rejects.toMatchObject({
			code,
			statusCode,
		});
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			"/api/sync/devices/old%2Flaptop%20%3F%23/remove/preview",
			{ method: "POST", signal: expect.any(AbortSignal) },
		);
		expect(openSyncConfirmDialog).not.toHaveBeenCalled();
	},
);

it.each([
	new Response("Service temporarily unavailable", { status: 503 }),
	Response.json({ error: "private_server_detail" }, { status: 503 }),
])("keeps unrecognized preview failures out of user-facing codes: %#", async (response) => {
	const fetch = vi.fn().mockResolvedValue(response);
	vi.stubGlobal("fetch", fetch);
	await expect(confirmAndCommitDeviceRemoval(device)).rejects.toMatchObject({
		code: "device_removal_unavailable",
		statusCode: 503,
	});
	expect(fetch).toHaveBeenCalledOnce();
	expect(openSyncConfirmDialog).not.toHaveBeenCalled();
});

it("keeps the preview read deadline without confirming or retrying", async () => {
	vi.useFakeTimers();
	const fetch = vi.fn(() => new Promise<Response>(() => {}));
	vi.stubGlobal("fetch", fetch);
	try {
		const outcome = expect(confirmAndCommitDeviceRemoval(device)).rejects.toMatchObject({
			code: "device_removal_unavailable",
		});
		await vi.advanceTimersByTimeAsync(DEFAULT_READ_DEADLINE_MS + 1);
		await outcome;
		expect(fetch).toHaveBeenCalledOnce();
		expect(openSyncConfirmDialog).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});
