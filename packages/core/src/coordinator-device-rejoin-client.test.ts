import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { runDeviceRejoin } from "./coordinator-device-rejoin-client.js";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	status: vi.fn(),
	finalize: vi.fn(),
	close: vi.fn(),
	deliver: vi.fn(),
}));
const origin = "https://coordinator.example.test";
const destination = "http://127.0.0.1:4321/codemem/auth/complete";
const now = 1_791_028_800_000;
const receipt = { attemptId: "attempt-a", deviceId: "device-a", groupIds: ["group-a"] };
const browserDelivery = {
	kind: "confirmed",
	completionSecret: Buffer.alloc(32, 3).toString("base64url"),
	confirmationHash: "a".repeat(64),
};
vi.mock("./coordinator-device-rejoin-client-requests.js", () => ({
	createDeviceRejoinRequests: async () => ({ origin, ...mocks }),
}));
vi.mock("./coordinator-account-link-receiver.js", () => ({
	createCoordinatorDeviceRejoinReceiver: async () => ({
		destination,
		completion: Promise.resolve(mocks.deliver()),
		close: mocks.close,
	}),
}));

beforeEach(() => {
	vi.resetAllMocks();
	mocks.start.mockImplementation(async ({ attemptId }) => ({
		kind: "started",
		pins: { attemptId, expiresAtMs: now + 600_000 },
	}));
	mocks.status.mockResolvedValue({ kind: "status", state: "confirmed" });
	mocks.finalize.mockResolvedValue({ kind: "finalized", receipt });
	mocks.close.mockResolvedValue(undefined);
	mocks.deliver.mockReturnValue(browserDelivery);
});

function run(overrides: Partial<Parameters<typeof runDeviceRejoin>[0]> = {}) {
	return runDeviceRejoin({
		dbPath: "fixture.sqlite",
		coordinatorUrl: origin,
		now: () => now,
		openBrowser: () => {},
		...overrides,
	});
}

it("opens the bound start link and finalizes only after a signed confirmed status", async () => {
	const openBrowser = vi.fn((link: string) => {
		const url = new URL(link);
		expect(url.origin).toBe(origin);
		expect(url.pathname).toBe("/auth/rejoin/start");
		const sent = mocks.start.mock.calls[0]?.[0];
		expect(url.searchParams.get("attempt_id")).toBe(sent.attemptId);
		const code = Buffer.from(url.searchParams.get("start_code") ?? "", "base64url");
		expect(code).toHaveLength(32);
		expect(createHash("sha256").update(code).digest("hex")).toBe(sent.browserStartHash);
		expect(sent.loopbackRedirect).toBe(destination);
	});
	expect(await run({ openBrowser })).toEqual({ kind: "finalized", receipt });
	expect(openBrowser).toHaveBeenCalledOnce();
	expect(mocks.status.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.finalize.mock.invocationCallOrder[0] ?? 0,
	);
	expect(mocks.finalize.mock.calls[0]?.[1]).toEqual(browserDelivery);
	expect(mocks.close).toHaveBeenCalledOnce();
});

it("does not open the browser or retry a start that was not confirmed", async () => {
	const openBrowser = vi.fn();
	mocks.start.mockResolvedValueOnce({ kind: "unknown" });
	expect(await run({ openBrowser })).toEqual({ kind: "failed", error: "start_unconfirmed" });
	expect(mocks.start).toHaveBeenCalledOnce();
	expect(openBrowser).not.toHaveBeenCalled();
	expect(mocks.finalize).not.toHaveBeenCalled();
	expect(mocks.close).toHaveBeenCalledOnce();
});

it("does not write when a refusal returns through loopback", async () => {
	mocks.deliver.mockReturnValueOnce({ kind: "refused", reason: "wrong_account" });
	expect(await run()).toEqual({ kind: "refused", reason: "wrong_account" });
	expect(mocks.status).not.toHaveBeenCalled();
	expect(mocks.finalize).not.toHaveBeenCalled();
});

it("does not finalize with an unconfirmed or elapsed reviewed attempt", async () => {
	mocks.status.mockResolvedValueOnce({ kind: "status", state: "oidc_verified" });
	expect(await run()).toEqual({ kind: "failed", error: "review_unavailable" });
	mocks.status.mockResolvedValueOnce({ kind: "status", state: "confirmed" });
	let time = now;
	expect(
		await run({
			now: () => time,
			openBrowser: () => {
				time += 600_000;
			},
		}),
	).toEqual({ kind: "failed", error: "review_unavailable" });
	expect(mocks.finalize).not.toHaveBeenCalled();
});

it.each([
	[
		{ kind: "status", state: "finalized", receipt },
		{ kind: "finalized", receipt },
	],
	[{ kind: "status", state: "confirmed" }, { kind: "unknown" }],
] as const)(
	"checks live status after lost finalize without resending",
	async (status, expected) => {
		mocks.finalize.mockResolvedValueOnce({ kind: "unknown" });
		mocks.status
			.mockResolvedValueOnce({ kind: "status", state: "confirmed" })
			.mockResolvedValueOnce(status);
		expect(await run()).toEqual(expected);
		expect(mocks.status).toHaveBeenCalledTimes(2);
		expect(mocks.finalize).toHaveBeenCalledOnce();
		expect(mocks.close).toHaveBeenCalledOnce();
	},
);
