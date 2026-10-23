import { expect } from "vitest";
import {
	binding,
	cfg,
	claim,
	collectInput,
	controller,
	evidenceBackend,
	evidenceTest,
	history,
	insert,
	invitation,
	sourceRef,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { ACCEPTED_ALIASES } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { captureLegacyOwnerResolutionRecord } from "./coordinator-legacy-owner-resolution-metadata.js";

// Independently runnable while the collector module is absent: verify fixtures
// against the real installed schemas and canonical history/metadata parsers.
for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	test.for(ACCEPTED_ALIASES)(
		`${backend}: real metadata parser accepts fixture alias $name`,
		async (alias, { f }) => {
			// Arrange
			const reference = sourceRef(controller(f, { public_key: alias.publicKey }));
			// Act
			const parsed = await captureLegacyOwnerResolutionRecord(reference);
			// Assert
			expect(parsed).toEqual(reference);
		},
	);
	test(`${backend}: synthetic source rows use real columns and parse canonical metadata/history`, async ({
		f,
	}) => {
		// Arrange
		const reference = sourceRef(controller(f));
		binding(f);
		claim(f);
		invitation(f);
		history(f);
		insert(f, "coordinator_legacy_owner_resolutions", reference);
		// Act
		const metadata = await captureLegacyOwnerResolutionRecord(reference);
		const input = await collectInput(f);
		const counts = await evidenceBackend(f, backend).all<{ n: number }>({
			sql: "SELECT count(*) AS n FROM coordinator_invites",
			values: [],
		});
		// Assert
		expect(metadata).toEqual(reference);
		expect(input.verifiedHistory).toMatchObject({
			coordinatorId: cfg.coordinatorId,
			records: [expect.objectContaining({ group_id: "historical-group" })],
		});
		expect(counts).toEqual([{ n: 1 }]);
	});

	test(`${backend}: malformed synthetic history is rejected by the actual history parser`, async ({
		f,
	}) => {
		// Arrange
		history(f);
		// Retain a target reference so malformed relevant evidence is discovered.
		f.db
			.prepare("UPDATE coordinator_legacy_team_completions SET manifest_json=?")
			.run('{"device_decisions": ["device-a"]');
		// Act
		const attempt = collectInput(f);
		// Assert
		await expect(attempt).rejects.toThrow(SyntaxError);
	});
}
