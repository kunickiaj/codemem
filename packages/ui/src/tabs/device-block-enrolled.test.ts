import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_READ_DEADLINE_MS } from "../lib/read-request";
import { confirmAndBlockEnrolledDevice } from "./device-block-enrolled";

const device = { deviceId: "fixture-device", displayName: "Travel laptop" };
const path = `/api/sync/devices/${device.deviceId}`;
const keyId = "a".repeat(64);

function pendingCommit() {
	let resolve!: (response: Response) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Response>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function blockTransport(commit: Promise<Response>) {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({
				device_id: device.deviceId,
				group_id: "fixture-group",
				key_id: keyId,
				coordinator_origin: "https://coordinator.example.test",
				expected_digest: "b".repeat(64),
			}),
		)
		.mockResolvedValueOnce(Response.json({ coordinator_id: "fixture-coordinator", key_id: keyId }))
		.mockReturnValueOnce(commit);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

function expectOneCommit(fetch: ReturnType<typeof blockTransport>) {
	expect(fetch.mock.calls.map(([url]) => url)).toEqual([
		`${path}/remove/preview`,
		`${path}/block-enrolled/preview`,
		`${path}/block-enrolled`,
	]);
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it.each(["blocked", "removed-but-block-refused"] as const)(
	"retains a %s reply after the read deadline without dispatching another mutation",
	async (state) => {
		vi.useFakeTimers();
		const commit = pendingCommit();
		const fetch = blockTransport(commit.promise);
		const settled = vi.fn();
		const result = confirmAndBlockEnrolledDevice(device, async () => true).then((outcome) => {
			settled(outcome);
			return outcome;
		});

		await vi.advanceTimersByTimeAsync(0);
		expectOneCommit(fetch);
		await vi.advanceTimersByTimeAsync(DEFAULT_READ_DEADLINE_MS + 1);
		expect(settled).not.toHaveBeenCalled();

		commit.resolve(Response.json({ state }));
		await expect(result).resolves.toBe(state);
		await vi.advanceTimersByTimeAsync(DEFAULT_READ_DEADLINE_MS);
		expect(settled).toHaveBeenCalledExactlyOnceWith(state);
		expectOneCommit(fetch);
	},
);

it("reports an actual lost commit reply as unknown without retrying", async () => {
	vi.useFakeTimers();
	const commit = pendingCommit();
	const fetch = blockTransport(commit.promise);
	const result = confirmAndBlockEnrolledDevice(device, async () => true);
	await vi.advanceTimersByTimeAsync(0);
	expectOneCommit(fetch);
	commit.reject(new Error("Synthetic lost connection"));
	await expect(result).resolves.toBe("unknown");
	expectOneCommit(fetch);
});
