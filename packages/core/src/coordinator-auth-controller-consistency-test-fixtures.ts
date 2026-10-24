import { vi } from "vitest";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import { type Fixture, review } from "./coordinator-auth-store-test-fixtures.js";
import {
	controller,
	databaseSnapshot,
	insert,
	type Row,
	signer,
	sourceRef,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";

export const resolutionTable = "coordinator_legacy_owner_resolutions";

/** Minimal retained provenance: no legacy completion can mask the ordinary path. */
export function retainedResolution(f: Fixture, sourcePatch: Row = {}, resolutionPatch: Row = {}) {
	const source = controller(f, { enrollment_identity_id: null, ...sourcePatch });
	const resolution = { ...sourceRef(source), ...resolutionPatch };
	insert(f, resolutionTable, resolution);
	return { source, resolution };
}

export async function ordinaryReview(
	f: Fixture,
	patch: Partial<CoordinatorAuthControllerReviewInput> = {},
) {
	const input = review({
		...signer,
		identityId: "A",
		attestationId: "ordinary-controller",
		reviewReceiptId: "ordinary-receipt",
		...patch,
	});
	const enrollment = await f.store.getEnrollment(input.groupId, input.deviceId, true);
	if (!enrollment) throw new Error("ordinary fixture enrollment missing");
	input.verifiedSnapshot = {
		enrollmentIdentityId: enrollment.identity_id,
		invites: [],
		legacyHistory: await f.store.captureAuthControllerLegacyHistory(input),
	};
	return input;
}

/** Intercept the real backend's last prepare, after the producer built its SQL. */
export function beforeControllerWrite(
	f: Fixture,
	change: () => void,
): {
	restore(): void;
	afterChange(): ReturnType<typeof databaseSnapshot> | undefined;
} {
	const prepare = f.db.prepare.bind(f.db);
	let afterChange: ReturnType<typeof databaseSnapshot> | undefined;
	let fired = false;
	const hook = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
		if (
			!fired &&
			/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+coordinator_auth_controller_attestations\b/iu.test(sql)
		) {
			fired = true;
			change();
			afterChange = databaseSnapshot(f);
		}
		return prepare(sql);
	});
	return { restore: () => hook.mockRestore(), afterChange: () => afterChange };
}
