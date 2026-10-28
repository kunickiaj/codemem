import { deepStrictEqual } from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import {
	expectNoConfirmation,
	recoveryFixture,
	recoveryTests,
	selectionFor,
} from "../../test/owner-recovery-service-fixture.js";
import { createAccountContextReader } from "../account/context.js";
import { createAccountLinkRegistry } from "../account/link-registry.js";
import { createAccountOwnerRecoveryService } from "../account/owner-recovery-service.js";
import type { RecoveryPreview } from "../account/owner-recovery-types.js";
import { createApp } from "../index.js";

recoveryTests();
const LOCAL = "http://127.0.0.1:7441";
const BASE = "/api/account/owner-recovery";
const paths = [BASE, `${BASE}/preview`, `${BASE}/confirm`, `${BASE}/import`];

async function setup(options: Parameters<typeof recoveryFixture>[0] = {}) {
	const f = await recoveryFixture(options);
	const readContext = vi.fn(f.readContext);
	const readAdminSecret = vi.fn(f.serviceOptions.readAdminSecret);
	const service = createAccountOwnerRecoveryService({
		...f.serviceOptions,
		readContext,
		readAdminSecret,
	});
	f.cleanup(() => service.close());
	const calls = {
		getProfile: vi.spyOn(service, "getProfile"),
		preview: vi.spyOn(service, "preview"),
		confirm: vi.spyOn(service, "confirm"),
		importReply: vi.spyOn(service, "importReply"),
	};
	let listener: { host: string; port: number } | null = { host: "127.0.0.1", port: 7441 };
	// A variable permits the intentionally new optional capability without a production placeholder.
	const accountLink = {
		readContext,
		registry: f.registry,
		ownerRecovery: service,
		getListenerAddress: () => listener,
	};
	const app = createApp({ accountLink });
	const session = await app.request(`${LOCAL}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441" },
	});
	expect(session.status).toBe(200);
	const { csrfToken } = await session.json();
	const headers = {
		Host: "127.0.0.1:7441",
		Origin: LOCAL,
		"X-Codemem-Account-Csrf": csrfToken,
		"Content-Type": "application/json",
	};
	const send = (path: string, body?: unknown) =>
		app.request(`${LOCAL}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return {
		...f,
		app,
		service,
		calls,
		readContext,
		readAdminSecret,
		headers,
		send,
		setListener: (value: typeof listener) => {
			listener = value;
		},
	};
}
function privateResponse(response: Response) {
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual(
		[],
	);
}
async function publicError(response: Response, statuses = [400]) {
	expect(statuses).toContain(response.status);
	privateResponse(response);
	const body = await response.json();
	const code = typeof body.error === "string" ? body.error : body.code;
	expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
	expect(JSON.stringify(body)).not.toMatch(
		/SELECT|SQLITE|fixture-server-admin|device\.key|memory\.sqlite/,
	);
}
function untouched(f: Awaited<ReturnType<typeof setup>>) {
	for (const call of Object.values(f.calls)) expect(call).not.toHaveBeenCalled();
	expect(f.readContext).not.toHaveBeenCalled();
	expect(f.readAdminSecret).not.toHaveBeenCalled();
	expect(f.requests).toHaveLength(0);
	expect(f.reviewOwner).not.toHaveBeenCalled();
	expect(f.link).not.toHaveBeenCalled();
}

function rejectHeaders(original: HeadersInit, mode: string) {
	const headers = new Headers(original);
	const changes: Record<string, [string, string]> = {
		"host-url": ["Host", "localhost:7441"],
		"foreign-origin": ["Origin", "https://foreign.invalid"],
		"cross-site": ["Sec-Fetch-Site", "cross-site"],
		csrf: ["X-Codemem-Account-Csrf", "wrong"],
	};
	const change = changes[mode];
	if (change) headers.set(...change);
	if (mode === "missing-origin") headers.delete("Origin");
	return headers;
}
function rejectedRequest(path: string, mode: string, original: HeadersInit): Request {
	// Missing Origin is forbidden for POST, while GET intentionally permits absent Origin.
	const post = mode === "missing-origin" || path !== BASE;
	return new Request(`${LOCAL}${path}`, {
		method: post ? "POST" : "GET",
		headers: rejectHeaders(original, mode),
		...(post ? { body: "{}" } : {}),
	});
}
async function validPayloads(f: Awaited<ReturnType<typeof setup>>) {
	const selection = await selectionFor(f.service);
	const previewRequest = { ...selection, requestId: "contract", purpose: "review" as const };
	const preview = await f.service.preview(previewRequest);
	vi.clearAllMocks();
	f.requests.length = 0;
	return {
		preview: previewRequest,
		confirm: { preview, approvalDigest: preview.approvalDigest },
		import: { selection, replyText: JSON.stringify(f.reply()) },
	};
}

async function restartedOwnerStatus(f: Awaited<ReturnType<typeof setup>>) {
	const captured = f.readContext();
	if (!("context" in captured) || !captured.context) throw new Error("Missing actual context");
	const readContext = createAccountContextReader({
		getProfile: () => f.profile,
		readConfig: () => f.config,
		keysDir: f.keysDir,
		configPath: captured.context.configPath,
	});
	const registry = createAccountLinkRegistry({ readContext, link: f.link });
	f.cleanup(() => registry.close());
	vi.stubGlobal("fetch", f.transport);
	const app = createApp({
		accountLink: {
			readContext,
			registry,
			getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
		},
	});
	const session = await app.request(`${LOCAL}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441" },
	});
	const { csrfToken } = await session.json();
	return app.request(`${LOCAL}/api/account/link-status`, {
		headers: { Host: "127.0.0.1:7441", "X-Codemem-Account-Csrf": csrfToken },
	});
}

describe("owner recovery uses the existing local account boundary", () => {
	it.each([
		"nonloopback",
		"unbound",
		"wrong-port",
		"host-url",
		"foreign-origin",
		"missing-origin",
		"cross-site",
		"csrf",
	])("rejects %s before any recovery or profile IO on all four endpoints", async (mode) => {
		// Arrange: a genuine service has real keys and a signed in-process coordinator, not invented authority.
		const f = await setup();
		const before = f.immutableSnapshot();
		if (mode === "nonloopback") f.setListener({ host: "0.0.0.0", port: 7441 });
		if (mode === "unbound") f.setListener(null);
		if (mode === "wrong-port") f.setListener({ host: "127.0.0.1", port: 7442 });
		// Act
		for (const path of paths) {
			const response = await f.app.request(rejectedRequest(path, mode, f.headers));
			// Assert
			await publicError(response, [403]);
		}
		untouched(f);
		deepStrictEqual(f.immutableSnapshot(), before);
	});
});

describe("read-only recovery projections", () => {
	it("returns only a noncredential profile after the session token and never publishes on GET", async () => {
		// Arrange
		const f = await setup();
		const before = f.immutableSnapshot();
		// Act
		const response = await f.send(BASE);
		// Assert
		expect(response.status).toBe(200);
		privateResponse(response);
		const body = await response.json();
		expect(body).toMatchObject({
			version: 1,
			reviewAccess: "operator",
			profile: { memoryActorId: "identity-b", deviceId: f.deviceId, configuredGroups: ["group-a"] },
		});
		expect(JSON.stringify(body)).not.toMatch(
			/fixture-server-admin|device\.key|memory\.sqlite|selected-config/,
		);
		expect(f.calls.getProfile).toHaveBeenCalledOnce();
		expect(f.association()).toBeNull();
		expectNoConfirmation(f);
		deepStrictEqual(f.immutableSnapshot(), before);
	});
	it("keeps check_status read-only even for a ready remote review", async () => {
		// Arrange
		const f = await setup({ fact: false });
		const selection = await selectionFor(f.service);
		const before = f.immutableSnapshot();
		const remoteBefore = f.snapshot();
		// Act
		const response = await f.send(`${BASE}/preview`, {
			...selection,
			requestId: "status",
			purpose: "check_status",
		});
		// Assert
		expect(response.status).toBe(200);
		privateResponse(response);
		expect(await response.json()).toMatchObject({
			requestId: "status",
			groupPreviews: [{ groupId: "group-a" }],
		});
		expectNoConfirmation(f);
		expect(f.association()).toBeNull();
		expect(f.snapshot()).toEqual(remoteBefore);
		deepStrictEqual(f.immutableSnapshot(), before);
	});
});

describe("explicit protected recovery publication", () => {
	it("confirms an explicitly reviewed operator flow through fresh signed receipt proof", async () => {
		// Arrange
		const f = await setup({ fact: false });
		const selection = await selectionFor(f.service);
		const before = f.immutableSnapshot();
		const remoteBefore = f
			.snapshot()
			.filter(([name]) => name !== "coordinator_legacy_owner_resolutions");
		// Act
		const review = await f.send(`${BASE}/preview`, {
			...selection,
			requestId: "review",
			purpose: "review",
		});
		expect(review.status).toBe(200);
		const preview = (await review.json()) as RecoveryPreview;
		expect(f.association()).toBeNull();
		expectNoConfirmation(f);
		const response = await f.send(`${BASE}/confirm`, {
			preview,
			approvalDigest: preview.approvalDigest,
		});
		// Assert
		expect(response.status).toBe(200);
		privateResponse(response);
		expect(await response.json()).toMatchObject({
			groups: [{ groupId: "group-a", status: "confirmed" }],
		});
		expect(
			f.reviewOwner.mock.calls.filter(
				([input]) => input.confirmOwnerResolutionDigest !== undefined,
			),
		).toHaveLength(1);
		expect(f.readRemoteReceiptStatus).toHaveBeenCalled();
		expect(f.association()).toMatchObject({ ownerIdentityId: "identity-a", actorId: "identity-b" });
		deepStrictEqual(f.immutableSnapshot(), before);
		expect(
			f.snapshot().filter(([name]) => name !== "coordinator_legacy_owner_resolutions"),
		).toEqual(remoteBefore);
		expect(
			f.db.prepare("SELECT COUNT(*) AS n FROM coordinator_legacy_owner_resolutions").get(),
		).toEqual({ n: 1 });
		expect(f.link).not.toHaveBeenCalled();
	});
	it("imports without admin only after verifying all five original receipt references", async () => {
		// Arrange
		const f = await setup({ admin: false });
		const selection = await selectionFor(f.service);
		const before = f.immutableSnapshot();
		const remoteBefore = f.snapshot();
		expect(f.association()).toBeNull();
		// Act
		const response = await f.send(`${BASE}/import`, {
			selection,
			replyText: JSON.stringify(f.reply()),
		});
		// Assert
		expect(response.status).toBe(200);
		privateResponse(response);
		expect(await response.json()).toMatchObject({
			groups: [{ groupId: "group-a", status: "confirmed" }],
		});
		expect(f.readRemoteReceiptStatus).toHaveBeenCalledWith(
			expect.objectContaining({ receipt: f.receipt(), ownerIdentityId: "identity-a" }),
		);
		expect(
			f.requests.some(
				(request) =>
					new URL(request.url).pathname === "/v1/auth/resolved-account-owner-receipt-status" &&
					request.headers.has("X-Opencode-Signature"),
			),
		).toBe(true);
		expect(f.association()).toMatchObject({
			ownerIdentityId: "identity-a",
			attestationId: f.receipt().attestationId,
			reviewDigest: f.receipt().reviewEvidenceDigest,
		});
		expect(f.reviewOwner).not.toHaveBeenCalled();
		await f.service.close();
		const status = await restartedOwnerStatus(f);
		expect(status.status).toBe(200);
		privateResponse(status);
		const view = await status.json();
		expect(view).toMatchObject({
			local: { identityId: "identity-b" },
			accountOwner: { identityId: "identity-a", memoryActorId: "identity-b" },
			remote: { kind: "not_checked" },
			ownerProjection: {
				status: { state: "owner_confirmed", profileState: "linked", ownerIdentity: "identity-a" },
			},
			canLink: false,
		});
		expect(view).not.toHaveProperty("managementActions");
		expect(view).not.toHaveProperty("unlinkTarget");
		expect(f.readContext()).toMatchObject({ context: { identityId: "identity-b" } });
		deepStrictEqual(f.immutableSnapshot(), before);
		expect(f.snapshot()).toEqual(remoteBefore);
	});
});

describe("recovery proof and stale-consent failures", () => {
	it("returns a failed group, never local authority, when any one of the five imported references is wrong", async () => {
		for (const field of [
			"attestationId",
			"reviewReceiptId",
			"reviewEvidenceDigest",
			"resolutionId",
			"resolutionEvidenceDigest",
		]) {
			// Arrange
			const f = await setup({ admin: false });
			const selection = await selectionFor(f.service);
			const reply = f.reply();
			Object.assign(reply.groups[0] ?? {}, {
				[field]: field.endsWith("Digest") ? "e".repeat(64) : "wrong-reference",
			});
			// Act
			const response = await f.send(`${BASE}/import`, {
				selection,
				replyText: JSON.stringify(reply),
			});
			// Assert
			expect(response.status).toBe(200);
			privateResponse(response);
			expect(await response.json()).toMatchObject({
				groups: [{ groupId: "group-a", status: "failed" }],
			});
			expect(f.readRemoteReceiptStatus).toHaveBeenCalledOnce();
			expect(f.association()).toBeNull();
		}
	});
	it("does not authorize a changed actual actor using an unchanged complete browser preview", async () => {
		// Arrange
		const f = await setup();
		const selection = await selectionFor(f.service);
		const preview = await f.service.preview({
			...selection,
			purpose: "review",
			requestId: "stale",
		});
		f.profile.identityId = "identity-next";
		f.config.actor_id = "identity-next";
		// Act
		const response = await f.send(`${BASE}/confirm`, {
			preview,
			approvalDigest: preview.approvalDigest,
		});
		// Assert
		await publicError(response, [400, 409]);
		expect(f.association()).toBeNull();
		expectNoConfirmation(f);
	});
});

describe("strict bounded recovery requests", () => {
	it("rejects browser paths, keys, secrets and config injection added to otherwise valid contracts", async () => {
		// Arrange
		const f = await setup();
		const payloads = await validPayloads(f);
		// Act
		for (const field of [
			"dbPath",
			"keysDir",
			"publicKey",
			"adminSecret",
			"configPath",
			"coordinatorUrl",
		]) {
			for (const [path, payload] of Object.entries(payloads)) {
				const response = await f.send(`${BASE}/${path}`, {
					...payload,
					[field]: "browser-controlled",
				});
				// Assert: unknown fields must fail before the trusted service is called.
				await publicError(response);
			}
		}
		untouched(f);
	});
	it.each(["query", "content-type", "utf8", "invalid-json", "array", "transfer-ambiguity"])(
		"rejects %s before service IO",
		async (mode) => {
			// Arrange
			const f = await setup();
			const headers = new Headers(f.headers);
			if (mode === "content-type") headers.set("Content-Type", "text/plain");
			if (mode === "transfer-ambiguity") {
				headers.set("Content-Length", "2");
				headers.set("Transfer-Encoding", "chunked");
			}
			let body: BodyInit = "{}";
			if (mode === "utf8")
				body = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
			if (mode === "invalid-json") body = "{";
			if (mode === "array") body = "[]";
			// Act
			const response = await f.app.request(
				`${LOCAL}${BASE}/preview${mode === "query" ? "?profile=browser" : ""}`,
				{ method: "POST", headers, body },
			);
			// Assert
			await publicError(response, [400, 413, 415]);
			untouched(f);
		},
	);
});

describe("streamed JSON limits", () => {
	it("accepts exactly 64 KiB of streamed JSON with a multibyte character split across chunks", async () => {
		// Arrange
		const f = await setup();
		const payloads = await validPayloads(f);
		const json = JSON.stringify({ ...payloads.preview, requestId: "review-é" });
		const encoded = new TextEncoder().encode(json);
		const bytes = new TextEncoder().encode(json + " ".repeat(64 * 1024 - encoded.byteLength));
		const split = bytes.indexOf(0xc3) + 1;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, split));
				controller.enqueue(bytes.subarray(split));
				controller.close();
			},
		});
		// Act
		const response = await f.app.request(
			new Request(`${LOCAL}${BASE}/preview`, {
				method: "POST",
				headers: f.headers,
				body,
				duplex: "half",
			} as RequestInit),
		);
		// Assert
		expect(response.status).toBe(200);
		privateResponse(response);
		expect(await response.json()).toMatchObject({ requestId: "review-é" });
		expect(f.calls.preview).toHaveBeenCalledWith({ ...payloads.preview, requestId: "review-é" });
		expectNoConfirmation(f);
		expect(f.association()).toBeNull();
	});
	it.each([
		["preview", 64 * 1024],
		["confirm", 1024 * 1024],
		["import", 64 * 1024],
	] as const)("caps streamed %s bytes without trusting Content-Length", async (path, cap) => {
		// Arrange
		const f = await setup();
		const payloads = await validPayloads(f);
		const payload = structuredClone(payloads[path]);
		if (path === "preview") Object.assign(payload, { requestId: "é".repeat(cap / 2) });
		if (path === "confirm")
			Object.assign((payload as typeof payloads.confirm).preview, {
				requestId: "é".repeat(cap / 2),
			});
		if (path === "import") Object.assign(payload, { replyText: "é".repeat(cap / 2) });
		const bytes = new TextEncoder().encode(JSON.stringify(payload));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, 13));
				controller.enqueue(bytes.subarray(13));
				controller.close();
			},
		});
		// Act
		const response = await f.app.request(
			new Request(`${LOCAL}${BASE}/${path}`, {
				method: "POST",
				headers: f.headers,
				body,
				duplex: "half",
			} as RequestInit),
		);
		// Assert
		await publicError(response, [400, 413]);
		untouched(f);
	});
});

describe("request scope and lifecycle rejection", () => {
	it("rejects GET query/body metadata and unsupported methods without calling the profile service", async () => {
		// Arrange
		const f = await setup();
		// Act
		const query = await f.app.request(`${LOCAL}${BASE}?group=browser`, { headers: f.headers });
		const bodyMetadata = await f.app.request(`${LOCAL}${BASE}`, {
			headers: { ...f.headers, "Content-Length": "1" },
		});
		const method = await f.app.request(`${LOCAL}${BASE}`, { method: "DELETE", headers: f.headers });
		// Assert
		await publicError(query);
		await publicError(bodyMetadata);
		expect([400, 404, 405]).toContain(method.status);
		privateResponse(method);
		untouched(f);
	});
	it("rejects duplicate and unconfigured groups instead of expanding the actual configured scope", async () => {
		// Arrange
		const f = await setup();
		const selection = await selectionFor(f.service);
		// Act
		for (const groups of [["group-a", "group-a"], ["foreign-group"]]) {
			const response = await f.send(`${BASE}/preview`, {
				...selection,
				groups,
				purpose: "review",
				requestId: "invalid-groups",
			});
			// Assert
			await publicError(response);
		}
		expect(f.association()).toBeNull();
		expectNoConfirmation(f);
	});
	it("maps the shared registry reservation to busy 409 without publishing", async () => {
		// Arrange
		const f = await setup();
		const selection = await selectionFor(f.service);
		const reserved = f.registry.tryReserveRecovery?.();
		expect(reserved).toBeTruthy();
		try {
			// Act
			const response = await f.send(`${BASE}/import`, {
				selection,
				replyText: JSON.stringify(f.reply()),
			});
			// Assert
			await publicError(response, [409]);
			expect(f.readRemoteReceiptStatus).not.toHaveBeenCalled();
			expect(f.association()).toBeNull();
		} finally {
			reserved?.release();
		}
	});
	it("maps a closed recovery service to unavailable 503, not an implementation exception", async () => {
		// Arrange
		const f = await setup();
		const selection = await selectionFor(f.service);
		const preview = await f.service.preview({
			...selection,
			requestId: "before-close",
			purpose: "review",
		});
		await f.service.close();
		// Act
		const responses = [
			await f.send(BASE),
			await f.send(`${BASE}/confirm`, { preview, approvalDigest: preview.approvalDigest }),
			await f.send(`${BASE}/import`, { selection, replyText: JSON.stringify(f.reply()) }),
		];
		// Assert
		for (const response of responses) await publicError(response, [503]);
		expect(f.association()).toBeNull();
		expectNoConfirmation(f);
	});
});

describe("recovery availability and error privacy", () => {
	it("times out an unfinished JSON stream at ten seconds without invoking the service", async () => {
		// Arrange
		const f = await setup();
		vi.useFakeTimers();
		try {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("{"));
				},
			});
			// Act
			const pending = f.app.request(
				new Request(`${LOCAL}${BASE}/preview`, {
					method: "POST",
					headers: f.headers,
					body,
					duplex: "half",
				} as RequestInit),
			);
			await vi.advanceTimersByTimeAsync(10_001);
			// Assert
			await publicError(await pending, [400, 408]);
			untouched(f);
		} finally {
			vi.useRealTimers();
		}
	});
	it("rejects an aborted body without profile or secret reads", async () => {
		// Arrange
		const f = await setup();
		const abort = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new DOMException("aborted", "AbortError"));
			},
		});
		abort.abort();
		// Act
		const response = await f.app.request(
			new Request(`${LOCAL}${BASE}/preview`, {
				method: "POST",
				headers: f.headers,
				body,
				signal: abort.signal,
				duplex: "half",
			} as RequestInit),
		);
		// Assert
		await publicError(response, [400, 408]);
		untouched(f);
	});
	it("sanitizes unexpected implementation errors into a stable public code", async () => {
		// Arrange
		const f = await setup();
		f.calls.getProfile.mockRejectedValue(
			new Error("SQLITE SELECT fixture-server-admin memory.sqlite device.key"),
		);
		// Act
		const response = await f.send(BASE);
		// Assert
		await publicError(response, [500, 503]);
	});
	it("leaves recovery unavailable when an older embedding supplies no optional service", async () => {
		// Arrange
		const f = await setup();
		const app = createApp({
			accountLink: {
				readContext: f.readContext,
				registry: f.registry,
				getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
			},
		});
		const session = await app.request(`${LOCAL}/api/account/session`, {
			headers: { Host: "127.0.0.1:7441" },
		});
		const { csrfToken } = await session.json();
		// Act
		const response = await app.request(`${LOCAL}${BASE}`, {
			headers: { ...f.headers, "X-Codemem-Account-Csrf": csrfToken },
		});
		// Assert
		expect([404, 503]).toContain(response.status);
		privateResponse(response);
		untouched(f);
	});
});

it("keeps carried proof failures unknown at HTTP 200 without retrying or losing earlier success", async () => {
	for (const mode of ["denied", "lost"]) {
		// Arrange
		const f = await setup({ fact: false, groups: ["group-a", "group-two"] });
		const selection = await selectionFor(f.service, ["group-a", "group-two"]);
		const preview = await f.service.preview({
			...selection,
			purpose: "review",
			requestId: "partial",
		});
		const original = f.readRemoteReceiptStatus.getMockImplementation();
		if (!original) throw new Error("Missing genuine signed receipt reader");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			if (input.groupId === "group-two") {
				if (mode === "denied") return { kind: "unavailable", code: "coordinator_rejected" };
				throw new Error("receipt_status_outcome_unknown");
			}
			return original(input);
		});
		const before = f.immutableSnapshot();
		const beforeRemote = f
			.snapshot()
			.filter(([name]) => name !== "coordinator_legacy_owner_resolutions");
		// Act
		const response = await f.send(`${BASE}/confirm`, {
			preview,
			approvalDigest: preview.approvalDigest,
		});
		// Assert
		expect(response.status).toBe(200);
		privateResponse(response);
		const result = await response.json();
		expect(result).toMatchObject({
			groups: [
				{ groupId: "group-a", status: "confirmed" },
				{ groupId: "group-two", status: "unknown" },
			],
		});
		expect(f.association()?.ownerIdentityId).toBe("identity-a");
		expect(f.association("group-two")).toBeNull();
		const repeated = await f.send(`${BASE}/confirm`, {
			preview,
			approvalDigest: preview.approvalDigest,
		});
		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toEqual(result);
		expect(
			f.reviewOwner.mock.calls.filter(
				([input]) => input.confirmOwnerResolutionDigest !== undefined,
			),
		).toHaveLength(1);
		expect(
			f.reviewOwner.mock.calls.filter(([input]) => input.groupId === "group-two"),
		).toHaveLength(1);
		expect(f.readRemoteReceiptStatus.mock.calls.map(([input]) => input.groupId)).toEqual([
			"group-a",
			"group-two",
		]);
		expect(f.readRemoteReceiptStatus.mock.calls[1]?.[0].receipt).toEqual(
			f.readRemoteReceiptStatus.mock.calls[0]?.[0].receipt,
		);
		deepStrictEqual(f.immutableSnapshot(), before);
		expect(
			f.snapshot().filter(([name]) => name !== "coordinator_legacy_owner_resolutions"),
		).toEqual(beforeRemote);
	}
});

it("rejects an imported reply above the service's 32 KiB cap even within the HTTP 64 KiB cap", async () => {
	// Arrange
	const f = await setup({ admin: false });
	const selection = await selectionFor(f.service);
	// Act
	const response = await f.send(`${BASE}/import`, {
		selection,
		replyText: JSON.stringify(f.reply()) + " ".repeat(32 * 1024),
	});
	// Assert
	await publicError(response);
	expect(f.readRemoteReceiptStatus).not.toHaveBeenCalled();
	expect(f.association()).toBeNull();
});
