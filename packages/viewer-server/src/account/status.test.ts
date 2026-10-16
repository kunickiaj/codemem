import type { CoordinatorAccountLinkStatusRead } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppOptions, createApp } from "../index.js";

const ORIGIN = "http://127.0.0.1:7441";
const PATH = "/api/account/link-status";
const pictureUrl = "https://lh3.googleusercontent.com/a/photo";
const local = {
	deviceId: "device-a",
	fingerprint: "a".repeat(64),
	identityId: "actor-a",
	identityLabel: "Fixture user",
	deviceLabel: "Fixture laptop",
};
const subject = {
	...local,
	contextId: "context-a",
	dbPath: "/fixture/never-open.sqlite",
	keysDir: "/fixture/never-open-keys",
	coordinatorUrl: "https://coordinator.example.test",
	groupId: "group-a",
	fileIdentity: { dev: "1", ino: "2" },
};
const ready = {
	setup: "ready" as const,
	groups: ["group-a"],
	selectedGroupId: "group-a",
	coordinator: { origin: "https://coordinator.example.test" },
	context: subject,
};
type AccountOptions = NonNullable<AppOptions["accountLink"]>;
type Context = ReturnType<NonNullable<AccountOptions["readContext"]>>;

afterEach(() => vi.restoreAllMocks());
async function fixture() {
	const readContext = vi.fn((): Context => structuredClone(ready));
	const readRemoteStatus = vi.fn(
		async (): Promise<CoordinatorAccountLinkStatusRead> => ({ kind: "unsupported" }),
	);
	const storeFactory = vi.fn(() => {
		throw new Error("Status must not initialize a store");
	});
	const app = createApp({
		storeFactory,
		accountLink: {
			getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
			readContext,
			readRemoteStatus,
		},
	});
	const session = await app.request(`${ORIGIN}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441", Origin: ORIGIN },
	});
	const { csrfToken } = await session.json();
	const request = (suffix = "", extra: Record<string, string> = {}) =>
		app.request(`${ORIGIN}${PATH}${suffix}`, {
			headers: {
				Host: "127.0.0.1:7441",
				Origin: ORIGIN,
				"X-Codemem-Account-Csrf": csrfToken,
				...extra,
			},
		});
	return { app, request, readContext, readRemoteStatus, storeFactory };
}
function status(
	state: "unlinked" | "linked" | "review_required" | "revoked" | "conflict",
	identityId = local.identityId,
	authority: "device_claim" | "controller_attestation" = "device_claim",
): CoordinatorAccountLinkStatusRead {
	const subject = {
		version: 2 as const,
		coordinatorId: "coordinator-a",
		groupId: "group-a",
		deviceId: local.deviceId,
		fingerprint: local.fingerprint,
	};
	if (state === "review_required" || state === "conflict")
		return {
			kind: "status",
			status: { ...subject, state, identityId: null, authority: null, account: null },
		};
	return {
		kind: "status",
		status: {
			...subject,
			identityId,
			authority,
			...(state === "linked"
				? {
						state,
						account: { email: "fixture@example.test", displayName: "Fixture name", pictureUrl },
					}
				: { state, account: null }),
		},
	};
}
function privateResponse(response: Response) {
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	expect([...response.headers.keys()].filter((key) => key.startsWith("access-control-"))).toEqual(
		[],
	);
}

describe("account status route", () => {
	it.each(["device_claim", "controller_attestation"] as const)(
		"preserves %s eligibility",
		async (authority) => {
			const f = await fixture(); // Arrange
			f.readRemoteStatus.mockResolvedValue(status("unlinked", local.identityId, authority));
			const body = await (await f.request()).json(); // Act
			expect(body).toMatchObject({
				canLink: true,
				remote: { authority, identityId: local.identityId },
			}); // Assert
		},
	);
	it.each(["unlinked", "linked", "review_required", "revoked", "conflict"] as const)(
		"projects %s without treating blocked states as unlinked",
		async (state) => {
			const f = await fixture(); // Arrange
			f.readRemoteStatus.mockResolvedValue(status(state));
			const response = await f.request(); // Act
			const body = await response.json();
			expect(response.status).toBe(200); // Assert
			expect(body).toMatchObject({
				version: 1,
				contextId: subject.contextId,
				setup: "ready",
				local,
				coordinator: ready.coordinator,
				remote: { kind: "status", state },
				canLink: state === "unlinked",
				operation: null,
			});
			expect(body.remote.account).toEqual(
				state === "linked"
					? { email: "fixture@example.test", displayName: "Fixture name", pictureUrl }
					: null,
			);
			if (state === "review_required") expect(body.blockedReason).toBe("review_required");
			expect(new Date(body.checkedAt).toISOString()).toBe(body.checkedAt);
			expect(JSON.stringify(body)).not.toContain(subject.dbPath);
			expect(JSON.stringify(body)).not.toContain(subject.keysDir);
			expect(body.local).toEqual(local);
			expect(body.coordinator).toEqual(ready.coordinator);
			privateResponse(response);
			expect(f.storeFactory).not.toHaveBeenCalled();
			expect(f.readRemoteStatus).toHaveBeenCalledWith({
				dbPath: subject.dbPath,
				keysDir: subject.keysDir,
				groupId: subject.groupId,
				identityId: subject.identityId,
				coordinatorUrl: subject.coordinatorUrl,
				signal: expect.any(AbortSignal),
			});
		},
	);
	it.each(["linked", "unlinked"] as const)(
		"removes metadata and disallows linking for %s identity mismatch",
		async (state) => {
			const f = await fixture(); // Arrange
			f.readRemoteStatus.mockResolvedValue(status(state, "actor-other"));
			const body = await (await f.request()).json(); // Act
			// Assert
			expect(body).toMatchObject({
				canLink: false,
				blockedReason: "identity_mismatch",
				remote: { identityMatches: false, account: null },
			});
			expect(JSON.stringify(body)).not.toContain("fixture@example.test");
			expect(JSON.stringify(body)).not.toContain(pictureUrl);
		},
	);
	it.each(["groupId", "deviceId", "fingerprint"] as const)(
		"discards remote status with mismatched %s",
		async (field) => {
			const f = await fixture(); // Arrange
			const remote = status("linked");
			if (remote.kind !== "status") throw new Error("Expected status fixture");
			remote.status[field] = "other";
			f.readRemoteStatus.mockResolvedValue(remote);
			const body = await (await f.request()).json(); // Act
			expect(body).toMatchObject({
				canLink: false,
				remote: { kind: "unavailable", code: "context_changed" },
			}); // Assert
			expect(JSON.stringify(body)).not.toContain("fixture@example.test");
			expect(JSON.stringify(body)).not.toContain(pictureUrl);
		},
	);
});
describe("account unavailable status", () => {
	it.each<CoordinatorAccountLinkStatusRead>([
		{ kind: "unsupported" },
		{ kind: "unavailable", code: "coordinator_unreachable" },
		{ kind: "unavailable", code: "coordinator_unavailable" },
	])("preserves remote failure %j", async (remote) => {
		const f = await fixture(); // Arrange
		f.readRemoteStatus.mockResolvedValue(Object.assign({ email: "injected@example.test" }, remote));
		const body = await (await f.request()).json(); // Act
		expect(body.remote).toEqual(remote); // Assert
		expect(body.canLink).toBe(false);
		expect(JSON.stringify(body)).not.toContain("unlinked");
		expect(JSON.stringify(body)).not.toContain("injected@example.test");
	});
});
describe("account status request boundary", () => {
	it.each([
		"coordinator_not_configured",
		"coordinator_url_invalid",
		"group_selection_required",
		"device_unavailable",
		"identity_unavailable",
	] as const)("does not call the coordinator for setup %s", async (setup) => {
		const f = await fixture(); // Arrange
		f.readContext.mockReturnValue({ ...ready, setup, context: null });
		const body = await (await f.request()).json(); // Act
		expect(body).toMatchObject({ setup, remote: { kind: "not_checked" }, canLink: false }); // Assert
		expect(f.readRemoteStatus).not.toHaveBeenCalled();
		expect(f.storeFactory).not.toHaveBeenCalled();
	});
	it.each([
		"?db_path=/fixture",
		"?config=/fixture",
		"?coordinator=https://other.example.test",
		"?group_id=group-a&group_id=group-a",
		"?unused=1",
	])("rejects selector %s before reading context", async (suffix) => {
		const f = await fixture(); // Arrange
		const response = await f.request(suffix); // Act
		expect(response.status).toBe(400); // Assert
		expect(f.readContext).not.toHaveBeenCalled();
		expect(f.readRemoteStatus).not.toHaveBeenCalled();
		privateResponse(response);
	});
	it("passes one explicit group through without accepting browser-selected paths", async () => {
		const f = await fixture(); // Arrange
		const response = await f.request("?group_id=group-a"); // Act
		expect(response.status).toBe(200); // Assert
		expect(f.readContext).toHaveBeenCalledWith("group-a");
	});
	it("maps an unknown configured-group error to 400 without remote access", async () => {
		const f = await fixture(); // Arrange
		f.readContext.mockReturnValue({ error: "account_group_not_configured" });
		const response = await f.request("?group_id=unknown"); // Act
		expect(response.status).toBe(400); // Assert
		expect(await response.json()).toEqual({ error: "account_group_not_configured" });
		expect(f.readRemoteStatus).not.toHaveBeenCalled();
	});
	it.each([
		{ "X-Codemem-Account-Csrf": "" },
		{ "Content-Length": "1" },
		{ "Transfer-Encoding": "chunked" },
	])("rejects token/body framing %j before context or remote access", async (headers) => {
		const f = await fixture(); // Arrange
		const response = await f.request("", headers); // Act
		expect(response.status).toBe("X-Codemem-Account-Csrf" in headers ? 403 : 400); // Assert
		expect(f.readContext).not.toHaveBeenCalled();
		expect(f.readRemoteStatus).not.toHaveBeenCalled();
		privateResponse(response);
	});
});
function changedContext(field: string): Exclude<Context, { error: string }> {
	const fresh: Exclude<Context, { error: string }> = structuredClone(ready);
	if (!fresh.context) throw new Error("Expected ready fixture");
	if (field === "contextId") fresh.context.contextId = "context-b";
	if (field === "local") fresh.context.identityId = "actor-new";
	if (field === "file") fresh.context.fileIdentity.ino = "3";
	if (field === "fingerprint") fresh.context.fingerprint = "b".repeat(64);
	if (field === "device") fresh.context.deviceId = "device-new";
	if (field === "coordinator") fresh.coordinator = { origin: "https://new.example.test" };
	if (field === "setup") Object.assign(fresh, { setup: "device_unavailable", context: null });
	if (field === "error" || field === "throws") fresh.context = null;
	return fresh;
}
describe("account status freshness", () => {
	it.each(
		["contextId", "coordinator", "local", "setup", "file", "fingerprint", "device"].concat([
			"error",
			"throws",
		]),
	)(
		"discards stale account metadata when %s changes while awaiting remote status",
		async (field) => {
			// Arrange: deferred remote completion, no clocks or network.
			const f = await fixture();
			let finish!: (value: CoordinatorAccountLinkStatusRead) => void;
			let started!: () => void;
			const pending = new Promise<CoordinatorAccountLinkStatusRead>((resolve) => {
				finish = resolve;
			});
			const called = new Promise<void>((resolve) => {
				started = resolve;
			});
			f.readRemoteStatus.mockImplementation(() => {
				started();
				return pending;
			});
			const fresh = changedContext(field);
			const responsePromise = f.request(); // Act
			await called;
			f.readContext.mockReturnValue(fresh);
			if (field === "error")
				f.readContext.mockReturnValue({ error: "account_context_unavailable" });
			if (field === "throws")
				f.readContext.mockImplementation(() => {
					throw new Error("synthetic fixture failure");
				});
			finish(status("linked"));
			const body = await (await responsePromise).json();
			// Assert
			expect(body).toMatchObject({
				contextId: fresh.context?.contextId ?? null,
				canLink: false,
				remote: { kind: "unavailable", code: "context_changed" },
				local: fresh.context
					? {
							deviceId: fresh.context.deviceId,
							identityId: fresh.context.identityId,
							fingerprint: fresh.context.fingerprint,
						}
					: null,
			});
			expect(JSON.stringify(body)).not.toContain("fixture@example.test");
			expect(f.readContext).toHaveBeenCalledTimes(2);
		},
	);
	it("reads remote status afresh on each completed request", async () => {
		const f = await fixture(); // Arrange
		f.readRemoteStatus
			.mockResolvedValueOnce(status("unlinked"))
			.mockResolvedValueOnce(status("linked"));
		const first = await (await f.request()).json(); // Act
		const second = await (await f.request()).json();
		expect(first.canLink).toBe(true); // Assert
		expect(second.remote.state).toBe("linked");
		expect(f.readRemoteStatus).toHaveBeenCalledTimes(2);
	});
	it("returns a fixed safe failure without logging a thrown context cause", async () => {
		const f = await fixture(); // Arrange
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		f.readContext.mockImplementation(() => {
			throw new Error("synthetic-private-path-and-cause");
		});
		const response = await f.request(); // Act
		const text = await response.text();
		expect(response.status).toBe(500); // Assert
		expect(text).not.toContain("synthetic-private");
		expect(JSON.parse(text)).toEqual({ error: "account_internal_error" });
		expect(logged).not.toHaveBeenCalled();
		expect(f.readRemoteStatus).not.toHaveBeenCalled();
		privateResponse(response);
	});
	it("does not mount status when only listener/session support is enabled", async () => {
		// Arrange
		const app = createApp({
			accountLink: { getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }) },
		});
		const session = await app.request(`${ORIGIN}/api/account/session`, {
			headers: { Host: "127.0.0.1:7441" },
		});
		const { csrfToken } = await session.json();
		// Act
		const response = await app.request(`${ORIGIN}${PATH}`, {
			headers: { Host: "127.0.0.1:7441", "X-Codemem-Account-Csrf": csrfToken },
		});
		expect(response.status).toBe(404); // Assert
	});
});
