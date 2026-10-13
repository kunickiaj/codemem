import { createHash } from "node:crypto";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { Database } from "./db.js";
import { assignIdentityDeviceInTransaction } from "./identity-device-assignment.js";
import { hasMatchingLocalCreation } from "./memory-creation-provenance.js";
import {
	adoptLocalCapture,
	assertLocalCaptureAdoptionActors,
	hasPendingLocalCapture,
	matchesLocalCaptureRuntime,
} from "./memory-local-capture.js";
import type { OwnerEnrollmentReceipt } from "./owner-enrollment-start.js";

type Row = Record<string, unknown>;
export type OwnerProfileReview = {
	deviceId: string;
	publicKey: string;
	actorId: string;
	captureId: string | null;
	captureAssociation: "pending" | "associated" | "none";
	localMemoryCount: number;
	retainedForeignMemoryCount: number;
	digest: string;
	preservedDigest: string;
	actorsDigest: string;
};
const ACCESS_TABLES = [
	"policy_teams",
	"policy_team_memberships",
	"policy_team_device_decisions",
	"project_recipients",
	"recipient_policy_review_resolutions",
	"recipient_policy_authority_states",
	"recipient_policy_deny_overlays",
	"recipient_policy_reconciliation_steps",
	"recipient_managed_project_projections",
	"share_operations",
	"scope_memberships",
	"project_scope_mappings",
	"device_identity_binding_commits",
	"device_identity_binding_audit",
	"legacy_team_setup_drafts",
	"legacy_team_setup_completions",
	"coordinator_group_preferences",
] as const;
const FACT_TABLES = [
	"actors",
	"sync_device",
	"identity_devices",
	"memory_items",
	"sessions",
	"raw_events",
	"raw_event_sessions",
	"memory_source_bindings",
	"memory_local_capture",
	"memory_local_capture_adoption",
	"replication_ops",
	"replication_scopes",
	"sync_peers",
	...ACCESS_TABLES,
] as const;
const CREATION_FACT_TABLES = [
	"memory_local_creation_snapshots",
	"memory_foreign_revisions",
] as const;

export function ownerProfileConflict(): never {
	throw new Error(
		"Owner enrollment stopped for review. Keep the profile and saved request unchanged; no identity or access repair is automatic.",
	);
}
function rows(db: Database, table: string): Row[] {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
		return ownerProfileConflict();
	return db.prepare(`SELECT * FROM "${table}"`).all() as Row[];
}
function digest(db: Database, options: { preserved?: boolean } = {}): string {
	const hash = createHash("sha256");
	hash.update("owner-existing-profile-review-v1");
	for (const table of FACT_TABLES) {
		if (
			options.preserved &&
			["actors", "identity_devices", "memory_local_capture_adoption"].includes(table)
		)
			continue;
		hash.update(table);
		for (const row of rows(db, table)
			.map((r) => JSON.stringify(r))
			.sort())
			hash.update(row);
	}
	for (const table of CREATION_FACT_TABLES) {
		const present = db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table);
		hash.update(
			JSON.stringify([
				table,
				present
					? rows(db, table)
							.map((r) => JSON.stringify(r))
							.sort()
					: null,
			]),
		);
	}
	return hash.digest("hex");
}
function actorsDigest(db: Database, actorId: string, excludeActorId?: string): string {
	const facts = rows(db, "actors")
		.filter((r) => r.actor_id !== excludeActorId)
		.map((r) => (r.actor_id === actorId ? { ...r, is_local: 1, updated_at: null } : r))
		.map((r) => JSON.stringify(r))
		.sort();
	return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}
function assertNoAccess(db: Database): void {
	for (const table of ACCESS_TABLES) if (rows(db, table).length) ownerProfileConflict();
	if (
		rows(db, "replication_scopes").some(
			(r) => r.kind === "managed_project" || r.authority_type === "coordinator",
		)
	)
		ownerProfileConflict();
	if (rows(db, "sync_peers").some((r) => r.claimed_local_actor === 1)) ownerProfileConflict();
}
function assertCapture(db: Database, deviceId: string, publicKey: string): string[] {
	const births = rows(db, "memory_local_capture");
	const adoptions = rows(db, "memory_local_capture_adoption");
	if (births.length > 1 || adoptions.length > 1) ownerProfileConflict();
	const birth = births[0];
	const adoption = adoptions[0];
	if (birth && (!isAuthControllerId(birth.capture_id) || birth.id !== 1)) ownerProfileConflict();
	if (
		adoption &&
		(!birth ||
			adoption.capture_id !== birth.capture_id ||
			adoption.device_id !== deviceId ||
			adoption.public_key !== publicKey ||
			adoption.fingerprint !== rows(db, "sync_device")[0]?.fingerprint)
	)
		ownerProfileConflict();
	return birth && typeof birth.capture_id === "string" ? [deviceId, birth.capture_id] : [deviceId];
}
/** Read-only policy: populated bootstrap authorship needs immutable local creation proof. */
function profileDevice(input: { db: Database; expectedPublicKey: string }) {
	const { db, expectedPublicKey } = input;
	const devices = rows(db, "sync_device");
	const device = devices[0];
	if (
		devices.length !== 1 ||
		!device ||
		typeof device.device_id !== "string" ||
		typeof device.public_key !== "string" ||
		typeof device.fingerprint !== "string" ||
		!isAuthControllerId(device.device_id)
	)
		return ownerProfileConflict();
	if (
		!matchesLocalCaptureRuntime(
			{
				device_id: device.device_id,
				public_key: device.public_key,
				fingerprint: device.fingerprint,
			},
			device.device_id,
			expectedPublicKey,
		)
	)
		return ownerProfileConflict();
	return { deviceId: device.device_id, publicKey: device.public_key };
}
export function reviewOwnerProfile(input: {
	db: Database;
	actorId?: string;
	expectedPublicKey: string;
}): OwnerProfileReview {
	const { db } = input;
	const device = profileDevice(input);
	const actorId = input.actorId ?? `local:${device.deviceId}`;
	if (!isAuthControllerId(actorId)) return ownerProfileConflict();
	const localActors = rows(db, "actors").filter((r) => r.is_local === 1);
	if (
		localActors.length !== 1 ||
		localActors[0]?.actor_id !== actorId ||
		localActors[0]?.status !== "active" ||
		localActors[0]?.merged_into_actor_id !== null
	)
		return ownerProfileConflict();
	if (rows(db, "identity_devices").length) return ownerProfileConflict();
	assertNoAccess(db);
	if (hasPendingLocalCapture(db)) assertLocalCaptureAdoptionActors(db, device.deviceId, actorId);
	const sources = assertCapture(db, device.deviceId, device.publicKey);
	const memories = rows(db, "memory_items");
	const own = memories.filter((r) => r.actor_id === actorId);
	for (const memory of own) {
		if (
			typeof memory.id !== "number" ||
			typeof memory.import_key !== "string" ||
			!hasMatchingLocalCreation(db, memory.import_key, sources, { memoryId: memory.id })
		)
			ownerProfileConflict();
	}
	if (memories.some((r) => !r.actor_id)) return ownerProfileConflict();
	return {
		deviceId: device.deviceId,
		publicKey: device.publicKey,
		actorId,
		captureId: sources[1] ?? null,
		captureAssociation: captureAssociation(db, sources),
		localMemoryCount: own.length,
		retainedForeignMemoryCount: memories.length - own.length,
		digest: digest(db),
		preservedDigest: digest(db, { preserved: true }),
		actorsDigest: actorsDigest(db, actorId),
	};
}
function captureAssociation(
	db: Database,
	sources: string[],
): OwnerProfileReview["captureAssociation"] {
	if (sources.length === 1) return "none";
	return rows(db, "memory_local_capture_adoption").length ? "associated" : "pending";
}
function source(input: {
	receipt: OwnerEnrollmentReceipt;
	review: OwnerProfileReview;
	coordinatorId: string;
	keyId: string;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"owner-profile-adoption-v1",
				input.coordinatorId,
				input.receipt.bindingId,
				input.receipt.identityId,
				input.review.deviceId,
				input.keyId,
				input.review.digest,
			]),
		)
		.digest("hex");
}
export type OwnerProfileAdoption = {
	db: Database;
	review: OwnerProfileReview;
	receipt: OwnerEnrollmentReceipt;
	coordinatorId: string;
	keyId: string;
	displayName: string;
	assertRuntime: () => void;
};
/** A receipt retry checks committed metadata; it never runs the adoption mutations again. */
export function hasCommittedOwnerProfile(input: OwnerProfileAdoption): boolean {
	const assignment = rows(input.db, "identity_devices");
	if (!assignment.length) return false;
	const row = assignment[0];
	if (
		assignment.length !== 1 ||
		row?.device_id !== input.review.deviceId ||
		row.identity_id !== input.receipt.identityId ||
		row.status !== "active" ||
		row.provenance !== "user_confirmed_identity_setup" ||
		row.revision !== input.receipt.bindingId ||
		row.source_fingerprint !== source(input) ||
		row.idempotency_key !== source(input) ||
		row.assignment_version !== 0 ||
		row.migration_state !== "user_managed" ||
		row.display_name !== input.displayName
	)
		return ownerProfileConflict();
	const local = rows(input.db, "actors").filter((r) => r.is_local === 1);
	if (
		local.length !== 1 ||
		local[0]?.actor_id !== input.receipt.identityId ||
		local[0]?.status !== "active" ||
		local[0]?.merged_into_actor_id !== null
	)
		return ownerProfileConflict();
	assertCommittedHistory(input);
	assertNoAccess(input.db);
	assertCapture(input.db, input.review.deviceId, input.review.publicKey);
	input.assertRuntime();
	return true;
}
function assertCommittedHistory(input: OwnerProfileAdoption): void {
	const exclude =
		input.review.actorId === input.receipt.identityId ? undefined : input.receipt.identityId;
	if (
		digest(input.db, { preserved: true }) !== input.review.preservedDigest ||
		actorsDigest(input.db, input.review.actorId, exclude) !== input.review.actorsDigest
	)
		ownerProfileConflict();
	if (
		input.review.captureId &&
		!rows(input.db, "memory_local_capture_adoption").some(
			(r) => r.capture_id === input.review.captureId,
		)
	)
		ownerProfileConflict();
}
/** Internal metadata writer, not authorization. The client supplies a verified receipt and explicit review. */
export function adoptOwnerProfile(input: OwnerProfileAdoption): void {
	if (!isAuthControllerId(input.receipt.identityId) || !isAuthControllerId(input.receipt.bindingId))
		ownerProfileConflict();
	input.db
		.transaction(() => {
			input.assertRuntime();
			if (hasCommittedOwnerProfile(input)) return;
			const current = reviewOwnerProfile({
				db: input.db,
				actorId: input.review.actorId,
				expectedPublicKey: input.review.publicKey,
			});
			if (current.digest !== input.review.digest) return ownerProfileConflict();
			const bootstrap = [`local:${current.deviceId}`, "local:local"].includes(current.actorId);
			if (!bootstrap && current.actorId !== input.receipt.identityId) return ownerProfileConflict();
			if (
				current.actorId !== input.receipt.identityId &&
				(rows(input.db, "actors").some((r) => r.actor_id === input.receipt.identityId) ||
					rows(input.db, "memory_items").some((r) => r.actor_id === input.receipt.identityId))
			)
				return ownerProfileConflict();
			adoptLocalCapture(input.db, current.deviceId, {
				actorId: current.actorId,
				runtimeDeviceId: current.deviceId,
				expectedPublicKey: current.publicKey,
			});
			const now = new Date().toISOString();
			if (current.actorId !== input.receipt.identityId) {
				// Retire only the current flag, not authorship or an identity alias/merge.
				input.db
					.prepare(
						"UPDATE actors SET is_local = 0, updated_at = ? WHERE actor_id = ? AND is_local = 1",
					)
					.run(now, current.actorId);
				input.db
					.prepare(
						"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, ?, 1, 'active', ?, ?)",
					)
					.run(input.receipt.identityId, input.displayName, now, now);
			}
			assignIdentityDeviceInTransaction(input.db, {
				deviceId: current.deviceId,
				targetIdentityId: input.receipt.identityId,
				expectation: { kind: "absent" },
				insert: {
					displayName: input.displayName,
					provenance: "user_confirmed_identity_setup",
					revision: input.receipt.bindingId,
					migrationState: "user_managed",
					sourceFingerprint: source(input),
					idempotencyKey: source(input),
				},
			});
			input.assertRuntime();
		})
		.immediate();
}
