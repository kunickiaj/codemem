import { expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";

export interface KeyIdFillApiFixture {
	store: Store;
	exec(sql: string): Promise<void>;
}

const ADMIN_SECRET = "disposable-fill-test-secret";
const PATH = "/v1/admin/devices/key-id-fill";

export function keyIdFillApiHarness(
	fixture: (use: (value: KeyIdFillApiFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: KeyIdFillApiFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}

type FillTest = ReturnType<typeof keyIdFillApiHarness>;

function api(f: KeyIdFillApiFixture) {
	const close = vi.spyOn(f.store, "close").mockResolvedValue();
	const app = createCoordinatorApp({
		storeFactory: () => f.store,
		runtime: { adminSecret: () => ADMIN_SECRET, now: () => "2026-11-18T00:00:00.000Z" },
		requestVerifier: async () => false,
	});
	const post = (body: unknown, secret = ADMIN_SECRET) =>
		app.request(PATH, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Codemem-Coordinator-Admin": secret },
			body: JSON.stringify(body),
		});
	return { post, close };
}

async function legacyRows(f: KeyIdFillApiFixture) {
	await f.store.createGroup("fill-group");
	await f.exec(`INSERT INTO enrolled_devices
		(group_id, device_id, public_key, fingerprint, enabled, created_at)
		VALUES ('fill-group', 'fill-one', 'opaque-one', 'fp-one', 1, 'then'),
		('fill-group', 'fill-two', 'opaque-two', 'fp-two', 1, 'then')`);
}

export function registerKeyIdFillApiContract(test: FillTest) {
	registerAuthorization(test);
	registerPaging(test);
	registerErrors(test);
}

function registerAuthorization(test: FillTest) {
	test("requires the admin secret before creating a store or filling any key IDs", async ({
		fixture: f,
	}) => {
		const { post, close } = api(f);
		const fill = vi.spyOn(f.store, "fillEnrollmentKeyIds");
		for (const secret of ["", "wrong"]) {
			expect((await post({}, secret)).status).toBe(401);
		}
		expect(fill).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});
}

function registerPaging(test: FillTest) {
	test("fills pre-upgrade enrollments page by page and makes removal available", async ({
		fixture: f,
	}) => {
		await legacyRows(f);
		await expect(f.store.removeDevice("fill-group", "fill-one")).rejects.toThrow(
			"device_removal_unavailable",
		);
		const { post, close } = api(f);
		const first = await post({ limit: 1 });
		expect(first.status).toBe(200);
		const page = (await first.json()) as { next: number };
		expect(page).toEqual({
			version: 1,
			filled: 1,
			blocked: 0,
			skipped: 0,
			remaining: true,
			next: expect.any(Number),
		});
		const second = await post({ limit: 1, after: page.next });
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({
			version: 1,
			filled: 1,
			blocked: 0,
			skipped: 0,
			remaining: false,
		});
		expect(await f.store.removeDevice("fill-group", "fill-one")).toBe(true);
		const repeated = await post({});
		expect(await repeated.json()).toEqual({
			version: 1,
			filled: 0,
			blocked: 0,
			skipped: 0,
			remaining: false,
			next: null,
		});
		expect(close).toHaveBeenCalledTimes(3);
	});
}

function registerErrors(test: FillTest) {
	test("rejects invalid page options without writing", async ({ fixture: f }) => {
		const { post } = api(f);
		const fill = vi.spyOn(f.store, "fillEnrollmentKeyIds");
		for (const body of [
			{ limit: 0 },
			{ limit: "1" },
			{ limit: 1.5 },
			{ after: -1 },
			{ after: "1" },
			{ after: 1.5 },
			{ unknown: true },
			[],
			null,
		]) {
			expect((await post(body)).status).toBe(400);
		}
		expect(fill).not.toHaveBeenCalled();
	});

	test("reports fixed failures and closes the store", async ({ fixture: f }) => {
		const { post, close } = api(f);
		const fill = vi.spyOn(f.store, "fillEnrollmentKeyIds");
		fill.mockRejectedValueOnce(new Error("device_removal_unavailable"));
		const unavailable = await post({});
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toEqual({ error: "device_removal_unavailable" });
		fill.mockRejectedValueOnce(new Error("private database driver detail"));
		const failed = await post({});
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ error: "device_removal_incomplete" });
		expect(close).toHaveBeenCalledTimes(2);
	});

	test("reports blocked rows without erasing their tombstone", async ({ fixture: f }) => {
		await legacyRows(f);
		await f.exec(`INSERT INTO coordinator_device_removals
			(removal_id, group_id, device_id, public_key, fingerprint, removed_at)
			VALUES ('fill-removal', 'fill-group', 'fill-one', 'opaque-one', 'fp-one', 'then')`);
		const { post } = api(f);
		const response = await post({});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			filled: 1,
			blocked: 1,
			skipped: 0,
			remaining: false,
		});
		await expect(f.store.removeDevice("fill-group", "fill-two")).rejects.toThrow(
			"device_removal_unavailable",
		);
	});
}
