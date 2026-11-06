import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	APPROVAL,
	cancelled,
	created,
	createLocalDevice,
	EXPIRES,
	errorCode,
	fakeCoordinator,
	finalized,
	json,
	ORIGIN,
	polled,
	type Reply,
	runHeadless,
} from "./coordinator-account-link-headless-test-fixtures.js";
import { CoordinatorAccountLinkError } from "./coordinator-account-link-runtime.js";
import { hashHeadlessUserCode } from "./coordinator-auth-link-headless.js";
import { deviceKey, NOW } from "./coordinator-device-headless-link-test-fixtures.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));
vi.mock("node:timers/promises", async (importOriginal) => {
	const timers = await importOriginal<typeof import("node:timers/promises")>();
	return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

const key = deviceKey("device-a");
let local: ReturnType<typeof createLocalDevice>;
let waits: number[];
beforeEach(() => {
	local = createLocalDevice(key);
	waits = [];
	vi.mocked(delay).mockImplementation(async (ms) => {
		waits.push(Number(ms));
		return undefined;
	});
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	local.cleanup();
});

describe("headless link success", () => {
	it("shows the code, asks the person, and finalizes with the approved account", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("pending"), polled("browser_claimed"), polled("confirmed", APPROVAL)],
			finalize: [finalized],
		});
		// Act
		const { result, codes, states, approvals } = runHeadless(local, coordinator);
		// Assert
		const linked = await result;
		expect(linked).toMatchObject({ identityId: "identity-a", state: "finalized" });
		expect(states).toEqual(["pending", "browser_claimed", "confirmed"]);
		expect(approvals).toEqual([
			{
				issuer: APPROVAL.issuer,
				subject: APPROVAL.subject,
				email: APPROVAL.email,
				emailVerified: true,
				displayName: "Ada Example",
			},
		]);
		const [code] = codes;
		expect(code).toMatchObject({
			verificationUri: `${ORIGIN}/auth/link/device`,
			deviceId: "device-a",
			expiresAtMs: EXPIRES,
			fingerprint: `SHA256:${key.fingerprint.slice(0, 8)}...${key.fingerprint.slice(-8)}`,
		});
		expect(code?.code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
		const create = coordinator.calls[0]?.body ?? {};
		expect(create.user_code_hash).toBe(
			await hashHeadlessUserCode(code?.code.replace("-", "") ?? ""),
		);
		const final = coordinator.calls.at(-1)?.body ?? {};
		expect(final).toMatchObject({
			approved_issuer: APPROVAL.issuer,
			approved_subject: APPROVAL.subject,
			completion: final.runtime_verifier,
		});
		const verifier = Buffer.from(String(final.runtime_verifier), "base64url");
		expect(createHash("sha256").update(verifier).digest("hex")).toBe(create.runtime_verifier_hash);
		expect(waits).toEqual([5000, 5000, 5000]);
	});

	it("retries a lost finalize reply and accepts the finalized status", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("confirmed", APPROVAL), polled("finalized")],
			finalize: [() => Promise.reject(new Error("socket hang up")), finalized],
		});
		// Act
		const { result } = runHeadless(local, coordinator);
		// Assert
		await expect(result).resolves.toMatchObject({ state: "finalized" });
		expect(coordinator.routes()).toEqual(["create", "status", "finalize", "status", "finalize"]);
	});
});

describe("headless link refusal", () => {
	it("cancels the attempt when the person declines", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("confirmed", APPROVAL)],
			cancel: [cancelled],
		});
		// Act
		const { result } = runHeadless(local, coordinator, { approve: async () => false });
		// Assert
		expect(await errorCode(result)).toBe("link_declined");
		expect(coordinator.routes()).toEqual(["create", "status", "cancel"]);
		expect(coordinator.calls[2]?.body).toEqual({ group_id: "group-a" });
	});

	it("reports a coordinator rejection of the approved account and still cancels", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("confirmed", APPROVAL)],
			finalize: [() => json({ error: "auth_link_review_required" }, 403)],
			cancel: [() => json({ error: "auth_link_unavailable" }, 404)],
		});
		// Act
		const { result } = runHeadless(local, coordinator);
		// Assert
		expect(await errorCode(result)).toBe("review_required");
		expect(coordinator.routes()).toEqual(["create", "status", "finalize", "cancel"]);
	});

	it("rejects a confirmed status without an approval", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [created],
			status: [polled("confirmed", null)],
			cancel: [cancelled],
		});
		// Act
		const { result } = runHeadless(local, coordinator);
		// Assert
		expect(await errorCode(result)).toBe("invalid_response");
		expect(coordinator.routes()).toEqual(["create", "status", "cancel"]);
	});
});

describe("headless link create", () => {
	it("picks a fresh code and attempt id when the code is taken", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [() => json({ error: "user_code_conflict" }, 409), created],
			status: [polled("confirmed", APPROVAL)],
			finalize: [finalized],
		});
		// Act
		const { result, codes } = runHeadless(local, coordinator);
		// Assert
		await expect(result).resolves.toMatchObject({ state: "finalized" });
		const [first, second] = coordinator.calls.map((call) => call.body);
		expect(first?.attempt_id).not.toBe(second?.attempt_id);
		expect(first?.user_code_hash).not.toBe(second?.user_code_hash);
		expect(second?.user_code_hash).toBe(
			await hashHeadlessUserCode(codes[0]?.code.replace("-", "") ?? ""),
		);
	});

	it("gives up after repeated code conflicts without cancelling", async () => {
		// Arrange
		const coordinator = fakeCoordinator({
			create: [() => json({ error: "user_code_conflict" }, 409)],
		});
		// Act
		const { result, codes } = runHeadless(local, coordinator);
		// Assert
		expect(await errorCode(result)).toBe("user_code_conflict");
		expect(coordinator.routes()).toEqual(["create", "create", "create"]);
		expect(codes).toEqual([]);
	});

	it("reports a coordinator without headless support", async () => {
		// Arrange
		const coordinator = fakeCoordinator({ create: [() => json({ error: "not_found" }, 404)] });
		// Act
		const { result } = runHeadless(local, coordinator);
		// Assert
		const error = await result.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CoordinatorAccountLinkError);
		expect((error as CoordinatorAccountLinkError).message).toContain("migration 0043");
		expect(coordinator.routes()).toEqual(["create"]);
	});

	it.each([
		{
			name: "another origin",
			coordinatorUrl: ORIGIN,
			uri: "https://phish.example.test/auth/link/device",
		},
		{ name: "another path", coordinatorUrl: ORIGIN, uri: `${ORIGIN}/auth/link/start` },
		{ name: "a query", coordinatorUrl: ORIGIN, uri: `${ORIGIN}/auth/link/device?code=BCDFGHJK` },
		{ name: "a fragment", coordinatorUrl: ORIGIN, uri: `${ORIGIN}/auth/link/device#code` },
		{
			name: "credentials",
			coordinatorUrl: ORIGIN,
			uri: "https://user@coordinator.example.test/auth/link/device",
		},
		{
			name: "loopback http",
			coordinatorUrl: "http://127.0.0.1:8443",
			uri: "http://127.0.0.1:8443/auth/link/device",
		},
	])(
		"refuses a verification page with $name and shows no code",
		async ({ coordinatorUrl, uri }) => {
			// Arrange
			const elsewhere: Reply = async (body, attemptId) => {
				const reply = await created(body, attemptId).json();
				return json({ ...reply, verification_uri: uri }, 201);
			};
			const coordinator = fakeCoordinator({ create: [elsewhere], cancel: [cancelled] });
			// Act
			const { result, codes } = runHeadless(local, coordinator, { coordinatorUrl });
			// Assert
			expect(await errorCode(result)).toBe("invalid_response");
			expect(codes).toEqual([]);
			expect(coordinator.routes()).toEqual(["create", "cancel"]);
		},
	);
});
