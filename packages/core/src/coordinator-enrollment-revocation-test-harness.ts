import { expect } from "vitest";
import {
	enrollRevocation,
	type revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { ACCEPTED_ALIASES, NODE_ONLY_ALIASES } from "./coordinator-ed25519-key-id-test-fixtures.js";

type EnrollmentTest = ReturnType<typeof revocationHarness>;

// RFC 8032 section 7.1, test 2: unrelated public test vector, not a user credential.
export const UNRELATED_PUBLIC_KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM";

export function registerEnrollmentRevocationContract(test: EnrollmentTest) {
	registerOrdinaryWrites(test);
	registerRevokedWrites(test);
	registerRevokedUpserts(test);
	registerRevokedAliases(test);
	registerEnabledWrites(test);
}

function registerOrdinaryWrites(test: EnrollmentTest) {
	test("without revocation, direct enrollment and upsert retain existing field semantics", async ({
		fixture: f,
	}) => {
		// Arrange
		await f.store.createGroup(f.input.groupId);
		const original = { ...f.input, identityId: "identity-original", displayName: "Original" };
		// Act
		await f.store.enrollDevice(original.groupId, original);
		const created = await f.store.getEnrollment(original.groupId, original.deviceId, true);
		await f.store.setDeviceEnabled(original.groupId, original.deviceId, false);
		await f.store.enrollDevice(original.groupId, {
			...original,
			publicKey: "replacement-fixture-key",
			fingerprint: "b".repeat(64),
			displayName: "Updated",
			identityId: undefined,
		});
		// Assert: actor evidence is not a new ownership binding.
		expect(created).toMatchObject({
			public_key: original.publicKey,
			fingerprint: original.fingerprint,
			identity_id: original.identityId,
			display_name: "Original",
			enabled: 1,
		});
		expect(await f.store.getEnrollment(original.groupId, original.deviceId, true)).toMatchObject({
			public_key: "replacement-fixture-key",
			fingerprint: "b".repeat(64),
			identity_id: original.identityId,
			display_name: "Updated",
			enabled: 1,
			created_at: created?.created_at,
		});
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});
	test("without revocation, disable/enable and remove/reenroll remain available", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		// Act
		const disabled = await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
		const enabled = await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, true);
		const removed = await f.store.removeDevice(f.input.groupId, f.input.deviceId);
		await f.store.enrollDevice(f.input.groupId, f.input);
		// Assert
		expect([disabled, enabled, removed]).toEqual([true, true, true]);
		expect(await f.store.getEnrollment(f.input.groupId, f.input.deviceId)).toMatchObject({
			public_key: f.input.publicKey,
			fingerprint: f.input.fingerprint,
			enabled: 1,
		});
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});
}

function registerRevokedWrites(test: EnrollmentTest) {
	for (const publicKey of [UNRELATED_PUBLIC_KEY, "ssh-rsa AAAA"]) {
		test(`a revoked ID cannot reenroll with ${publicKey} after row removal in another group`, async ({
			fixture: f,
		}) => {
			// Arrange
			await enrollRevocation(f);
			await f.store.createDeviceRevocation(f.input);
			await f.store.removeDevice(f.input.groupId, f.input.deviceId);
			const groupId = `${f.input.groupId}-other`;
			await f.store.createGroup(groupId);
			const before = await f.rows("coordinator_device_revocations");
			// Act
			const pending = f.store.enrollDevice(groupId, {
				...f.input,
				publicKey,
				fingerprint: "c".repeat(64),
			});
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await f.rows("enrolled_devices")).toEqual([]);
			expect(await f.rows("coordinator_device_revocations")).toEqual(before);
		});
	}
}

function registerRevokedUpserts(test: EnrollmentTest) {
	test("revoked existing ID upsert cannot change key, fingerprint, identity, label, enabled or timestamp", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
		await f.store.createDeviceRevocation(f.input);
		const before = await f.rows("enrolled_devices");
		const revocations = await f.rows("coordinator_device_revocations");
		// Act
		const pending = f.store.enrollDevice(f.input.groupId, {
			...f.input,
			publicKey: "replacement-key",
			fingerprint: "b".repeat(64),
			identityId: "new-identity",
			displayName: "New label",
		});
		// Assert
		await expect(pending).rejects.toThrow(/^device_revoked$/);
		expect(await f.rows("enrolled_devices")).toEqual(before);
		expect(await f.rows("coordinator_device_revocations")).toEqual(revocations);
	});
	test("a revoked key alias upsert cannot enable or change retained metadata", async ({
		fixture: f,
	}) => {
		// Arrange: this alias has no revoked ID of its own.
		await enrollRevocation(f);
		const alias = {
			...f.input,
			deviceId: `${f.input.deviceId}-alias`,
			publicKey: `${f.input.publicKey} old-comment`,
		};
		await f.store.enrollDevice(alias.groupId, alias);
		await f.store.setDeviceEnabled(alias.groupId, alias.deviceId, false);
		await f.store.createDeviceRevocation(f.input);
		const before = await f.rows("enrolled_devices");
		// Act
		const pending = f.store.enrollDevice(alias.groupId, {
			...alias,
			publicKey: `${f.input.publicKey} new-comment`,
			fingerprint: "d".repeat(64),
			identityId: "new-identity",
			displayName: "New label",
		});
		// Assert
		await expect(pending).rejects.toThrow(/^device_revoked$/);
		expect(await f.rows("enrolled_devices")).toEqual(before);
	});
	test("a global revocation does not block a different ID and unrelated key", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.createDeviceRevocation(f.input);
		const other = {
			...f.input,
			deviceId: `${f.input.deviceId}-unrelated`,
			publicKey: "unrelated-fixture-key",
		};
		// Act
		await f.store.enrollDevice(other.groupId, other);
		// Assert
		expect(await f.store.getEnrollment(other.groupId, other.deviceId)).toMatchObject({
			public_key: other.publicKey,
			enabled: 1,
		});
	});
}

function registerRevokedAliases(test: EnrollmentTest) {
	for (const alias of [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES]) {
		test(`removed enrollment cannot restore a revoked canonical key through ${alias.name}`, async ({
			fixture: f,
		}) => {
			// Arrange: changed physical fingerprint and group cannot narrow global key authority.
			await enrollRevocation(f);
			await f.store.createDeviceRevocation(f.input);
			await f.store.removeDevice(f.input.groupId, f.input.deviceId);
			const groupId = `${f.input.groupId}-alias`;
			await f.store.createGroup(groupId);
			const before = await f.rows("coordinator_device_revocations");
			// Act
			const pending = f.store.enrollDevice(groupId, {
				...f.input,
				deviceId: `${f.input.deviceId}-new`,
				publicKey: alias.publicKey,
				fingerprint: "e".repeat(64),
			});
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await f.rows("enrolled_devices")).toEqual([]);
			expect(await f.rows("coordinator_device_revocations")).toEqual(before);
		});
	}
}

function registerEnabledWrites(test: EnrollmentTest) {
	for (const subject of ["ID", "key"] as const) {
		test(`enable refuses a revoked ${subject} but disable and removal remain available`, async ({
			fixture: f,
		}) => {
			// Arrange
			await enrollRevocation(f);
			const target = {
				...f.input,
				deviceId: subject === "ID" ? f.input.deviceId : `${f.input.deviceId}-alias`,
			};
			if (subject === "key") await f.store.enrollDevice(target.groupId, target);
			await f.store.createDeviceRevocation(f.input);
			const before = await f.rows("coordinator_device_revocations");
			// Act
			const disabled = await f.store.setDeviceEnabled(target.groupId, target.deviceId, false);
			const enabled = await f.store.setDeviceEnabled(target.groupId, target.deviceId, true);
			const current = await f.store.getEnrollment(target.groupId, target.deviceId, true);
			const removed = await f.store.removeDevice(target.groupId, target.deviceId);
			// Assert
			expect([disabled, enabled, removed]).toEqual([true, false, true]);
			expect(current?.enabled).toBe(0);
			expect(await f.store.getEnrollment(target.groupId, target.deviceId, true)).toBeNull();
			expect(await f.rows("coordinator_device_revocations")).toEqual(before);
		});
	}
	test("enable and disable return false for unknown or empty device IDs", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const before = await f.rows("enrolled_devices");
		// Act
		const results = [];
		for (const deviceId of ["", "unknown-device"]) {
			results.push(await f.store.setDeviceEnabled(f.input.groupId, deviceId, true));
			results.push(await f.store.setDeviceEnabled(f.input.groupId, deviceId, false));
		}
		// Assert
		expect(results).toEqual([false, false, false, false]);
		expect(await f.rows("enrolled_devices")).toEqual(before);
	});
}
