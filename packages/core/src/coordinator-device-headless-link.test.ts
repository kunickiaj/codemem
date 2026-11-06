import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HEADLESS_CODE_LIMITS_TABLE,
	HEADLESS_LINK_PROVENANCE_TABLE,
} from "./coordinator-auth-headless-schema.js";
import { hashHeadlessUserCode } from "./coordinator-auth-link-headless.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";
import {
	ATTEMPT,
	createBody,
	type HeadlessDeviceFixture,
	NOW,
	ROOT,
	setupHeadlessDevice,
	signedHeaders,
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

async function setup(backend: Backend) {
	const f = await setupHeadlessDevice(backend);
	fixtures.push(f);
	return f;
}
const attempts = (f: HeadlessDeviceFixture) =>
	f.db.prepare("SELECT attempt_id, state FROM coordinator_auth_link_attempts").all();

function registerCreate(backend: Backend) {
	describe(`${backend} headless create route`, () => {
		it("creates an attempt and returns the code page and poll interval; exact retries match", async () => {
			// Arrange
			const f = await setup(backend);
			const body = await createBody();
			// Act
			const created = await f.signed(f.keyA, "POST", ROOT, body);
			const retried = await f.signed(f.keyA, "POST", ROOT, body);
			// Assert
			const expected = {
				status: { attemptId: ATTEMPT, state: "pending", expiresAtMs: NOW + 600_000 },
				identity_id: "identity-a",
				authority: "controller_attestation",
				coordinator_id: f.cfg.coordinatorId,
				verification_uri: "https://app.example.test/auth/link/device",
				poll_interval_s: 5,
			};
			expect(created.status).toBe(201);
			expect(await created.json()).toEqual(expected);
			expect(retried.status).toBe(200);
			expect(await retried.json()).toEqual(expected);
			expect(created.headers.get("cache-control")).toBe("no-store");
		});

		it.each([
			["an extra field", { extra: "x" }],
			["a missing field", { user_code_hash: undefined }],
			["a desktop start hash instead of a code hash", { browser_start_hash: "c".repeat(64) }],
			["a malformed code hash", { user_code_hash: "x" }],
			["an unknown authority", { authority: "admin" }],
			["a non-string field", { attempt_id: 7 }],
		])("rejects %s without writes", async (_case, overrides) => {
			// Arrange
			const f = await setup(backend);
			// Act
			const response = await f.signed(f.keyA, "POST", ROOT, await createBody(overrides));
			// Assert
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "auth_link_invalid_input" });
			expect(attempts(f)).toEqual([]);
		});

		it("reports a code held by another attempt so the device picks a new one", async () => {
			// Arrange
			const f = await setup(backend);
			await f.signed(f.keyA, "POST", ROOT, await createBody());
			// Act
			const collided = await f.signed(
				f.keyA,
				"POST",
				ROOT,
				await createBody({ attempt_id: "headless-b", runtime_verifier_hash: "8".repeat(64) }),
			);
			const freshCode = await f.signed(
				f.keyA,
				"POST",
				ROOT,
				await createBody({
					attempt_id: "headless-b",
					runtime_verifier_hash: "8".repeat(64),
					user_code_hash: await hashHeadlessUserCode("ZXWVTSRQ"),
				}),
			);
			// Assert
			expect(collided.status).toBe(409);
			expect(await collided.json()).toEqual({ error: "user_code_conflict" });
			expect(freshCode.status).toBe(201);
		});

		it("refuses an Identity or authority the signer does not hold", async () => {
			// Arrange
			const f = await setup(backend);
			// Act
			const otherIdentity = await f.signed(
				f.keyA,
				"POST",
				ROOT,
				await createBody({ identity_id: "identity-b" }),
			);
			const unreviewed = await f.signed(f.keyB, "POST", ROOT, await createBody());
			// Assert
			expect(otherIdentity.status).toBe(403);
			expect(await otherIdentity.json()).toEqual({ error: "auth_link_review_required" });
			expect(unreviewed.status).toBe(403);
			expect(attempts(f)).toEqual([]);
		});
	});
}

function registerGate(backend: Backend) {
	describe(`${backend} headless capability`, () => {
		it("reports not found on every route without the headless tables", async () => {
			// Arrange
			const f = await setup(backend);
			f.db.exec(
				`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}; DROP TABLE ${HEADLESS_LINK_PROVENANCE_TABLE};`,
			);
			// Act
			const responses = [
				await f.signed(f.keyA, "POST", ROOT, await createBody()),
				await f.signed(f.keyA, "GET", `${ROOT}/${ATTEMPT}?group_id=group-a`),
				await f.signed(f.keyA, "POST", `${ROOT}/${ATTEMPT}/finalize`, {}),
				await f.app.request(`https://app.example.test${ROOT}`, { method: "POST", body: "{}" }),
			];
			// Assert
			expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
			expect(attempts(f)).toEqual([]);
		});

		it("reports not found without a verified client address, like the code page", async () => {
			// Arrange
			const f = await setupHeadlessDevice(backend, { clientAddress: false });
			fixtures.push(f);
			// Act
			const created = await f.signed(f.keyA, "POST", ROOT, await createBody());
			const page = await f.app.request("https://app.example.test/auth/link/device");
			// Assert
			expect(created.status).toBe(404);
			expect(page.status).toBe(404);
			expect(attempts(f)).toEqual([]);
		});

		it("refuses unsigned and wrongly signed requests", async () => {
			// Arrange
			const f = await setup(backend);
			const body = JSON.stringify(await createBody());
			// Act
			const unsigned = await f.app.request(`https://app.example.test${ROOT}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			const forged = await f.app.request(`https://app.example.test${ROOT}`, {
				method: "POST",
				headers: {
					...signedHeaders(f.keyA, "POST", ROOT, body),
					"X-Opencode-Device": f.keyB.deviceId,
				},
				body,
			});
			// Assert
			expect(unsigned.status).toBe(401);
			expect(forged.status).toBe(401);
			expect(attempts(f)).toEqual([]);
		});
	});
}

for (const backend of ["SQLite", "D1"] as const) {
	registerCreate(backend);
	registerGate(backend);
}
