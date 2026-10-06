import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	revocationHarness,
	revocationInput,
} from "../../core/src/coordinator-device-revocation-test-harness.js";
import {
	registerEnrollmentRevocationContract,
	UNRELATED_PUBLIC_KEY,
} from "../../core/src/coordinator-enrollment-revocation-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 enrollment revocation", () => {
	const test = revocationHarness(async (use) => {
		const input = revocationInput(`enrollment-native-${++sequence}`);
		const store = new D1CoordinatorStore(env.COORDINATOR_DB);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const tables = ["enrolled_devices", "coordinator_device_revocations"];
		try {
			await use({
				store,
				input,
				exec: async (sql, ...values) => {
					await env.COORDINATOR_DB.prepare(sql)
						.bind(...values)
						.run();
				},
				rows: async (table) => {
					if (!tables.includes(table)) throw new Error("Unknown fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
						.results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_device_revocations"),
				env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id LIKE ?").bind(
					`${input.groupId}%`,
				),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id LIKE ?").bind(
					`${input.groupId}%`,
				),
			]);
		}
	});
	registerEnrollmentRevocationContract(test);
	registerNativeRevocationRaces(test);
	registerNativeKeyCapture(test);
});

function registerNativeRevocationRaces(test: ReturnType<typeof revocationHarness>) {
	for (const operation of ["enroll", "enable"] as const) {
		for (const subject of ["device_id", "ed25519_key"] as const) {
			test(`${operation} rejects ${subject} revocation restored immediately before native SQL`, async ({
				fixture: f,
			}) => {
				// Arrange: inject genuine records at execution, not in a preliminary eligibility lookup.
				await f.store.createGroup(f.input.groupId);
				await f.store.enrollDevice(f.input.groupId, f.input);
				await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
				await f.store.createDeviceRevocation(f.input);
				const records = (
					(await f.rows("coordinator_device_revocations")) as Record<string, unknown>[]
				).filter((row) => row.subject_kind === subject);
				await f.exec("DELETE FROM coordinator_device_revocations");
				const before = await f.rows("enrolled_devices");
				const hook = vi.fn(async (sql: string) => {
					if (
						!sql.includes("INSERT INTO enrolled_devices") &&
						!sql.includes("UPDATE enrolled_devices SET enabled")
					)
						return;
					for (const row of records) {
						const columns = Object.keys(row);
						await f.exec(
							`INSERT INTO coordinator_device_revocations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
							...Object.values(row),
						);
					}
				});
				const racing = new D1CoordinatorStore(beforeNativeWrite(hook));
				// Act
				const pending =
					operation === "enroll"
						? racing.enrollDevice(f.input.groupId, { ...f.input, displayName: "Must not write" })
						: racing.setDeviceEnabled(f.input.groupId, f.input.deviceId, true);
				// Assert
				if (operation === "enroll") await expect(pending).rejects.toThrow(/^device_revoked$/);
				else expect(await pending).toBe(false);
				expect(hook).toHaveBeenCalled();
				expect(await f.rows("enrolled_devices")).toEqual(before);
				expect(await f.rows("coordinator_device_revocations")).toEqual(records);
			});
		}
	}
}

function registerNativeKeyCapture(test: ReturnType<typeof revocationHarness>) {
	test("native enable pins the public key read before UPDATE", async ({ fixture: f }) => {
		// Arrange: rotate an unrevoked ID onto the revoked key after its lookup.
		await f.store.createGroup(f.input.groupId);
		await f.store.enrollDevice(f.input.groupId, f.input);
		await f.store.createDeviceRevocation(f.input);
		const target = {
			...f.input,
			deviceId: `${f.input.deviceId}-target`,
			publicKey: UNRELATED_PUBLIC_KEY,
		};
		await f.store.enrollDevice(target.groupId, target);
		await f.store.setDeviceEnabled(target.groupId, target.deviceId, false);
		const hook = vi.fn(async (sql: string) => {
			if (sql.includes("UPDATE enrolled_devices SET enabled"))
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?",
					f.input.publicKey,
					target.deviceId,
				);
		});
		const racing = new D1CoordinatorStore(beforeNativeWrite(hook));
		// Act
		const result = await racing.setDeviceEnabled(target.groupId, target.deviceId, true);
		// Assert
		expect(hook).toHaveBeenCalled();
		expect(result).toBe(false);
		expect(await f.store.getEnrollment(target.groupId, target.deviceId, true)).toMatchObject({
			public_key: f.input.publicKey,
			enabled: 0,
		});
	});
	test("native enroll captures the key before asynchronous derivation", async ({ fixture: f }) => {
		// Arrange
		await f.store.createGroup(f.input.groupId);
		await f.store.enrollDevice(f.input.groupId, f.input);
		await f.store.createDeviceRevocation(f.input);
		const options = {
			...f.input,
			deviceId: `${f.input.deviceId}-target`,
			publicKey: UNRELATED_PUBLIC_KEY,
		};
		// Act
		const pending = f.store.enrollDevice(options.groupId, options);
		options.publicKey = f.input.publicKey;
		await pending;
		// Assert
		expect(await f.store.getEnrollment(options.groupId, options.deviceId)).toMatchObject({
			public_key: UNRELATED_PUBLIC_KEY,
		});
	});
}

function beforeNativeWrite(hook: (sql: string) => Promise<void>): D1DatabaseLike {
	const originals = new WeakMap<D1PreparedStatementLike, D1PreparedStatement>();
	const queries = new WeakMap<D1PreparedStatementLike, string>();
	const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatementLike => {
		const adapter: D1PreparedStatementLike = {
			bind: (...values) => wrap(statement.bind(...values), sql),
			first: <T>() => statement.first<T>(),
			all: <T>() => statement.all<T>(),
			raw: <T>() => statement.raw<T>(),
			run: async () => {
				await hook(sql);
				return statement.run();
			},
		};
		originals.set(adapter, statement);
		queries.set(adapter, sql);
		return adapter;
	};
	return {
		prepare: (sql) => wrap(env.COORDINATOR_DB.prepare(sql), sql),
		batch: async (statements) => {
			for (const statement of statements) await hook(queries.get(statement) ?? "");
			return env.COORDINATOR_DB.batch(
				statements.map((statement) => {
					const original = originals.get(statement);
					if (!original) throw new Error("Unknown native fixture statement");
					return original;
				}),
			);
		},
	};
}
