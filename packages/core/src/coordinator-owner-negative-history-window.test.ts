// Classification uses the captured legacy history, and only the later evidence reads are
// guarded. A change landing between the capture and those reads must refuse the owner.
import { afterEach, expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	retainOwnReviewOwnership,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";
import { readNegativeOwnerConsistency } from "./coordinator-owner-negative-read-set.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
const AT = "2026-10-20T00:00:00.000Z";

/** Runs `change` once, after the history capture's three reads and before the next read batch. */
function afterHistoryCapture(f: Fixture, change: () => void): AuthLinkBackend & { ran(): boolean } {
	let captureReads = 0;
	let ran = false;
	return {
		...f.backend,
		all: async (statement) => {
			captureReads += 1;
			return f.backend.all?.(statement) ?? [];
		},
		readBatch: async (statements) => {
			if (captureReads >= 3 && !ran) {
				ran = true;
				change();
			}
			if (!f.backend.readBatch) throw new Error("read batch unavailable");
			return f.backend.readBatch(statements);
		},
		ran: () => ran,
	};
}

const insert = (f: Fixture, table: string, row: Record<string, unknown>) =>
	f.db
		.prepare(
			`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
				.map(() => "?")
				.join(",")})`,
		)
		.run(...Object.values(row));

const CHANGES: [string, (f: Fixture) => void][] = [
	[
		"an unparseable legacy completion naming the device",
		(f) =>
			insert(f, "coordinator_legacy_team_completions", {
				group_id: "raced-group",
				candidate_ref: "raced-candidate",
				manifest_version: 1,
				manifest_json: `not json ${JSON.stringify(f.signer.deviceId)}`,
				completed_at: AT,
				created_at: AT,
			}),
	],
	[
		"another device enrolled with the same key",
		(f) =>
			insert(f, "enrolled_devices", {
				group_id: "raced-group",
				device_id: "raced-same-key-device",
				public_key: f.signer.publicKey,
				fingerprint: "f".repeat(64),
				enabled: 1,
				created_at: AT,
			}),
	],
	[
		"an enrolled key that cannot be ruled out",
		(f) =>
			insert(f, "enrolled_devices", {
				group_id: "raced-group",
				device_id: "raced-unparsed-device",
				public_key: "raced unparsed key",
				fingerprint: "f".repeat(64),
				enabled: 1,
				created_at: AT,
			}),
	],
];

it.each(CHANGES)(
	"refuses the owner when %s lands after the history capture",
	async (_n, change) => {
		// Arrange
		const f = await selfBindFixture("D1", "peer");
		close.push(f.close);
		await retainOwnReviewOwnership(f);
		const backend = afterHistoryCapture(f, () => change(f));
		// Act
		const negative = await readNegativeOwnerConsistency(backend, {
			coordinatorId: f.config.coordinatorId,
			deviceId: f.signer.deviceId,
			publicKey: f.signer.publicKey,
			fingerprint: f.signer.fingerprint,
			ownerIdentityId: f.identityId,
			enrollment: { groupId: f.signer.groupId },
		});
		// Assert
		expect(backend.ran()).toBe(true);
		expect(negative).toBeNull();
	},
);
