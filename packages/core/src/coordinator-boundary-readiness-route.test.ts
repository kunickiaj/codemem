import { describe, expect, it, vi } from "vitest";
import { type CoordinatorRequestVerifier, createCoordinatorApp } from "./coordinator-api.js";
import { fitBoundaryReadinessProjects } from "./coordinator-boundary-readiness.js";
import type { CoordinatorEnrollment, CoordinatorStore } from "./coordinator-store-contract.js";

const caller: CoordinatorEnrollment = {
	group_id: "g1",
	device_id: "device-a",
	public_key: "pk-a",
	fingerprint: "fp-a",
	identity_id: null,
	display_name: "Laptop",
	enabled: 1,
	created_at: "2026-03-28T00:00:00Z",
};
const project = {
	source_scope_id: "team:g1:default",
	boundary_scope_id: `managed-project:${"a".repeat(64)}`,
	state: "waiting",
	own_rows_in_source: 412,
	own_rows_in_boundary: 0,
};
const record = { version: 1, sequence: 3, projects: [project] };
const allowRequest: CoordinatorRequestVerifier = async () => true;

/** Only what a signed request and these two routes use. Anything else would throw. */
function mockStore(overrides: Partial<CoordinatorStore> = {}) {
	return {
		close: vi.fn(async () => undefined),
		getEnrollment: vi.fn(async (): Promise<CoordinatorEnrollment | null> => caller),
		getGroup: vi.fn(async () => ({
			group_id: "g1",
			display_name: "Group 1",
			archived_at: null,
			created_at: "2026-03-28T00:00:00Z",
		})),
		recordAuthorizedNonce: vi.fn(async () => "recorded" as const),
		cleanupNonces: vi.fn(async () => undefined),
		putBoundaryReadiness: vi.fn(async () => ({
			kind: "stored" as const,
			sequence: 3,
			rejected: [],
		})),
		discardBoundaryReadiness: vi.fn(async () => false),
		upsertPresence: vi.fn(async () => ({
			group_id: "g1",
			device_id: "device-a",
			addresses: [],
			expires_at: "2026-03-28T00:03:00Z",
		})),
		...overrides,
	};
}

function readinessApp(overrides: Partial<CoordinatorStore> = {}) {
	const store = mockStore(overrides);
	const app = createCoordinatorApp({
		storeFactory: () => store as unknown as CoordinatorStore,
		runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
		requestVerifier: allowRequest,
	});
	return { store, app };
}
type App = ReturnType<typeof readinessApp>["app"];

const signedHeaders = {
	"Content-Type": "application/json",
	"X-Opencode-Device": "device-a",
	"X-Opencode-Signature": "sig",
	"X-Opencode-Timestamp": "2026-03-28T00:00:00Z",
	"X-Opencode-Nonce": "nonce-a",
};

function send(app: App, body: unknown, query = "?group_id=g1") {
	return app.request(`/v1/boundary-readiness${query}`, {
		method: "POST",
		headers: signedHeaders,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function presence(app: App, capabilities: unknown) {
	return app.request("/v1/presence", {
		method: "POST",
		headers: signedHeaders,
		body: JSON.stringify({ group_id: "g1", addresses: [], capabilities }),
	});
}

describe("POST /v1/boundary-readiness stores a record", () => {
	it("stores the record for the device whose key signed the request", async () => {
		const { app, store } = readinessApp();

		const response = await send(app, { ...record, omitted_projects: 2 });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			version: 1,
			status: "stored",
			sequence: 3,
			rejected: [],
		});
		expect(store.putBoundaryReadiness).toHaveBeenCalledWith({
			groupId: "g1",
			deviceId: "device-a",
			sequence: 3,
			omittedProjects: 2,
			projects: [project],
		});
	});

	it("names the entries the coordinator left out", async () => {
		const rejected = [
			{
				source_scope_id: project.source_scope_id,
				boundary_scope_id: project.boundary_scope_id,
				reason: "source_scope_not_authorized" as const,
			},
		];
		const { app } = readinessApp({
			putBoundaryReadiness: vi.fn(async () => ({
				kind: "stored" as const,
				sequence: 3,
				rejected,
			})),
		});

		const response = await send(app, record);

		expect(await response.json()).toMatchObject({ status: "stored", rejected });
	});

	it("answers with the stored sequence when the record is not newer", async () => {
		const { app } = readinessApp({
			putBoundaryReadiness: vi.fn(async () => ({ kind: "stale" as const, sequence: 9 })),
		});

		const response = await send(app, record);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ version: 1, status: "stale", sequence: 9 });
	});

	it("accepts a body that names the signing device and its group", async () => {
		const { app } = readinessApp();

		const response = await send(app, { ...record, device_id: "device-a", group_id: "g1" });

		expect(response.status).toBe(200);
	});
});

describe("POST /v1/boundary-readiness refuses a request", () => {
	it("rejects a request without a valid device signature, and stores nothing", async () => {
		const { app, store } = readinessApp({ getEnrollment: vi.fn(async () => null) });

		const response = await send(app, record);

		expect(response.status).toBe(401);
		expect(store.putBoundaryReadiness).not.toHaveBeenCalled();
	});

	it.each([
		["another device", { device_id: "device-b" }, "device_id_mismatch"],
		["another group", { group_id: "g2" }, "group_id_mismatch"],
	])("rejects a body that names %s", async (_name, extra, error) => {
		const { app, store } = readinessApp();

		const response = await send(app, { ...record, ...extra });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error });
		expect(store.putBoundaryReadiness).not.toHaveBeenCalled();
	});

	it.each([
		["no group", record, "", "group_id_required"],
		["a body that is not JSON", "{", "?group_id=g1", "invalid_json"],
		["another version", { ...record, version: 2 }, "?group_id=g1", "readiness_version_unsupported"],
		["no sequence", { version: 1, projects: [] }, "?group_id=g1", "readiness_record_invalid"],
		["no Project list", { version: 1, sequence: 1 }, "?group_id=g1", "readiness_record_invalid"],
		[
			"an omitted count that is not a number",
			{ ...record, omitted_projects: "2" },
			"?group_id=g1",
			"readiness_record_invalid",
		],
	])("rejects a request with %s", async (_name, body, query, error) => {
		const { app, store } = readinessApp();

		const response = await send(app, body, query);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error });
		expect(store.putBoundaryReadiness).not.toHaveBeenCalled();
	});
});

describe("POST /v1/boundary-readiness when the store cannot take the record", () => {
	it.each([
		["invalid_input", 400, "readiness_record_invalid"],
		["boundary_readiness_too_large", 413, "boundary_readiness_too_large"],
		["database is locked", 503, "boundary_readiness_unavailable"],
		["boundary_readiness_authorization_unavailable", 503, "boundary_readiness_unavailable"],
	])("answers a store failure of %s with %i", async (message, status, error) => {
		const { app } = readinessApp({
			putBoundaryReadiness: vi.fn(async () => {
				throw new Error(message);
			}),
		});

		const response = await send(app, record);

		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
	});

	it.each([
		[{ kind: "unavailable" as const }, 503, "boundary_readiness_unavailable"],
		[{ kind: "not_enrolled" as const }, 403, "device_not_enrolled"],
	])("answers %o with %i", async (result, status, error) => {
		const { app } = readinessApp({ putBoundaryReadiness: vi.fn(async () => result) });

		const response = await send(app, record);

		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
	});

	it("accepts a record of the largest size the store takes, and refuses a larger body", async () => {
		const { app, store } = readinessApp();
		const many = Array.from({ length: 5000 }, (_, index) => ({
			...project,
			boundary_scope_id: `managed-project:${index.toString(16).padStart(64, "0")}`,
		}));
		const fitted = fitBoundaryReadinessProjects(many);

		const accepted = await send(app, {
			version: 1,
			sequence: 1,
			omitted_projects: fitted.omittedProjects,
			projects: fitted.projects,
		});
		const refused = await send(app, { version: 1, sequence: 2, projects: many });

		expect(accepted.status).toBe(200);
		expect(refused.status).toBe(413);
		expect(await refused.json()).toEqual({ error: "body_too_large" });
		expect(store.putBoundaryReadiness).toHaveBeenCalledTimes(1);
	});
});

describe("POST /v1/presence and the device's readiness record", () => {
	it.each([
		["no capabilities", undefined],
		["no sync features", { sync_capability: "scoped" }],
		["other sync features only", { sync_features: ["reassign_scope", "relay_aware"] }],
		["capabilities that are not an object", "project_boundary_migration_v1"],
	])("discards the device's record when presence has %s", async (_name, capabilities) => {
		const { app, store } = readinessApp();

		const response = await presence(app, capabilities);

		expect(response.status).toBe(200);
		expect(store.discardBoundaryReadiness).toHaveBeenCalledWith({
			groupId: "g1",
			deviceId: "device-a",
		});
	});

	it("keeps the record when presence advertises the migration feature", async () => {
		const { app, store } = readinessApp();

		const response = await presence(app, {
			sync_features: ["reassign_scope", "project_boundary_migration_v1"],
		});

		expect(response.status).toBe(200);
		expect(store.discardBoundaryReadiness).not.toHaveBeenCalled();
		expect(store.upsertPresence).toHaveBeenCalledWith(
			expect.objectContaining({
				capabilities: { sync_features: ["reassign_scope", "project_boundary_migration_v1"] },
			}),
		);
	});

	it("discards before it stores presence, and stores no presence when the discard fails", async () => {
		const { app, store } = readinessApp({
			discardBoundaryReadiness: vi.fn(async () => {
				throw new Error("database is locked");
			}),
		});

		const response = await presence(app, undefined);

		expect(response.status).toBe(500);
		expect(store.upsertPresence).not.toHaveBeenCalled();
	});

	it("does not discard for a request that fails authentication", async () => {
		const { app, store } = readinessApp({ getEnrollment: vi.fn(async () => null) });

		const response = await presence(app, undefined);

		expect(response.status).toBe(401);
		expect(store.discardBoundaryReadiness).not.toHaveBeenCalled();
	});
});
