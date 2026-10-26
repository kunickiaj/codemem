import { captureAuthAccountProfile } from "./coordinator-auth-account-profile.js";
import { projectAccountProfileView } from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { captureControllerHistory } from "./coordinator-auth-controller-history.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import {
	capture,
	captureAuthLinkConfig,
	captureAuthLinkSigner,
	isHash,
} from "./coordinator-auth-link-input.js";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	BYTE_LIMIT,
	RESOLUTION_COLUMNS,
	ROW_LIMIT,
} from "./coordinator-device-ownership-evidence-queries.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	captureLegacyOwnerResolutionRecord,
	type LegacyOwnerResolutionRecord,
} from "./coordinator-legacy-owner-resolution-metadata.js";
import { requireReviewSchema } from "./coordinator-owner-resolution-review-read.js";
import {
	type ResolvedOwnerProfileRow,
	resolvedOwnerProfileQuery,
} from "./coordinator-resolved-account-owner-status-query.js";

type ResolvedOwnerBackend = AuthLinkBackend & {
	all<T>(statement: AuthLinkStatement): Promise<T[]>;
};
interface SafeProfile {
	displayName?: string;
	email?: string;
	pictureUrl?: string;
}
interface StatusSubject {
	version: 1;
	coordinatorId: string;
	groupId: string;
	deviceId: string;
	fingerprint: string;
}
export type ResolvedAccountOwnerStatus = StatusSubject &
	(
		| {
				state: "owner_unconfirmed";
				ownerIdentity: null;
				profileState: "unavailable";
				profile: null;
		  }
		| {
				state: "owner_confirmed";
				ownerIdentity: string;
				profileState: "linked";
				profile: SafeProfile;
		  }
		| {
				state: "owner_confirmed";
				ownerIdentity: string;
				profileState: "account_unlinked" | "unavailable";
				profile: null;
		  }
	);

export class ResolvedAccountOwnerStatusUnavailableError extends Error {
	constructor() {
		super("resolved_account_owner_status_unavailable");
	}
}

export interface ResolvedAccountOwnerReceiptReference {
	attestationId: string;
	reviewReceiptId: string;
	reviewEvidenceDigest: string;
	resolutionId: string;
	resolutionEvidenceDigest: string;
}
const RECEIPT_FIELDS = [
	"attestationId",
	"reviewReceiptId",
	"reviewEvidenceDigest",
	"resolutionId",
	"resolutionEvidenceDigest",
] as const;

/** Capture data descriptors only; never evaluate submitted accessors. */
export function captureResolvedAccountOwnerReceiptReference(
	value: unknown,
): ResolvedAccountOwnerReceiptReference | null {
	try {
		const receipt = capture(value, RECEIPT_FIELDS);
		if (
			!receipt ||
			Reflect.ownKeys(value as object).length !== RECEIPT_FIELDS.length ||
			![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
			!isAuthControllerId(receipt.attestationId) ||
			!isAuthControllerId(receipt.reviewReceiptId) ||
			!isAuthControllerId(receipt.resolutionId) ||
			!isHash(receipt.reviewEvidenceDigest) ||
			!isHash(receipt.resolutionEvidenceDigest)
		)
			return null;
		return receipt as unknown as ResolvedAccountOwnerReceiptReference;
	} catch {
		return null;
	}
}

function captureExpectedReceipt(options: object): ResolvedAccountOwnerReceiptReference | undefined {
	try {
		if (!("expectedReceipt" in options)) return undefined;
		const outer = capture(options, ["expectedReceipt"]);
		const receipt = captureResolvedAccountOwnerReceiptReference(outer?.expectedReceipt);
		if (receipt) return receipt;
	} catch {
		// Malformed descriptors must not turn a constrained read into an ordinary read.
	}
	throw new ResolvedAccountOwnerStatusUnavailableError();
}

function projectProfile(row: ResolvedOwnerProfileRow, issuer: string): SafeProfile | null {
	const captured = captureAuthAccountProfile({
		displayName: row.display_name,
		email: row.email,
		emailVerified: row.email_verified === 1,
		pictureUrl: row.picture_url,
	});
	if (!captured) return null;
	const profile: SafeProfile = {};
	if (captured.displayName !== undefined) profile.displayName = captured.displayName;
	if (captured.emailVerified === true && captured.email !== undefined)
		profile.email = captured.email;
	const { pictureUrl } = projectAccountProfileView(captured, issuer);
	if (pictureUrl !== undefined) profile.pictureUrl = pictureUrl;
	return profile;
}

function projectStatus(
	base: Extract<ResolvedAccountOwnerStatus, { state: "owner_unconfirmed" }>,
	row: ResolvedOwnerProfileRow | null,
	owner: string,
	issuer: string,
): ResolvedAccountOwnerStatus {
	if (!row) return base;
	const confirmed = { ...base, state: "owner_confirmed" as const, ownerIdentity: owner };
	if (row.link_count > 1) return { ...confirmed, profileState: "unavailable", profile: null };
	if (row.link_count === 0)
		return { ...confirmed, profileState: "account_unlinked", profile: null };
	if (!row.valid_link) return { ...confirmed, profileState: "unavailable", profile: null };
	if (row.not_revoked === 0)
		return { ...confirmed, profileState: "account_unlinked", profile: null };
	if (!projectProfile(row, issuer))
		return { ...confirmed, profileState: "unavailable", profile: null };
	// This read always comes from a device that runs as another Identity, so it
	// holds no proof of its own for the owner. It learns that the owner's account
	// is linked, but never the name, email, or picture (ADR 0005 Section 8).
	// An empty profile keeps older Viewers' response checks working.
	return { ...confirmed, profileState: "linked", profile: {} };
}

async function readCandidates(
	backend: ResolvedOwnerBackend,
	coordinator: string,
	device: string,
	key: string,
	owner: string,
	expectedReceipt?: ResolvedAccountOwnerReceiptReference,
) {
	const receiptPredicate = expectedReceipt
		? ` AND source_attestation_id=? AND source_review_receipt_id=? AND source_evidence_digest=?
 AND resolution_id=? AND resolution_evidence_digest=?`
		: "";
	const rows = await backend.all<unknown>({
		sql: `SELECT ${RESOLUTION_COLUMNS.join(",")} FROM coordinator_legacy_owner_resolutions
 WHERE coordinator_id=? AND device_id=? AND key_id=? AND owner_identity_id=?${receiptPredicate}
 ORDER BY created_at,resolution_id LIMIT ${ROW_LIMIT + 1}`,
		values: [
			coordinator,
			device,
			key,
			owner,
			...(expectedReceipt ? RECEIPT_FIELDS.map((field) => expectedReceipt[field]) : []),
		],
	});
	if (
		rows.length > ROW_LIMIT ||
		new TextEncoder().encode(JSON.stringify(rows)).byteLength > BYTE_LIMIT
	)
		throw new ResolvedAccountOwnerStatusUnavailableError();
	const candidates: LegacyOwnerResolutionRecord[] = [];
	for (const value of rows) {
		const candidate = await captureLegacyOwnerResolutionRecord(value);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

/** Read-only display proof. The selected owner is a query, never an authority input. */
export class ResolvedAccountOwnerStatusOperations {
	constructor(private readonly backend: ResolvedOwnerBackend) {}

	async readResolvedAccountOwnerStatus(
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
		options: { ownerIdentityId: string; expectedReceipt?: unknown },
	): Promise<ResolvedAccountOwnerStatus> {
		const s = captureAuthLinkSigner(signer);
		const c = captureAuthLinkConfig(config);
		const selected = capture(options, ["ownerIdentityId"]);
		if (!s || !c?.enabled || !selected || !isAuthControllerId(selected.ownerIdentityId))
			throw new ResolvedAccountOwnerStatusUnavailableError();
		const expectedReceipt = captureExpectedReceipt(options);
		const owner = selected.ownerIdentityId;
		const base: Extract<ResolvedAccountOwnerStatus, { state: "owner_unconfirmed" }> = {
			version: 1,
			coordinatorId: c.coordinatorId,
			groupId: s.groupId,
			deviceId: s.deviceId,
			fingerprint: s.fingerprint,
			state: "owner_unconfirmed",
			ownerIdentity: null,
			profileState: "unavailable",
			profile: null,
		};
		try {
			await requireReviewSchema(this.backend);
			return await this.readCaptured(s, c, owner, base, expectedReceipt);
		} catch {
			throw new ResolvedAccountOwnerStatusUnavailableError();
		}
	}

	private async readCaptured(
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
		owner: string,
		base: Extract<ResolvedAccountOwnerStatus, { state: "owner_unconfirmed" }>,
		expectedReceipt?: ResolvedAccountOwnerReceiptReference,
	): Promise<ResolvedAccountOwnerStatus> {
		const keyId = await ed25519KeyIdForRevocation(signer.publicKey);
		if (!keyId) return base;
		const candidates = await readCandidates(
			this.backend,
			config.coordinatorId,
			signer.deviceId,
			keyId,
			owner,
			expectedReceipt,
		);
		if (!candidates.length) return base;
		const history = await captureControllerHistory(
			{ coordinatorId: config.coordinatorId, ...signer },
			<T>(sql: string, values: string[]) => this.backend.all<T>({ sql, values }),
		);
		const evidence = new CoordinatorDeviceOwnershipEvidence(this.backend, config);
		const collected = await evidence.collect({
			canonicalOwnerId: owner,
			actualSigner: signer,
			verifiedHistory: history,
		});
		if (
			collected.kind !== "collected" ||
			!["compatible", "weak_label_review_required"].includes(collected.decision)
		)
			return base;
		for (const resolution of candidates) {
			const source = await evidence.verifyControllerSource({
				sourceRef: resolution,
				expectedOwnerId: owner,
				actualSigner: signer,
			});
			if (source.kind !== "verified_controller_source") continue;
			const row = await this.backend.first<ResolvedOwnerProfileRow>(
				resolvedOwnerProfileQuery({
					signer,
					config,
					resolution,
					keyId,
					recheck: evidence.prepareAtomicRecheck(collected.recheckSnapshot),
				}),
			);
			return projectStatus(base, row, owner, config.issuer);
		}
		return base;
	}
}
