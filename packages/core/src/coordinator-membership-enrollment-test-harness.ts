import { expect } from "vitest";
import {
	enroll,
	type RemovalFixture,
	type RemovalTest,
	target,
} from "./coordinator-device-removal-test-harness.js";

/** A17: enrollment and the scope's group must still authorize the writing statement. */
export function registerMembershipEnrollmentContract(test: RemovalTest) {
	registerGrantRaces(test);
	registerScopeRaces(test);
	registerGrantPreconditions(test);
	registerGrantReplay(test);
	registerConflictAuthority(test);
}

async function fixture(
	f: RemovalFixture,
	options: { previous?: "absent" | "revoked"; groupLess?: boolean } = {},
) {
	const device = await target(f);
	await enroll(f, device);
	const scopeId = `${f.prefix}-scope`;
	await f.store.createScope({
		scopeId,
		label: "Membership",
		groupId: options.groupLess ? null : device.groupId,
	});
	if (options.previous === "revoked") {
		await f.store.grantScopeMembership({
			effectId: `${f.prefix}-initial`,
			scopeId,
			deviceId: device.deviceId,
		});
		await f.store.revokeScopeMembership({
			effectId: `${f.prefix}-revoke`,
			scopeId,
			deviceId: device.deviceId,
		});
	}
	const request = {
		effectId: `${f.prefix}-new-grant`,
		scopeId,
		deviceId: device.deviceId,
		membershipEpoch: 10,
	};
	const membership = () =>
		f.rows(
			"SELECT * FROM coordinator_scope_memberships WHERE scope_id = ? AND device_id = ?",
			scopeId,
			device.deviceId,
		);
	const effects = () =>
		Promise.all([
			f.rows(
				"SELECT * FROM coordinator_scope_membership_effect_receipts WHERE effect_id = ?",
				request.effectId,
			),
			f.rows(
				"SELECT * FROM coordinator_scope_membership_audit_log WHERE effect_id = ?",
				request.effectId,
			),
		]);
	return { device, scopeId, request, membership, effects };
}

function registerGrantRaces(test: RemovalTest) {
	for (const previous of ["absent", "revoked"] as const) {
		for (const change of ["removal", "disable"] as const) {
			test(`A17 ${change} after the read prevents the ${previous} membership grant and writes no receipt or audit`, async ({
				fixture: f,
			}) => {
				const c = await fixture(f, { previous });
				const before = await c.membership();
				let changed: Promise<unknown> | undefined;
				const store = f.interleave(["INSERT INTO coordinator_scope_memberships"], () => {
					changed =
						change === "removal"
							? f.store.removeDevice(c.device.groupId, c.device.deviceId)
							: f.store.setDeviceEnabled(c.device.groupId, c.device.deviceId, false);
					return changed;
				});
				const result = await store.grantScopeMembership(c.request).then(
					() => "granted",
					(error: Error) => error.message,
				);
				expect(await changed).toBe(true);
				expect(result).toBe("scope membership grant was not applied.");
				expect(await c.membership()).toEqual(before);
				expect(await c.effects()).toEqual([[], []]);
			});
		}
	}
}

function registerScopeRaces(test: RemovalTest) {
	for (const change of ["new group", "no group", "scope missing"] as const) {
		test(`a scope changed to ${change} at the grant statement cannot use its old group or caller assertion`, async ({
			fixture: f,
		}) => {
			const c = await fixture(f, { previous: "revoked" });
			// Even an enrollment in the new group does not authorize silently
			// changing which scope/group proof this grant writes.
			if (change === "new group") await enroll(f, { ...c.device, groupId: `${f.prefix}-other` });
			const before = await c.membership();
			const store = f.interleave(["INSERT INTO coordinator_scope_memberships"], () => {
				if (change === "scope missing")
					return f.exec("DELETE FROM coordinator_scopes WHERE scope_id = ?", c.scopeId);
				const group = change === "no group" ? null : `${f.prefix}-other`;
				return f.exec(
					"UPDATE coordinator_scopes SET group_id = ? WHERE scope_id = ?",
					group,
					c.scopeId,
				);
			});
			await expect(
				store.grantScopeMembership({ ...c.request, groupId: c.device.groupId }),
			).rejects.toThrow("scope membership grant was not applied.");
			expect(await c.membership()).toEqual(before);
			expect(await c.effects()).toEqual([[], []]);
		});
	}
	test("a formerly group-less scope cannot grant after it acquires a group at the write boundary", async ({
		fixture: f,
	}) => {
		const c = await fixture(f, { groupLess: true });
		const store = f.interleave(["INSERT INTO coordinator_scope_memberships"], () =>
			f.exec(
				"UPDATE coordinator_scopes SET group_id = ? WHERE scope_id = ?",
				`${f.prefix}-other`,
				c.scopeId,
			),
		);
		await expect(store.grantScopeMembership(c.request)).rejects.toThrow(
			"scope membership grant was not applied.",
		);
		expect(await c.membership()).toEqual([]);
		expect(await c.effects()).toEqual([[], []]);
	});
}

function registerGrantPreconditions(test: RemovalTest) {
	for (const state of ["disabled", "not enrolled"] as const) {
		test(`a grouped scope refuses a device that is ${state} with device_not_enrolled`, async ({
			fixture: f,
		}) => {
			const c = await fixture(f);
			if (state === "disabled")
				await f.store.setDeviceEnabled(c.device.groupId, c.device.deviceId, false);
			else await f.store.removeDevice(c.device.groupId, c.device.deviceId);
			await expect(f.store.grantScopeMembership(c.request)).rejects.toMatchObject({
				code: "device_not_enrolled",
			});
			expect(await c.membership()).toEqual([]);
			expect(await c.effects()).toEqual([[], []]);
		});
	}
	test("a stale membership group copy cannot replace the scope's live group", async ({
		fixture: f,
	}) => {
		const c = await fixture(f, { previous: "revoked" });
		await f.exec(
			"UPDATE coordinator_scope_memberships SET group_id = ? WHERE scope_id = ?",
			`${f.prefix}-stale-copy`,
			c.scopeId,
		);
		const result = await f.store.grantScopeMembership(c.request);
		expect(result).toMatchObject({
			group_id: c.device.groupId,
			status: "active",
			membership_epoch: 10,
		});
	});
}

function registerConflictAuthority(test: RemovalTest) {
	test("the conflict-update branch repeats live group authorization after a BEFORE INSERT trigger changes the scope", async ({
		fixture: f,
	}) => {
		const c = await fixture(f, { previous: "revoked" });
		const before = await c.membership();
		await f.exec(`CREATE TRIGGER membership_scope_drift BEFORE INSERT ON coordinator_scope_memberships
			BEGIN UPDATE coordinator_scopes SET group_id = 'changed-group' WHERE scope_id = NEW.scope_id; END`);
		try {
			await expect(f.store.grantScopeMembership(c.request)).rejects.toThrow(
				"scope membership grant was not applied.",
			);
			expect(await c.membership()).toEqual(before);
			expect(await c.effects()).toEqual([[], []]);
		} finally {
			await f.exec("DROP TRIGGER membership_scope_drift");
		}
	});
}

function registerGrantReplay(test: RemovalTest) {
	test("ordinary grants and historical effect replay keep their receipt and audit semantics", async ({
		fixture: f,
	}) => {
		const c = await fixture(f);
		const granted = await f.store.grantScopeMembership(c.request);
		const effects = await c.effects();
		await f.store.removeDevice(c.device.groupId, c.device.deviceId);
		expect(await f.store.grantScopeMembership(c.request)).toEqual(granted);
		expect(await c.effects()).toEqual(effects);
		expect((await c.membership())[0]).toMatchObject({ status: "revoked", membership_epoch: 11 });
	});
	test("a standalone group-less scope still grants without any enrollment", async ({
		fixture: f,
	}) => {
		const scopeId = `${f.prefix}-standalone`;
		await f.store.createScope({ scopeId, label: "Standalone" });
		const request = {
			effectId: `${f.prefix}-standalone-grant`,
			scopeId,
			deviceId: `${f.prefix}-absent`,
		};
		const granted = await f.store.grantScopeMembership(request);
		expect(granted).toMatchObject({
			group_id: null,
			device_id: request.deviceId,
			status: "active",
		});
		expect(await f.store.grantScopeMembership(request)).toEqual(granted);
	});
}
