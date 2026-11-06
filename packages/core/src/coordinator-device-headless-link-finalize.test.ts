import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";
import {
	ATTEMPT,
	approveInBrowser,
	createBody,
	finalizeBody,
	type HeadlessDeviceFixture,
	linkRows,
	NOW,
	ROOT,
	SUBJECT,
	setupHeadlessDevice,
} from "./coordinator-device-headless-link-test-fixtures.js";

const fixtures: HeadlessDeviceFixture[] = [];
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const f of fixtures.splice(0)) if (f.db.open) f.db.close();
	}
});

const STATUS = `${ROOT}/${ATTEMPT}?group_id=group-a`;
const FINALIZE = `${ROOT}/${ATTEMPT}/finalize`;

/** A created attempt; with `approved`, the person has also approved it in the browser. */
async function setup(backend: Backend, options: { approved?: boolean; readLimit?: number } = {}) {
	const f = await setupHeadlessDevice(backend, { readLimit: options.readLimit });
	fixtures.push(f);
	expect((await f.signed(f.keyA, "POST", ROOT, await createBody())).status).toBe(201);
	if (options.approved) expect((await approveInBrowser(f)).approved?.status).toBe(200);
	return f;
}

function registerStatus(backend: Backend) {
	describe(`${backend} headless status route`, () => {
		it("returns no approval before the person approves", async () => {
			// Arrange
			const f = await setup(backend);
			// Act
			const response = await f.signed(f.keyA, "GET", STATUS);
			// Assert
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				status: { attemptId: ATTEMPT, state: "pending", expiresAtMs: NOW + 600_000 },
				poll_interval_s: 5,
				approval: null,
			});
		});

		it("names the verified account once the person approves", async () => {
			// Arrange
			const f = await setup(backend, { approved: true });
			// Act
			const response = await f.signed(f.keyA, "GET", STATUS);
			// Assert
			expect(await response.json()).toEqual({
				status: { attemptId: ATTEMPT, state: "confirmed", expiresAtMs: NOW + 600_000 },
				poll_interval_s: 5,
				approval: {
					issuer: f.cfg.issuer,
					subject: SUBJECT,
					email: "ada@example.test",
					email_verified: true,
					display_name: "Ada Example",
				},
			});
		});

		it("hides the attempt from another enrolled device", async () => {
			// Arrange
			const f = await setup(backend, { approved: true });
			// Act
			const response = await f.signed(f.keyB, "GET", STATUS);
			// Assert
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain(SUBJECT);
		});

		it("tells a device that polls too fast when to retry", async () => {
			// Arrange
			const f = await setup(backend, { readLimit: 1 });
			await f.signed(f.keyA, "GET", STATUS);
			// Act
			const limited = await f.signed(f.keyA, "GET", STATUS);
			// Assert
			expect(limited.status).toBe(429);
			expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
			expect(await limited.json()).toEqual({
				error: "rate_limited",
				retry_after_s: Number(limited.headers.get("retry-after")),
			});
		});

		it("rejects any query beyond the one group_id", async () => {
			// Arrange
			const f = await setup(backend);
			// Act
			const response = await f.signed(f.keyA, "GET", `${STATUS}&extra=1`);
			// Assert
			expect(response.status).toBe(400);
		});
	});
}

function registerFinalize(backend: Backend) {
	describe(`${backend} headless finalize route`, () => {
		it("links the approved account and records that the link is headless", async () => {
			// Arrange
			const f = await setup(backend, { approved: true });
			// Act
			const response = await f.signed(f.keyA, "POST", FINALIZE, finalizeBody(f));
			const retried = await f.signed(f.keyA, "POST", FINALIZE, finalizeBody(f));
			// Assert
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ status: { state: "finalized" } });
			expect(retried.status).toBe(200);
			expect(linkRows(f)).toEqual([
				expect.objectContaining({
					subject: SUBJECT,
					identity_id: "identity-a",
					provenance_attempt: ATTEMPT,
				}),
			]);
		});

		it.each([
			["a different approved subject", { approved_subject: "subject-other" }, 403],
			["another issuer", { approved_issuer: "https://issuer.example.test" }, 400],
			["an extra field", { extra: "x" }, 400],
			["a missing approval", { approved_subject: undefined }, 400],
		])("writes no link for %s", async (_case, overrides, status) => {
			// Arrange
			const f = await setup(backend, { approved: true });
			// Act
			const response = await f.signed(f.keyA, "POST", FINALIZE, finalizeBody(f, overrides));
			// Assert
			expect(response.status).toBe(status);
			expect(linkRows(f)).toEqual([]);
		});

		it("refuses another device's signature", async () => {
			// Arrange
			const f = await setup(backend, { approved: true });
			const body = finalizeBody(f, { device_id: f.keyB.deviceId, fingerprint: f.keyB.fingerprint });
			// Act
			const response = await f.signed(f.keyB, "POST", FINALIZE, body);
			// Assert
			expect(response.status).toBe(403);
			expect(linkRows(f)).toEqual([]);
		});
	});
}

function registerDesktopRoutes(backend: Backend) {
	describe(`${backend} desktop routes on a headless attempt`, () => {
		it("never finalizes a headless attempt through the desktop finalize route", async () => {
			// Arrange
			const f = await setup(backend, { approved: true });
			const { approved_issuer: _i, approved_subject: _s, ...desktop } = finalizeBody(f);
			// Act
			const response = await f.signed(
				f.keyA,
				"POST",
				`/v1/auth/link-attempts/${ATTEMPT}/finalize`,
				desktop,
			);
			// Assert
			expect(response.status).toBe(403);
			expect(linkRows(f)).toEqual([]);
		});

		it("cancels a headless attempt through the shared cancel route", async () => {
			// Arrange
			const f = await setup(backend, { approved: true });
			// Act
			const cancelled = await f.signed(f.keyA, "POST", `/v1/auth/link-attempts/${ATTEMPT}/cancel`, {
				group_id: "group-a",
			});
			const finalized = await f.signed(f.keyA, "POST", FINALIZE, finalizeBody(f));
			// Assert
			expect(cancelled.status).toBe(200);
			expect(await cancelled.json()).toMatchObject({ status: { state: "failed" } });
			expect(finalized.status).toBe(403);
			expect(linkRows(f)).toEqual([]);
		});
	});
}

for (const backend of ["SQLite", "D1"] as const) {
	registerStatus(backend);
	registerFinalize(backend);
	registerDesktopRoutes(backend);
}
