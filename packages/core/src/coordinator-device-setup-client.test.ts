import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fixture as accountChangeFixture,
	capabilitiesPath,
	cleanupAccountChangeHttpFixtures,
} from "./coordinator-account-change-http-test-fixtures.js";
import { readCoordinatorAccountChangeCapabilities } from "./coordinator-account-link-status-client.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { signedHeaders } from "./coordinator-device-headless-link-test-fixtures.js";
import {
	type CoordinatorDeviceSetupOptions,
	completeCoordinatorDeviceSetup,
	readCoordinatorDeviceSetup,
} from "./coordinator-device-setup-client.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	legacySetupPreservationSnapshot,
	linkedLegacySetupFixture,
} from "./linked-legacy-setup-test-fixtures.js";

const localFiles = vi.hoisted(() => ({ read: vi.fn(), sign: vi.fn() }));
vi.mock("./coordinator-account-link-signer.js", () => ({
	readAccountLinkDevice: localFiles.read,
	signAccountLinkRequest: localFiles.sign,
}));

type Context = { f: LinkedLegacySetupFixture; options: CoordinatorDeviceSetupOptions };
const unavailable = (cause: string) => ({ kind: "unavailable", cause });

function registerSchemaRefusalTests(context: () => Context) {
	it("maps a readiness schema-upgrade refusal without posting", async () => {
		// Arrange: schema errors are definitive predispatch refusals, not unknown commits.
		const { options } = context();
		const transport = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("Upgrade required", {
				status: 503,
				headers: { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" },
			}),
		);
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual(unavailable("coordinator_auth_schema_upgrade_required"));
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0]?.[1]?.method).toBe("GET");
	});

	it.each([
		{
			label: "schema refusal",
			schema: true,
			status: 503,
			result: unavailable("coordinator_auth_schema_upgrade_required"),
		},
		{
			label: "server failure",
			schema: false,
			status: 503,
			result: { kind: "unknown", cause: "completion_outcome_unknown" },
		},
		{
			label: "admission failure",
			schema: false,
			status: 401,
			result: { kind: "unknown", cause: "completion_outcome_unknown" },
		},
	])(
		"performs one receipt GET after POST schema failure and handles $label",
		async ({ schema, status, result: expected }) => {
			// Arrange: a schema-labelled POST response can also follow an uncertain committed write.
			const { options } = context();
			const transport = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ kind: "ready" }))
				.mockResolvedValueOnce(
					new Response("Upgrade required", {
						status: 503,
						headers: { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" },
					}),
				)
				.mockResolvedValueOnce(
					new Response("Receipt unavailable", {
						status,
						headers: schema
							? { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" }
							: {},
					}),
				);
			// Act
			const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual(expected);
			expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
		},
	);

	it("recovers the receipt when a committed POST response is labelled as a schema failure", async () => {
		// Arrange: execute the real commit, then simulate its failed response/read boundary.
		const { f, options } = context();
		const methods: string[] = [];
		const transport = vi.fn<typeof fetch>(async (input, init) => {
			methods.push(init?.method ?? "GET");
			const response = await f.app.request(new Request(input, init));
			if (init?.method !== "POST") return response;
			expect(response.status).toBe(200);
			return new Response("Schema read failed after commit", {
				status: 503,
				headers: { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" },
			});
		});
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toMatchObject({ kind: "complete", receipt: { deviceId: f.keyA.deviceId } });
		expect(methods).toEqual(["GET", "POST", "GET"]);
		expect(
			f.coordinator.db
				.prepare("SELECT count(*) AS n FROM coordinator_device_rebind_audit_log")
				.get(),
		).toEqual({ n: 1 });
	});
}

function registerCapturedOptionsTest(context: () => Context) {
	it("uses captured validated options when the caller mutates its object between readiness and POST", async () => {
		// Arrange
		const { f, options } = context();
		const maliciousTransport = vi.fn<typeof fetch>();
		const observed: { url: string; method: string; body: string }[] = [];
		const shared = { ...options };
		shared.fetch = async (input, init) => {
			const request = new Request(input, init);
			observed.push({
				url: request.url,
				method: request.method,
				body: await request.clone().text(),
			});
			const response = await f.app.request(request);
			if (init?.method === "GET") {
				shared.currentIdentityId = "another-identity";
				shared.groupId = "another-group";
				shared.coordinatorUrl = "https://another.example.test";
				shared.dbPath = "another.sqlite";
				shared.fetch = maliciousTransport;
			}
			return response;
		};
		// Act
		const result = await completeCoordinatorDeviceSetup(shared);
		// Assert: neither the destination, signer context nor body can change after validation.
		expect(result).toMatchObject({
			kind: "completed",
			receipt: { identityId: LEGACY_SETUP.identityId },
		});
		expect(observed.map(({ method }) => method)).toEqual(["GET", "POST"]);
		expect(new URL(observed[1]?.url ?? "").origin).toBe(options.coordinatorUrl);
		expect(JSON.parse(observed[1]?.body ?? "null")).toEqual({
			group_id: options.groupId,
			identity_id: options.currentIdentityId,
		});
		expect(localFiles.sign.mock.calls.every(([input]) => input.dbPath === options.dbPath)).toBe(
			true,
		);
		expect(maliciousTransport).not.toHaveBeenCalled();
	});
}

function registerConnectRequiredTests(context: () => Context) {
	it.each(["read", "complete"])(
		"returns exact connect_required from %s without POST",
		async (operation) => {
			// Arrange: this is a direction to the reviewed connection ceremony, never a completion receipt.
			const { options } = context();
			const transport = vi
				.fn<typeof fetch>()
				.mockResolvedValue(Response.json({ kind: "connect_required" }));
			// Act
			const call =
				operation === "read" ? readCoordinatorDeviceSetup : completeCoordinatorDeviceSetup;
			const result = await call({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual({ kind: "connect_required" });
			expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
		},
	);

	it.each([
		{ kind: "connect_required", receipt: {} },
		{ kind: "connect_required", identity_id: LEGACY_SETUP.identityId },
	])("rejects extra keys on GET connect_required %j", async (value) => {
		// Arrange
		const { options } = context();
		const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual(unavailable("invalid_response"));
		expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
	});

	it.each([{ kind: "connect_required" }, { kind: "connect_required", receipt: {} }])(
		"never treats POST connect_required as completion %j",
		async (value) => {
			// Arrange: an invalid POST response has an unknown outcome, followed by only a safe receipt read.
			const { options } = context();
			const transport = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ kind: "ready" }))
				.mockResolvedValueOnce(Response.json(value))
				.mockResolvedValueOnce(Response.json({ kind: "ready" }));
			// Act
			const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual({ kind: "unknown", cause: "completion_outcome_unknown" });
			expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
		},
	);
}

function registerCapabilitiesCompatibilityTests() {
	it("keeps the upgraded route's account-change actions compatible with the strict two-key decoder", async () => {
		// Arrange: mount both maintained account changes and device setup in the normal app.
		const account = await accountChangeFixture();
		try {
			const app = createCoordinatorApp({
				...account.options,
				authLink: { config: account.config, storeFactory: () => account.store },
			});
			localFiles.read.mockReturnValue(account.key);
			localFiles.sign.mockImplementation(
				(input: { method: string; url: string; bodyBytes: Buffer }) => {
					const url = new URL(input.url);
					const { "content-type": _contentType, ...headers } = signedHeaders(
						account.key,
						input.method,
						`${url.pathname}${url.search}`,
						input.bodyBytes.toString(),
					);
					return headers;
				},
			);
			const fetch: typeof globalThis.fetch = (input, init) => app.request(new Request(input, init));
			// Act
			const response = await account.send("GET", capabilitiesPath);
			const wire = (await response.json()) as { actions: Record<string, boolean> };
			const decoded = await readCoordinatorAccountChangeCapabilities({
				dbPath: "synthetic-unused.sqlite",
				coordinatorUrl: new URL(account.config.redirectUri).origin,
				groupId: "group-a",
				identityId: "identity-a",
				fetch,
			});
			const binding = await readCoordinatorDeviceSetup({
				dbPath: "synthetic-unused.sqlite",
				coordinatorUrl: new URL(account.config.redirectUri).origin,
				groupId: "group-a",
				currentIdentityId: "identity-a",
				fetch,
			});
			// Assert: new setup negotiation must not extend the established actions object.
			expect(response.status).toBe(200);
			expect(Object.keys(wire.actions).sort()).toEqual(["disconnect", "refresh"]);
			expect(decoded).toMatchObject({ kind: "capabilities", actions: wire.actions });
			expect(["ready", "complete"]).toContain(binding.kind);
		} finally {
			cleanupAccountChangeHttpFixtures();
		}
	});

	it("rejects an extra device_binding action through the actual strict decoder", async () => {
		// Arrange: freeze the old Viewer contract without copying its parser into this test.
		const transport = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				coordinator_id: LEGACY_SETUP.coordinatorId,
				identity_id: LEGACY_SETUP.identityId,
				actions: { refresh: true, disconnect: false, device_binding: true },
			}),
		);
		// Act
		const decoded = await readCoordinatorAccountChangeCapabilities({
			dbPath: "synthetic-unused.sqlite",
			coordinatorUrl: "https://coordinator.example.test",
			groupId: LEGACY_SETUP.groupId,
			identityId: LEGACY_SETUP.identityId,
			fetch: transport,
		});
		// Assert
		expect(decoded).toEqual({ kind: "unavailable", code: "invalid_response" });
	});
}

function registerReceiptRecoveryTests(context: () => Context) {
	it("recovers a committed POST whose response was lost by reading its receipt, without another POST", async () => {
		// Arrange: transport fails only after the real signed route commits.
		const { f, options } = context();
		const methods: string[] = [];
		const transport = vi.fn<typeof fetch>(async (input, init) => {
			methods.push(init?.method ?? "GET");
			const response = await f.app.request(new Request(input, init));
			if (init?.method === "POST") throw new Error("synthetic lost response after commit");
			return response;
		});
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		const retry = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert: the later invocation also starts with GET and returns the same immutable receipt.
		expect(result, JSON.stringify({ result, methods })).toMatchObject({
			kind: "complete",
			receipt: {
				deviceId: f.keyA.deviceId,
				identityId: LEGACY_SETUP.identityId,
				coordinatorId: LEGACY_SETUP.coordinatorId,
				enrollmentCount: 1,
			},
		});
		expect(retry).toEqual(result);
		expect(methods).toEqual(["GET", "POST", "GET", "GET"]);
		expect(
			f.coordinator.db
				.prepare("SELECT count(*) AS n FROM coordinator_device_rebind_audit_log")
				.get(),
		).toEqual({ n: 1 });
		expect(legacySetupPreservationSnapshot(f.local)).toEqual(f.before);
	});

	it("keeps an uncommitted ambiguous POST unknown and never blindly retries it", async () => {
		// Arrange: transport fails before the route receives POST, so recovery GET still says ready.
		const { f, options } = context();
		const methods: string[] = [];
		const transport = vi.fn<typeof fetch>(async (input, init) => {
			methods.push(init?.method ?? "GET");
			if (init?.method === "POST") throw new Error("synthetic transport interruption");
			return f.app.request(new Request(input, init));
		});
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual({ kind: "unknown", cause: "completion_outcome_unknown" });
		expect(methods).toEqual(["GET", "POST", "GET"]);
		expect(
			f.coordinator.db
				.prepare("SELECT count(*) AS n FROM coordinator_device_rebind_audit_log")
				.get(),
		).toEqual({ n: 0 });
	});

	it("decodes a successful signed POST receipt and does not mutate local policy or pins", async () => {
		// Arrange
		const { f, options } = context();
		// Act
		const ready = await readCoordinatorDeviceSetup(options);
		const result = await completeCoordinatorDeviceSetup(options);
		const receipt = await readCoordinatorDeviceSetup(options);
		// Assert
		expect(ready).toEqual({ kind: "ready" });
		expect(result, JSON.stringify(result)).toMatchObject({
			kind: "completed",
			receipt: { deviceId: f.keyA.deviceId },
		});
		expect(receipt).toEqual({ ...result, kind: "complete" });
		expect(legacySetupPreservationSnapshot(f.local)).toEqual(f.before);
		expect(f.local.prepare("SELECT count(*) AS n FROM sync_peers").get()).toEqual({ n: 0 });
	});
}

function registerResponseDenialTests(context: () => Context) {
	it.each(["device_id", "identity_id", "key_id"])(
		"rejects a complete receipt for another %s",
		async (field) => {
			// Arrange: retain every real receipt field except the specific authenticated pin.
			const { f, options } = context();
			await f.signed(f.keyA, "POST", "/v1/auth/device-binding", {
				group_id: LEGACY_SETUP.groupId,
				identity_id: LEGACY_SETUP.identityId,
			});
			const transport = vi.fn<typeof fetch>(async (input, init) => {
				const response = await f.app.request(new Request(input, init));
				const value = (await response.json()) as { receipt: Record<string, unknown> };
				value.receipt[field] = "different-fixture-principal";
				return Response.json(value);
			});
			// Act
			const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual(unavailable("invalid_response"));
			expect(transport).toHaveBeenCalledTimes(1);
			expect(transport.mock.calls[0]?.[1]?.method).toBe("GET");
		},
	);

	it("reports an older coordinator as upgrade-needed without posting", async () => {
		// Arrange
		const { options } = context();
		const transport = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("Not Found", { status: 404 }));
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual({ kind: "unsupported", cause: "coordinator_upgrade_required" });
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0]?.[1]?.method).toBe("GET");
	});

	it("does not post when the server requires an ownership review", async () => {
		// Arrange
		const { options } = context();
		const transport = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ kind: "requires_review" }));
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual({ kind: "requires_review" });
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ kind: "complete", receipt: { device_id: "other-device" } },
		{ kind: "ready", receipt: { ignored: true } },
		{ kind: "completed", receipt: {} },
	])("rejects malformed or unsolicited GET success %j without posting", async (value) => {
		// Arrange
		const { options } = context();
		const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual(unavailable("invalid_response"));
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ status: 401, cause: "coordinator_rejected" },
		{ status: 429, cause: "rate_limited" },
		{ status: 503, cause: "coordinator_unavailable" },
	])("does not treat readiness HTTP $status as completion", async ({ status, cause }) => {
		// Arrange
		const { options } = context();
		const transport = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("unavailable", { status }));
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual(unavailable(cause));
		expect(transport).toHaveBeenCalledTimes(1);
	});
}

describe.each(["SQLite", "D1"] as const)("%s device setup client", (backend) => {
	let f: LinkedLegacySetupFixture;
	let options: CoordinatorDeviceSetupOptions;
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(LEGACY_SETUP.now);
		localFiles.read.mockReset();
		localFiles.sign.mockReset();
		f = await linkedLegacySetupFixture(backend, { authConfigured: true });
		localFiles.read.mockReturnValue({
			deviceId: f.keyA.deviceId,
			publicKey: f.keyA.publicKey,
			fingerprint: f.keyA.fingerprint,
		});
		localFiles.sign.mockImplementation(
			(input: { method: string; url: string; bodyBytes: Buffer }) => {
				const url = new URL(input.url);
				const { "content-type": _contentType, ...headers } = signedHeaders(
					f.keyA,
					input.method,
					`${url.pathname}${url.search}`,
					input.bodyBytes.toString(),
				);
				return headers;
			},
		);
		options = {
			dbPath: "synthetic-unused.sqlite",
			coordinatorUrl: "https://coordinator.example.test",
			groupId: LEGACY_SETUP.groupId,
			currentIdentityId: LEGACY_SETUP.identityId,
			fetch: async (input, init) => f.app.request(new Request(input, init)),
		};
	});
	afterEach(async () => {
		await f?.close();
		vi.useRealTimers();
	});
	registerReceiptRecoveryTests(() => ({ f, options }));
	registerResponseDenialTests(() => ({ f, options }));
	registerSchemaRefusalTests(() => ({ f, options }));
	registerCapturedOptionsTest(() => ({ f, options }));
	registerConnectRequiredTests(() => ({ f, options }));
	registerCapabilitiesCompatibilityTests();

	it("refuses invalid input before reading local evidence or sending requests", async () => {
		// Arrange
		const transport = vi.fn<typeof fetch>();
		// Act
		const result = await completeCoordinatorDeviceSetup({
			...options,
			currentIdentityId: "",
			fetch: transport,
		});
		// Assert
		expect(result).toEqual(unavailable("invalid_input"));
		expect(localFiles.read).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});

	it("refuses missing local device evidence before sending requests", async () => {
		// Arrange
		localFiles.read.mockImplementation(() => {
			throw new Error("synthetic unavailable local key");
		});
		const transport = vi.fn<typeof fetch>();
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual(unavailable("device_unavailable"));
		expect(transport).not.toHaveBeenCalled();
	});
});
