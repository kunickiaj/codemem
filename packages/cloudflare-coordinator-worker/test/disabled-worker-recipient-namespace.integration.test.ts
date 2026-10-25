import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { createConfiguredCloudflareCoordinatorWorker } from "../src/index.js";
import {
	db,
	producer,
	reset,
	retain,
	state,
	timestamp,
} from "./owner-producer-consistency-test-fixtures.js";

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset();
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Kind = "team_member" | "add_device";
async function invitation(kind: Kind) {
	const p = await producer(kind);
	const invite = await db
		.prepare("SELECT token FROM coordinator_invites")
		.first<{ token: string }>();
	if (!invite) throw new Error("native invitation missing");
	return {
		p,
		body: {
			token: invite.token,
			invite_kind: kind,
			identity_id: p.subject.ownerIdentityId,
			device_id: p.subject.deviceId,
			public_key: p.subject.publicKey,
			fingerprint: p.subject.fingerprint,
		},
	};
}

function worker(config: Record<string, unknown> | undefined) {
	const bindings = {
		COORDINATOR_DB: db,
		...(config === undefined
			? {}
			: { CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(config) }),
	};
	return (path: string, init?: RequestInit) =>
		// A cold production factory per request also verifies retry configuration capture.
		createConfiguredCloudflareCoordinatorWorker().fetch(
			new Request(`https://app.example.test${path}`, init),
			bindings,
		);
}
function join(send: ReturnType<typeof worker>, body: Record<string, unknown>) {
	return send("/v1/join", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

for (const kind of ["team_member", "add_device"] as const) {
	it.each(["fresh", "retry"] as const)(
		`disabled configured Worker ${kind} accepts same-owner %s without a browser provider`,
		async (stage) => {
			// Arrange: real native same-owner resolution and its still-valid source authority.
			const { p, body } = await invitation(kind);
			await retain(p.subject);
			// Only the retry precondition uses the store directly, never the request under test.
			if (stage === "retry") expect(await p.run()).toMatchObject({ status: "accepted" });
			const send = worker({ enabled: false, coordinatorId: p.subject.coordinatorId });
			const consume = vi.spyOn(D1CoordinatorStore.prototype, "consumeRecipientInvite");
			// Act: unlike Core's manual authLink.config test, use actual configured Worker dispatch.
			const response = await join(send, body);
			const result = await response.json();
			// Assert: observe the real writer input, without substituting authorization or its result.
			expect
				.soft(consume)
				.toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ coordinatorId: p.subject.coordinatorId, token: body.token }),
				);
			expect.soft({ status: response.status, result }).toMatchObject({
				status: 200,
				result: { ok: true, status: stage === "fresh" ? "accepted" : "existing" },
			});
		},
	);

	for (const config of [
		undefined,
		{ enabled: false },
		{ enabled: false, coordinatorId: "" },
		{ enabled: false, coordinatorId: 42 },
	]) {
		it(`disabled Worker ${kind} rejects unknown namespace ${JSON.stringify(config)}`, async () => {
			// Arrange: a same-owner fact in another namespace cannot supply missing server metadata.
			const { p, body } = await invitation(kind);
			await retain(p.subject, { foreign: true, removeSource: true });
			const before = await state();
			// Act
			const response = await join(worker(config), body);
			// Assert: neither token, enrollment, grant nor authority changes on unavailable evidence.
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				error: "device_ownership_authorization_unavailable",
			});
			expect(await state()).toEqual(before);
		});
	}

	it(`disabled Worker ${kind} never trusts a client namespace in body, headers or query`, async () => {
		// Arrange: no server namespace; another namespace's facts still require unavailable status.
		const { p, body } = await invitation(kind);
		await retain(p.subject, { foreign: true, removeSource: true });
		const send = worker(undefined);
		const before = await state();
		// Act
		const extraField = await join(send, { ...body, coordinator_id: p.subject.coordinatorId });
		const spoofedTransport = await send(`/v1/join?coordinator_id=${p.subject.coordinatorId}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Codemem-Coordinator-Id": p.subject.coordinatorId,
			},
			body: JSON.stringify(body),
		});
		// Assert
		expect(extraField.status).toBe(400);
		expect(await extraField.json()).toEqual({ error: "unexpected_recipient_invite_fields" });
		expect(spoofedTransport.status).toBe(503);
		expect(await state()).toEqual(before);
	});

	it(`disabled configured Worker ${kind} never accepts another retained owner`, async () => {
		// Arrange
		const { p, body } = await invitation(kind);
		await retain({ ...p.subject, ownerIdentityId: "other-owner" });
		const before = await state();
		// Act
		const response = await join(
			worker({ enabled: false, coordinatorId: p.subject.coordinatorId }),
			body,
		);
		// Assert: another owner's valid receipt never authorizes the requested Identity.
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "device_ownership_authorization_unavailable" });
		expect(await state()).toEqual(before);
	});

	it(`old disabled-provider Worker ${kind} preserves fact-free legacy acceptance and retry`, async () => {
		// Arrange
		const { body } = await invitation(kind);
		const send = worker(undefined);
		// Act
		const first = await join(send, body);
		const retry = await join(send, body);
		// Assert: the namespace fix must not require browser setup for old fact-free invites.
		expect([first.status, retry.status]).toEqual([200, 200]);
		expect(await first.json()).toMatchObject({ ok: true, status: "accepted" });
		expect(await retry.json()).toMatchObject({ ok: true, status: "existing" });
	});
}

it("retaining a server namespace never enables disabled browser or owner enrollment routes", async () => {
	// Arrange
	const send = worker({ enabled: false, coordinatorId: "coordinator-a" });
	const before = await state();
	// Act
	const responses = await Promise.all(
		["/auth/sign-in", "/auth/owner/admit", "/v1/auth/owner-attempts"].map((path) => send(path)),
	);
	// Assert
	for (const response of responses) expect([404, 503]).toContain(response.status);
	expect(await state()).toEqual(before);
});
