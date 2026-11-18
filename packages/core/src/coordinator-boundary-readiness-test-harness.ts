import { expect, it } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import type {
	BoundaryReadinessProject,
	PutBoundaryReadinessInput,
} from "./coordinator-boundary-readiness.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";

/** A store and a prefix that no other test uses, so tests can share one database. */
export type BoundaryReadinessFixture = { store: Store; prefix: string };

export function boundaryReadinessHarness(
	fixture: (use: (f: BoundaryReadinessFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: BoundaryReadinessFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export type BoundaryReadinessTest = ReturnType<typeof boundaryReadinessHarness>;

/** The clock every fixture injects into its store. */
export const BOUNDARY_READINESS_CLOCK_MS = Date.UTC(2026, 10, 18, 12, 0, 0);
const CLOCK_ISO = new Date(BOUNDARY_READINESS_CLOCK_MS).toISOString();

const boundaryId = (digit: string) => `managed-project:${digit.repeat(64)}`;
const BOUNDARY = boundaryId("a");
const OTHER_BOUNDARY = boundaryId("b");

interface World {
	store: Store;
	groupId: string;
	deviceId: string;
	sourceScopeId: string;
}

/** A group with one older scope, and one enrolled device that is a member of it. */
async function world(f: BoundaryReadinessFixture): Promise<World> {
	const groupId = `${f.prefix}-group`;
	const sourceScopeId = `${f.prefix}-source`;
	const deviceId = `${f.prefix}-device`;
	await f.store.createGroup(groupId);
	await addScope(f.store, groupId, sourceScopeId);
	await enroll(f.store, groupId, deviceId);
	await grant(f.store, sourceScopeId, deviceId);
	return { store: f.store, groupId, deviceId, sourceScopeId };
}

async function addScope(store: Store, groupId: string, scopeId: string) {
	await store.createScope({
		scopeId,
		label: scopeId,
		groupId,
		authorityType: "coordinator",
		membershipEpoch: 1,
	});
}

async function enroll(store: Store, groupId: string, deviceId: string) {
	await store.enrollDevice(groupId, {
		deviceId,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "fixture-fingerprint",
	});
}

async function grant(store: Store, scopeId: string, deviceId: string) {
	await store.grantScopeMembership({
		scopeId,
		deviceId,
		effectId: `grant:${scopeId}:${deviceId}`,
		membershipEpoch: 1,
	});
}

function project(
	w: World,
	overrides: Partial<BoundaryReadinessProject> = {},
): BoundaryReadinessProject {
	return {
		source_scope_id: w.sourceScopeId,
		boundary_scope_id: BOUNDARY,
		state: "waiting",
		own_rows_in_source: 412,
		own_rows_in_boundary: 0,
		...overrides,
	};
}

function put(w: World, overrides: Partial<PutBoundaryReadinessInput> = {}) {
	return w.store.putBoundaryReadiness({
		groupId: w.groupId,
		deviceId: w.deviceId,
		sequence: 1,
		projects: [project(w)],
		...overrides,
	});
}

const stored = (w: World) =>
	w.store.getBoundaryReadiness({ groupId: w.groupId, deviceId: w.deviceId });

function registerStoring(test: BoundaryReadinessTest) {
	test("has no record for a device that never sent one", async ({ fixture }) => {
		const w = await world(fixture);

		expect(await stored(w)).toBeNull();
	});

	test("stores a record with the Projects of an older scope the device is in", async ({
		fixture,
	}) => {
		const w = await world(fixture);

		const result = await put(w);

		expect(result).toEqual({ kind: "stored", sequence: 1, rejected: [] });
		expect(await stored(w)).toEqual({
			group_id: w.groupId,
			device_id: w.deviceId,
			sequence: 1,
			updated_at: CLOCK_ISO,
			projects: [project(w)],
		});
	});

	test("stores a record with no Projects, which says the device runs the migration code", async ({
		fixture,
	}) => {
		const w = await world(fixture);

		const result = await put(w, { projects: [] });

		expect(result).toEqual({ kind: "stored", sequence: 1, rejected: [] });
		expect(await stored(w)).toMatchObject({ sequence: 1, projects: [] });
	});

	test("replaces every Project of the earlier record when a newer one arrives", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await put(w);

		const result = await put(w, {
			sequence: 2,
			projects: [project(w, { boundary_scope_id: OTHER_BOUNDARY, state: "adopted" })],
		});

		expect(result).toMatchObject({ kind: "stored", sequence: 2 });
		expect((await stored(w))?.projects).toEqual([
			project(w, { boundary_scope_id: OTHER_BOUNDARY, state: "adopted" }),
		]);
	});

	test("keeps one Project listed under two older scopes as two entries", async ({ fixture }) => {
		const w = await world(fixture);
		const second = `${fixture.prefix}-second-source`;
		await addScope(w.store, w.groupId, second);
		await grant(w.store, second, w.deviceId);

		await put(w, { projects: [project(w), project(w, { source_scope_id: second })] });

		expect((await stored(w))?.projects).toHaveLength(2);
	});

	test("keeps each device's record apart", async ({ fixture }) => {
		const w = await world(fixture);
		const other = { ...w, deviceId: `${fixture.prefix}-other-device` };
		await enroll(w.store, w.groupId, other.deviceId);
		await grant(w.store, w.sourceScopeId, other.deviceId);
		await put(w);

		await put(other, { sequence: 7, projects: [] });

		expect(await stored(w)).toMatchObject({ sequence: 1, projects: [project(w)] });
		expect(await stored(other)).toMatchObject({ sequence: 7, projects: [] });
	});
}

function registerOrdering(test: BoundaryReadinessTest) {
	for (const sequence of [2, 1]) {
		test(`does not replace a record at sequence 2 with one at sequence ${sequence}`, async ({
			fixture,
		}) => {
			const w = await world(fixture);
			await put(w, { sequence: 2 });

			const result = await put(w, {
				sequence,
				projects: [project(w, { boundary_scope_id: OTHER_BOUNDARY })],
			});

			expect(result).toEqual({ kind: "stale", sequence: 2 });
			expect(await stored(w)).toMatchObject({ sequence: 2, projects: [project(w)] });
		});
	}
}

function registerEnrollmentChecks(test: BoundaryReadinessTest) {
	test("refuses a device with no enrollment in the group", async ({ fixture }) => {
		const w = await world(fixture);
		const stranger = { ...w, deviceId: `${fixture.prefix}-stranger` };

		const result = await put(stranger, { projects: [] });

		expect(result).toEqual({ kind: "not_enrolled" });
		expect(await stored(stranger)).toBeNull();
	});

	test("refuses a device whose enrollment is disabled", async ({ fixture }) => {
		const w = await world(fixture);
		await w.store.setDeviceEnabled(w.groupId, w.deviceId, false);

		const result = await put(w, { projects: [] });

		expect(result).toEqual({ kind: "not_enrolled" });
		expect(await stored(w)).toBeNull();
	});
}

function registerProjectChecks(test: BoundaryReadinessTest) {
	test("leaves out a Project under an older scope the device is not a member of", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const foreign = `${fixture.prefix}-foreign-source`;
		await addScope(w.store, w.groupId, foreign);
		const entry = project(w, { source_scope_id: foreign, boundary_scope_id: OTHER_BOUNDARY });

		const result = await put(w, { projects: [project(w), entry] });

		expect(result).toEqual({
			kind: "stored",
			sequence: 1,
			rejected: [
				{
					source_scope_id: foreign,
					boundary_scope_id: OTHER_BOUNDARY,
					reason: "source_scope_not_authorized",
				},
			],
		});
		expect((await stored(w))?.projects).toEqual([project(w)]);
	});

	test("leaves out a Project under an older scope the device was removed from", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await w.store.revokeScopeMembership({
			scopeId: w.sourceScopeId,
			deviceId: w.deviceId,
			effectId: `revoke:${w.sourceScopeId}:${w.deviceId}`,
		});

		const result = await put(w);

		expect(result).toMatchObject({
			kind: "stored",
			rejected: [{ reason: "source_scope_not_authorized" }],
		});
		expect((await stored(w))?.projects).toEqual([]);
	});

	test("leaves out a Project under a scope that does not exist", async ({ fixture }) => {
		const w = await world(fixture);

		const result = await put(w, {
			projects: [project(w, { source_scope_id: `${fixture.prefix}-missing` })],
		});

		expect(result).toMatchObject({
			kind: "stored",
			rejected: [{ reason: "source_scope_not_authorized" }],
		});
	});

	for (const boundary of ["team:group:default", "managed-project:abc", `${BOUNDARY}0`]) {
		test(`leaves out a Project whose boundary ID is ${boundary.slice(0, 24)}`, async ({
			fixture,
		}) => {
			const w = await world(fixture);

			const result = await put(w, { projects: [project(w, { boundary_scope_id: boundary })] });

			expect(result).toMatchObject({
				kind: "stored",
				rejected: [{ boundary_scope_id: boundary, reason: "boundary_scope_invalid" }],
			});
			expect((await stored(w))?.projects).toEqual([]);
		});
	}
}

const INVALID_RECORDS: {
	name: string;
	change: (w: World) => Partial<PutBoundaryReadinessInput>;
}[] = [
	{ name: "a sequence below one", change: () => ({ sequence: 0 }) },
	{ name: "a sequence that is not a whole number", change: () => ({ sequence: 1.5 }) },
	{ name: "an empty device ID", change: () => ({ deviceId: "" }) },
	{
		name: "an unknown Project state",
		change: (w) => ({ projects: [project(w, { state: "done" as never })] }),
	},
	{
		name: "a negative row count",
		change: (w) => ({ projects: [project(w, { own_rows_in_source: -1 })] }),
	},
	{
		name: "the same Project and older scope twice",
		change: (w) => ({ projects: [project(w), project(w, { state: "adopted" })] }),
	},
];

function registerInvalidInput(test: BoundaryReadinessTest) {
	for (const { name, change } of INVALID_RECORDS) {
		test(`rejects a record with ${name}, and stores nothing`, async ({ fixture }) => {
			const w = await world(fixture);

			await expect(put(w, change(w))).rejects.toThrow("invalid_input");

			expect(await stored(w)).toBeNull();
		});
	}
}

function registerDiscard(test: BoundaryReadinessTest) {
	test("discards a device's record and its Projects", async ({ fixture }) => {
		const w = await world(fixture);
		await put(w);

		const discarded = await w.store.discardBoundaryReadiness({
			groupId: w.groupId,
			deviceId: w.deviceId,
		});

		expect(discarded).toBe(true);
		expect(await stored(w)).toBeNull();
	});

	test("reports that there was nothing to discard", async ({ fixture }) => {
		const w = await world(fixture);

		const discarded = await w.store.discardBoundaryReadiness({
			groupId: w.groupId,
			deviceId: w.deviceId,
		});

		expect(discarded).toBe(false);
	});

	test("leaves another device's record when one is discarded", async ({ fixture }) => {
		const w = await world(fixture);
		const other = { ...w, deviceId: `${fixture.prefix}-other-device` };
		await enroll(w.store, w.groupId, other.deviceId);
		await put(w);
		await put(other, { projects: [] });

		await w.store.discardBoundaryReadiness({ groupId: w.groupId, deviceId: w.deviceId });

		expect(await stored(other)).toMatchObject({ sequence: 1 });
	});

	test("accepts a first sequence again after a discard, as a downgraded device restarts", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await put(w, { sequence: 9 });
		await w.store.discardBoundaryReadiness({ groupId: w.groupId, deviceId: w.deviceId });

		const result = await put(w, { sequence: 1 });

		expect(result).toMatchObject({ kind: "stored", sequence: 1 });
	});
}

/** The readiness record contract, for the SQLite store and both D1 runtimes. */
export function registerBoundaryReadinessContract(test: BoundaryReadinessTest): void {
	registerStoring(test);
	registerOrdering(test);
	registerEnrollmentChecks(test);
	registerProjectChecks(test);
	registerInvalidInput(test);
	registerDiscard(test);
}
