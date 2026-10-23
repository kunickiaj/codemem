import { describe, expect, it } from "vitest";
import type { RecoveryPreview, RecoveryResult } from "../../tabs/account-owner-recovery-types";
import { recoveryPreview } from "../../tabs/owner-recovery-test-utils";
import { validRecoveryPreview, validRecoveryResult } from "./owner-recovery-validation";

function completeResult(): RecoveryResult {
	return {
		preview: recoveryPreview(),
		groups: [
			{ groupId: "group-one", status: "confirmed", message: "Verified." },
			{ groupId: "group-two", status: "unknown", message: "Check coordinator status." },
		],
	};
}

function historicalPreview(): RecoveryPreview {
	const preview = recoveryPreview();
	// The service maps each manifest's device decisions, then flatMaps records.
	// The backend's 500-record cap is not a 500-row cap on this public projection.
	const records = [
		{ candidate: "candidate-one", group: "historical-one", decisions: 251 },
		{ candidate: "candidate-two", group: "historical-two", decisions: 250 },
	];
	return {
		...preview,
		history: {
			complete: true,
			rows: records.flatMap(({ candidate, group, decisions }) =>
				Array.from({ length: decisions }, (_, index) => ({
					id: `${candidate}:${candidate}-device-${index}`,
					groupId: group,
					deviceId: `${candidate}-device-${index}`,
					fingerprint: `historical-fingerprint-${index}`,
					identityId: "identity-b",
					assignment: "included" as const,
					relation: "other" as const,
					reason: "Retained canonical Team decision; display metadata only.",
				})),
			),
		},
	};
}

describe("owner recovery response completeness", () => {
	it("accepts the valid public two-group preview", () => {
		// Arrange
		const preview = recoveryPreview();
		// Act
		const valid = validRecoveryPreview(preview);
		// Assert
		expect(preview.groups).toEqual(["group-one", "group-two"]);
		expect(valid).toBe(true);
	});

	it.each(["missing second group", "empty groups"])("rejects a result with %s", (fault) => {
		// Arrange: malformed replies must not hide a requested group's unknown status.
		const result = completeResult();
		result.groups = fault === "empty groups" ? [] : result.groups.slice(0, 1);
		// Act
		const valid = validRecoveryResult(result);
		// Assert
		expect(valid).toBe(false);
	});

	it("accepts one confirmed and one explicitly unknown requested group", () => {
		// Arrange
		const result = completeResult();
		// Act
		const valid = validRecoveryResult(result);
		// Assert
		expect(valid).toBe(true);
	});

	it.each(["duplicate", "foreign"])("rejects a %s result group", (fault) => {
		// Arrange
		const result = completeResult();
		result.groups = [
			result.groups[0],
			{ ...result.groups[1], groupId: fault === "duplicate" ? "group-one" : "foreign-group" },
		];
		// Act
		const valid = validRecoveryResult(result);
		// Assert
		expect(valid).toBe(false);
	});

	it.each([500, 501])(
		"accepts %i valid flattened history rows below the consent byte limit",
		(count) => {
			// Arrange: already verified server annotations, not frontend authentication evidence.
			const preview = historicalPreview();
			preview.history = { complete: true, rows: preview.history.rows.slice(0, count) };
			const bytes = new TextEncoder().encode(JSON.stringify(preview)).byteLength;
			// Act
			const valid = validRecoveryPreview(preview);
			// Assert
			expect(preview.history.rows).toHaveLength(count);
			expect(new Set(preview.history.rows.map((row) => row.id)).size).toBe(count);
			expect(new Set(preview.history.rows.map((row) => row.deviceId)).size).toBe(count);
			expect(bytes).toBeLessThan(200_000);
			expect(bytes).toBeLessThan(1024 * 1024);
			expect(valid).toBe(true);
		},
	);

	it("accepts a canonical history display key containing a valid 256-character device ID", () => {
		// Arrange: historyRows projects candidate_ref + ':' + device_id, not a device ID alone.
		const preview = recoveryPreview();
		const deviceId = "d".repeat(256);
		const groupId = "retained-history-group";
		// legacyTeamCandidateId("coordinator-one", "retained-history-group").
		const candidate = "legacy-team-candidate:0765cad18ece3caad88dc0ef989fc83b";
		const rowId = `${candidate}:${deviceId}`;
		preview.history.rows = [{ ...preview.history.rows[0], id: rowId, deviceId, groupId }];
		// Act
		const valid = validRecoveryPreview(preview);
		// Assert
		expect(deviceId).toMatch(/^d{256}$/);
		expect(deviceId).toHaveLength(256);
		expect(candidate).toMatch(/^legacy-team-candidate:[a-f0-9]{32}$/);
		expect(rowId.length).toBeGreaterThan(256);
		expect(new TextEncoder().encode(rowId).byteLength).toBeLessThan(512);
		expect(valid).toBe(true);
	});

	it("rejects a history display key containing a control character", () => {
		// Arrange: display keys remain validated text even though they are composite IDs.
		const preview = recoveryPreview();
		preview.history.rows = [{ ...preview.history.rows[0], id: "candidate:device\ninvalid" }];
		// Act
		const valid = validRecoveryPreview(preview);
		// Assert
		expect(valid).toBe(false);
	});

	it("rejects malformed history metadata even below the row and byte limits", () => {
		// Arrange
		const preview = recoveryPreview();
		const malformed = {
			...preview,
			history: {
				complete: true,
				rows: [{ ...preview.history.rows[0], relation: "unverified" }],
			},
		};
		// Act
		const valid = validRecoveryPreview(malformed);
		// Assert
		expect(valid).toBe(false);
	});
});
