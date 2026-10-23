import { afterEach, beforeEach, expect, vi } from "vitest";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	cfg,
	collectInput,
	controller,
	evidenceBackend,
	evidenceTest,
	history,
	invitation,
	signer,
	sourceRef,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	test.for(["missing", "disabled", "archived"] as const)(
		`${backend}: unavailable for %s current enrollment/group`,
		async (state, { f }) => {
			// Arrange
			const input = await collectInput(f);
			if (state === "missing") f.db.prepare("DELETE FROM enrolled_devices").run();
			if (state === "disabled") f.db.prepare("UPDATE enrolled_devices SET enabled=0").run();
			if (state === "archived")
				f.db
					.prepare("UPDATE groups SET archived_at=? WHERE group_id=?")
					.run("2026-10-02T00:00:00.000Z", signer.groupId);
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.collect(input);
			// Assert
			expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
		},
	);
	test.for([
		"missing-schema",
		"unsupported-schema",
		"malformed-invite",
		"revoked-before-consumption",
		"unknown-invite",
		"oversized-key",
	])(`${backend}: fails unavailable for %s`, async (failure, { f }) => {
		// Arrange: corrupt only synthetic fixtures; no normal producer mutation is proposed.
		const input = await collectInput(f);
		if (failure === "missing-schema") f.db.exec("DROP TABLE coordinator_legacy_owner_resolutions");
		if (failure === "unsupported-schema")
			f.db.exec(
				"CREATE TRIGGER unexpected_source_trigger AFTER INSERT ON coordinator_legacy_owner_resolutions BEGIN SELECT 1; END",
			);
		if (failure === "malformed-invite") invitation(f, { consumed_at: "not-a-date" });
		if (failure === "revoked-before-consumption")
			invitation(f, { revoked_at: "2026-10-01T12:00:00.000Z" });
		if (failure === "unknown-invite") invitation(f, { invite_kind: "unclassified" });
		if (failure === "oversized-key") controller(f, { public_key: "x".repeat(4097) });
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(input);
		// Assert
		expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
	});

	test(`${backend}: rejects accessors without executing submitted getters`, async ({ f }) => {
		// Arrange
		const input = await collectInput(f);
		const getter = vi.fn(() => {
			throw new Error("must not execute");
		});
		Object.defineProperty(input.actualSigner, "publicKey", { get: getter, enumerable: true });
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(input);
		// Assert
		expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
		expect(getter).not.toHaveBeenCalled();
	});

	test(`${backend}: database read errors do not escape or expose raw details`, async ({ f }) => {
		// Arrange
		const input = await collectInput(f);
		const broken = {
			...evidenceBackend(f, backend),
			all: vi.fn().mockRejectedValue(new Error("synthetic-sensitive-db-error")),
		};
		const reader = new CoordinatorDeviceOwnershipEvidence(broken, cfg);
		// Act
		const result = await reader.collect(input);
		// Assert
		expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
		expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-db-error");
	});

	test(`${backend}: verified history must be rechecked against stored records`, async ({ f }) => {
		// Arrange
		history(f);
		const input = await collectInput(f);
		f.db.prepare("DELETE FROM coordinator_legacy_team_completions").run();
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(input);
		// Assert
		expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
	});

	test(`${backend}: source read errors fail unavailable rather than verifying metadata`, async ({
		f,
	}) => {
		// Arrange
		const reference = sourceRef(controller(f));
		const broken = {
			...evidenceBackend(f, backend),
			first: vi.fn().mockRejectedValue(new Error("synthetic-sensitive-db-error")),
		};
		const reader = new CoordinatorDeviceOwnershipEvidence(broken, cfg);
		// Act
		const result = await reader.verifyControllerSource({
			sourceRef: reference,
			expectedOwnerId: "A",
			actualSigner: (await collectInput(f)).actualSigner,
		});
		// Assert
		expect(result).toMatchObject({ kind: "unavailable" });
	});
}
