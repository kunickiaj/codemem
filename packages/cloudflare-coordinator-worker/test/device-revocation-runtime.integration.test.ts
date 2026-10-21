import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "../../core/src/coordinator-account-connection-schema.js";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import * as coordinator from "../../core/src/internal/cloudflare-coordinator.js";
import {
	type CloudflareCoordinatorEnv,
	createCloudflareCoordinatorWorker,
	createConfiguredCloudflareCoordinatorWorker,
} from "../src/index.js";

const preview = "/v1/admin/devices/revoke-preview";
const commit = "/v1/admin/devices/revoke";
const input = { group_id: "runtime-group", device_id: "runtime-device" };
const config = {
	enabled: true,
	ownerEnrollmentEnabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	clientId: "test-client",
	redirectUri: "https://coordinator.example.test/auth/callback",
	revision: "a".repeat(64),
};
function bindings(): CloudflareCoordinatorEnv {
	return {
		...env,
		CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
		CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(config),
		CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: "fixture-client-secret",
		CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: "11".repeat(32),
	};
}
function request(path = preview, options: RequestInit = {}) {
	return new Request(`https://coordinator.example.test${path}`, {
		method: "POST",
		body: JSON.stringify(input),
		...options,
		headers: {
			"Content-Type": "application/json",
			"X-Codemem-Coordinator-Admin": "test-secret",
			...Object.fromEntries(new Headers(options.headers)),
		},
	});
}
beforeEach(async () => {
	await env.COORDINATOR_DB.prepare("DELETE FROM coordinator_device_revocations").run();
	await env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?")
		.bind(input.group_id)
		.run();
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});
async function seed() {
	const store = new D1CoordinatorStore(env.COORDINATOR_DB);
	await store.createGroup(input.group_id);
	await store.enrollDevice(input.group_id, {
		deviceId: input.device_id,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
	});
	return store;
}
it("mounted configured Worker previews and commits two native D1 tombstones without browser setup", async () => {
	// Arrange
	const store = await seed();
	const worker = createConfiguredCloudflareCoordinatorWorker();
	const setup = vi.spyOn(coordinator, "createCoordinatorBrowserAuth");
	const admission = vi.spyOn(coordinator, "importOwnerEnrollmentAdmissionKey");
	const close = vi.spyOn(D1CoordinatorStore.prototype, "close");
	// Act
	const response = await worker.fetch(request(), bindings());
	const evidence = (await response.json()) as { expected_digest: string };
	const before = await store.listDeviceRevocations({ deviceId: input.device_id });
	const stale = await worker.fetch(
		request(commit, { body: JSON.stringify({ ...input, expected_digest: "0".repeat(64) }) }),
		bindings(),
	);
	const afterStale = await store.listDeviceRevocations({ deviceId: input.device_id });
	const result = await worker.fetch(
		request(commit, {
			body: JSON.stringify({ ...input, expected_digest: evidence.expected_digest }),
		}),
		bindings(),
	);
	// Assert
	expect(response.status).toBe(200);
	expect(before).toEqual([]);
	expect(stale.status).toBe(409);
	expect(afterStale).toEqual([]);
	expect(result.status).toBe(200);
	expect(await result.json()).toMatchObject({
		state: "revoked",
		coordinator_id: config.coordinatorId,
		revocations: [{ subject_kind: "device_id" }, { subject_kind: "ed25519_key" }],
	});
	expect(
		await store.listDeviceRevocations({
			deviceId: input.device_id,
			publicKey: CANONICAL_PUBLIC_KEY,
		}),
	).toHaveLength(2);
	expect(close).toHaveBeenCalledTimes(3);
	expect(setup).not.toHaveBeenCalled();
	expect(admission).not.toHaveBeenCalled();
});
it.each([
	["anonymous", 401],
	["invalid JSON", 400],
	["unconfigured", 503],
	["missing config", 503],
	["disabled", 503],
	["invalid config", 503],
	["unbound", 503],
] as const)("rejects %s without any native D1 access", async (kind, status) => {
	// Arrange
	const selected = bindings();
	const prepare = vi.spyOn(env.COORDINATOR_DB, "prepare");
	const read = vi.spyOn(D1CoordinatorStore.prototype, "getEnrollment");
	let worker = createConfiguredCloudflareCoordinatorWorker();
	if (kind === "unconfigured") worker = createCloudflareCoordinatorWorker();
	if (kind === "missing config") delete selected.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG;
	if (kind === "disabled")
		selected.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({
			enabled: false,
			coordinatorId: config.coordinatorId,
		});
	if (kind === "invalid config")
		selected.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({
			...config,
			coordinatorId: "bad\nID",
		});
	if (kind === "unbound") delete selected.COORDINATOR_DB;
	const req = request(
		preview,
		kind === "anonymous" ? { headers: { "X-Codemem-Coordinator-Admin": "wrong" } } : {},
	);
	const getReader = vi.fn();
	if (kind === "invalid JSON")
		Object.defineProperty(req, "body", {
			value: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("{"));
					controller.close();
				},
			}),
		});
	else Object.defineProperty(req, "body", { value: { getReader } });
	// Act
	const response = await worker.fetch(req, selected);
	// Assert
	expect(response.status).toBe(status);
	expect(prepare).not.toHaveBeenCalled();
	expect(read).not.toHaveBeenCalled();
	expect(getReader).not.toHaveBeenCalled();
});
it.each(["database", "config", "disabled"])(
	"rejects %s drift after selecting native D1 without falling back",
	async (kind) => {
		// Arrange
		await seed();
		const selected = bindings();
		const worker = createConfiguredCloudflareCoordinatorWorker();
		const first = await worker.fetch(request(), selected);
		const prepare = vi.spyOn(env.COORDINATOR_DB, "prepare");
		const alternate = {
			prepare: vi.fn(() => {
				throw new Error("alternate database forbidden");
			}),
			batch: vi.fn(),
		};
		if (kind === "database") selected.COORDINATOR_DB = alternate;
		if (kind === "config")
			selected.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({
				...config,
				coordinatorId: "coordinator-b",
			});
		if (kind === "disabled")
			selected.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({
				enabled: false,
				coordinatorId: config.coordinatorId,
			});
		// Act
		const response = await worker.fetch(request(), selected);
		// Assert
		expect(first.status).toBe(200);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "revocation_unavailable" });
		expect(prepare).not.toHaveBeenCalled();
		expect(alternate.prepare).not.toHaveBeenCalled();
	},
);
it("captures native D1, admin secret, and validated coordinator ID before body awaits", async () => {
	// Arrange
	await seed();
	const selected = bindings();
	const worker = createConfiguredCloudflareCoordinatorWorker();
	const stream = new TransformStream<Uint8Array, Uint8Array>();
	const writer = stream.writable.getWriter();
	const pending = worker.fetch(request(preview, { body: stream.readable }), selected);
	const alternate = {
		prepare: vi.fn(() => {
			throw new Error("alternate database forbidden");
		}),
		batch: vi.fn(),
	};
	selected.COORDINATOR_DB = alternate;
	selected.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "replacement-secret";
	selected.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({
		...config,
		coordinatorId: "coordinator-b",
	});
	// Act
	await writer.write(new TextEncoder().encode(JSON.stringify(input)));
	await writer.close();
	const response = await pending;
	const drift = await worker.fetch(request(), selected);
	// Assert
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ coordinator_id: config.coordinatorId });
	expect(alternate.prepare).not.toHaveBeenCalled();
	expect(drift.status).toBe(401);
});

it.each(["qualification", "revocation"] as const)(
	"shares the configured D1 pin when %s selects the binding first",
	async (firstRoute) => {
		// Arrange: distinct binding identities forward to the migrated native test D1.
		const backend = coordinator.createD1AuthLinkBackend(env.COORDINATOR_DB);
		if ((await readConnectionSchemaState(backend)) !== "ready")
			await applyAccountConnectionSchema(backend);
		const store = await seed();
		const trackedBinding = () => ({
			prepare: vi.fn((sql: string) => env.COORDINATOR_DB.prepare(sql)),
			batch: vi.fn((statements: D1PreparedStatement[]) => env.COORDINATOR_DB.batch(statements)),
		});
		const dbA = trackedBinding();
		const dbB = trackedBinding();
		const selected = { ...bindings(), COORDINATOR_DB: dbA };
		const worker = createConfiguredCloudflareCoordinatorWorker();
		const qualification = () =>
			request("/v1/admin/owner-qualifications", {
				body: JSON.stringify({ attestation_id: `controller-v1:${"f".repeat(64)}` }),
			});
		const firstRequest = firstRoute === "qualification" ? qualification() : request();
		const secondRequest = firstRoute === "qualification" ? request() : qualification();
		// Act: keep issuer, coordinator ID, raw config and credential unchanged; swap only D1.
		const first = await worker.fetch(firstRequest, selected);
		const reads = dbA.prepare.mock.calls.length;
		selected.COORDINATOR_DB = dbB;
		const second = await worker.fetch(secondRequest, selected);
		// Assert: healthy read-only lookup/preview pins A across both administrative routes.
		expect(first.status).toBe(firstRoute === "qualification" ? 409 : 200);
		if (firstRoute === "revocation")
			expect(await first.json()).toMatchObject({
				state: "ready",
				coordinator_id: config.coordinatorId,
			});
		expect(reads).toBeGreaterThan(0);
		expect(second.status).toBe(503);
		expect(dbA.prepare).toHaveBeenCalledTimes(reads);
		expect(dbA.batch).not.toHaveBeenCalled();
		expect(dbB.prepare).not.toHaveBeenCalled();
		expect(dbB.batch).not.toHaveBeenCalled();
		expect(
			await store.listDeviceRevocations({
				deviceId: input.device_id,
				publicKey: CANONICAL_PUBLIC_KEY,
			}),
		).toEqual([]);
	},
);

it("resolves rotated SDK admin credentials per request while retaining an in-flight snapshot", async () => {
	// Arrange: one native D1 SDK app, with the same database and trusted context throughout.
	const store = await seed();
	const options = {
		db: env.COORDINATOR_DB,
		adminSecret: "test-secret",
		deviceRevocation: { coordinatorId: config.coordinatorId },
		requestVerifier: vi.fn(() => false),
	};
	const app = coordinator.createD1CoordinatorApp(options);
	const first = await app.fetch(request());
	const stream = new TransformStream<Uint8Array, Uint8Array>();
	const writer = stream.writable.getWriter();
	// Act: rotate only after a successful request; the already-started request keeps its snapshot.
	const pending = app.fetch(request(preview, { body: stream.readable }));
	options.adminSecret = "rotated-admin-secret";
	await writer.write(new TextEncoder().encode(JSON.stringify(input)));
	await writer.close();
	const captured = await pending;
	const oldCredential = await app.fetch(request());
	const rotated = request();
	rotated.headers.set("X-Codemem-Coordinator-Admin", options.adminSecret);
	const newCredential = await app.fetch(rotated);
	// Assert: rotation takes effect without rebuilding the app or changing its selected backend.
	expect(first.status).toBe(200);
	expect(captured.status).toBe(200);
	expect(oldCredential.status).toBe(401);
	expect(newCredential.status).toBe(200);
	expect(await captured.json()).toEqual(await first.json());
	expect(await newCredential.json()).toMatchObject({
		state: "ready",
		coordinator_id: config.coordinatorId,
	});
	expect(options.requestVerifier).not.toHaveBeenCalled();
	expect(await store.listDeviceRevocations({ deviceId: input.device_id })).toEqual([]);
});
