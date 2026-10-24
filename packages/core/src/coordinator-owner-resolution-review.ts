import type { CoordinatorAuthControllerAttestation } from "./coordinator-auth-controller.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { ControllerHistorySnapshot } from "./coordinator-auth-controller-history.js";
import {
	type ControllerHistoryEvidence,
	captureControllerHistory,
	controllerHistoryDigestEvidence,
	parseControllerHistoryRecord,
} from "./coordinator-auth-controller-history.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { capture, captureAuthLinkConfig, isHash } from "./coordinator-auth-link-input.js";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	commitReviewedOwnerResolution,
	type InternalOwnerResolutionReview,
} from "./coordinator-legacy-owner-resolution-commit.js";
import type {
	LegacyOwnerResolutionRecord,
	ReviewedWeakLabel,
} from "./coordinator-legacy-owner-resolution-metadata.js";
import {
	type ResolutionTarget,
	ReviewUnavailable,
	readResolutionInvites,
	readResolutionRequester,
	readResolutionSource,
	readResolutionTarget,
	requireReviewSchema,
} from "./coordinator-owner-resolution-review-read.js";

export interface OwnerResolutionReviewBackend extends AuthLinkBackend {
	all<T>(statement: AuthLinkStatement): Promise<T[]>;
}
export interface OwnerResolutionReviewSelection {
	groupId: string;
	deviceId: string;
	identityId: string;
	fingerprint: string;
}
export interface OwnerResolutionReviewConfirmation extends OwnerResolutionReviewSelection {
	confirmOwnerResolutionDigest?: string;
}
type Disposition = "created" | "reused";
export interface OwnerResolutionReviewResult {
	purpose: "existing_account_owner";
	resolution_scope: "historical_included_owner_labels_only";
	state: "ready" | "needs_review" | "restored";
	reasons: string[];
	coordinator_id: string;
	group_id: string;
	device_id: string;
	identity_id: string;
	fingerprint: string;
	owner_resolution_digest?: string;
	account_owner_target?: ResolutionTarget & { identity_id: string };
	legacy_history: ControllerHistoryEvidence[];
	reviewed_weak_labels: ReviewedWeakLabel[];
	attestation_id?: string;
	recovery_receipt?: {
		disposition: Disposition;
		review_receipt_id: string;
		evidence_digest: string;
		created_at: string;
	};
	owner_resolution?: {
		disposition: Disposition;
		resolution_id: string;
		evidence_digest: string;
		created_at: string;
	};
}

/** Callers must authenticate their trusted operator before using this capability. */
export interface CoordinatorOwnerResolutionReviewStore {
	previewOwnerResolutionReview(
		selection: OwnerResolutionReviewSelection,
		config: CoordinatorAuthLinkConfig,
	): Promise<OwnerResolutionReviewResult>;
	confirmOwnerResolutionReview(
		selection: OwnerResolutionReviewConfirmation,
		config: CoordinatorAuthLinkConfig,
	): Promise<OwnerResolutionReviewResult>;
}

export class OwnerResolutionReviewError extends Error {
	constructor(readonly code: "review_stale" | "owner_resolution_outcome_unknown") {
		super(
			code === "review_stale"
				? "Review changed or confirmation is missing; preview again before confirming"
				: "Owner resolution outcome is unknown; preview its status before retrying",
		);
		this.name = "OwnerResolutionReviewError";
	}
}

const PURPOSE = "existing_account_owner";
const SCOPE = "historical_included_owner_labels_only";
const SELECTION_FIELDS = ["groupId", "deviceId", "identityId", "fingerprint"] as const;
function captureSelection(value: unknown): OwnerResolutionReviewSelection | null {
	const row = capture(value, SELECTION_FIELDS);
	if (
		!row ||
		!isAuthControllerId(row.groupId) ||
		!isAuthControllerId(row.deviceId) ||
		!isAuthControllerId(row.identityId) ||
		!isHash(row.fingerprint)
	)
		return null;
	return {
		groupId: row.groupId,
		deviceId: row.deviceId,
		identityId: row.identityId,
		fingerprint: row.fingerprint,
	};
}

async function sha(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function baseResult(
	selection: OwnerResolutionReviewSelection | null,
	config: CoordinatorAuthLinkConfig | null,
): OwnerResolutionReviewResult {
	return {
		purpose: PURPOSE,
		resolution_scope: SCOPE,
		state: "needs_review",
		reasons: [],
		coordinator_id: config?.coordinatorId ?? "",
		group_id: selection?.groupId ?? "",
		device_id: selection?.deviceId ?? "",
		identity_id: selection?.identityId ?? "",
		fingerprint: selection?.fingerprint ?? "",
		legacy_history: [],
		reviewed_weak_labels: [],
	};
}

function receiptResult(
	controller: CoordinatorAuthControllerAttestation,
	resolution: LegacyOwnerResolutionRecord | null,
	controllerDisposition: Disposition,
	resolutionDisposition: Disposition,
) {
	return {
		attestation_id: controller.attestation_id,
		recovery_receipt: {
			disposition: controllerDisposition,
			review_receipt_id: controller.review_receipt_id,
			evidence_digest: controller.evidence_digest,
			created_at: controller.created_at,
		},
		...(resolution
			? {
					owner_resolution: {
						disposition: resolutionDisposition,
						resolution_id: resolution.resolution_id,
						evidence_digest: resolution.resolution_evidence_digest,
						created_at: resolution.created_at,
					},
				}
			: {}),
	};
}

interface PreparedReview {
	result: OwnerResolutionReviewResult;
	review?: InternalOwnerResolutionReview;
	evidence?: CoordinatorDeviceOwnershipEvidence;
}

interface CapturedSubject {
	signer: CoordinatorAuthLinkSigner;
	enrollmentIdentityId: string | null;
	history: ControllerHistorySnapshot;
	evidence: CoordinatorDeviceOwnershipEvidence;
	ownershipEvidenceDigest: string;
	weakLabels: ReviewedWeakLabel[];
	recheckSnapshot: Parameters<CoordinatorDeviceOwnershipEvidence["prepareAtomicRecheck"]>[0];
}
type ResolutionSource = Awaited<ReturnType<typeof readResolutionSource>>;

async function buildInternalReview(options: {
	selection: OwnerResolutionReviewSelection;
	config: CoordinatorAuthLinkConfig;
	subject: CapturedSubject;
	source: ResolutionSource;
	target: ResolutionTarget;
	invites: Awaited<ReturnType<typeof readResolutionInvites>>;
	digest: string;
}): Promise<InternalOwnerResolutionReview> {
	const { selection, config, subject, source, target, invites, digest } = options;
	const attestationId = `controller-v1:${await sha([config.coordinatorId, selection.groupId, selection.deviceId, selection.fingerprint])}`;
	return {
		controllerReview: {
			attestationId,
			coordinatorId: config.coordinatorId,
			identityId: selection.identityId,
			...subject.signer,
			reviewReceiptId: `review-v1:${await sha([attestationId, selection.identityId, digest])}`,
			evidenceDigest: digest,
			verifiedSnapshot: {
				enrollmentIdentityId: subject.enrollmentIdentityId,
				invites,
				legacyHistory: subject.history,
				accountOwnerTarget: {
					purpose: PURPOSE,
					coordinatorId: config.coordinatorId,
					targetIdentityId: selection.identityId,
					issuer: config.issuer,
					linkId: target.link_id,
					authConfigRevision: target.auth_config_revision,
					createdAtMs: target.created_at_ms,
				},
			},
		},
		existingController: source.controller,
		existingResolution: source.resolution,
		ownershipEvidenceDigest: subject.ownershipEvidenceDigest,
		resolutionId:
			source.resolution?.resolution_id ??
			`resolution-v1:${await sha([config.coordinatorId, selection.deviceId, selection.identityId, digest])}`,
		consent: { purpose: PURPOSE, scope: SCOPE, evidenceDigest: digest, confirmedDigest: digest },
	};
}

function preparedResult(
	base: OwnerResolutionReviewResult,
	subject: CapturedSubject,
	target: ResolutionTarget,
	source: ResolutionSource,
	digest: string,
): OwnerResolutionReviewResult {
	return {
		...base,
		state: source.resolution ? "restored" : "ready",
		owner_resolution_digest: digest,
		account_owner_target: {
			identity_id: base.identity_id,
			link_id: target.link_id,
			auth_config_revision: target.auth_config_revision,
			created_at_ms: target.created_at_ms,
		},
		legacy_history: subject.history.records.map((row) =>
			parseControllerHistoryRecord(row, base.coordinator_id),
		),
		reviewed_weak_labels: subject.weakLabels,
		...(source.controller
			? receiptResult(source.controller, source.resolution, "reused", "reused")
			: {}),
	};
}

/** Internal review builder, not an HTTP authentication or account-mutation boundary.
 * Each call owns its reader and opaque snapshot; nothing is retained across requests.
 */
export class OwnerResolutionReviewOperations implements CoordinatorOwnerResolutionReviewStore {
	constructor(
		private readonly backend: OwnerResolutionReviewBackend,
		private readonly clock: () => number = Date.now,
	) {}

	async previewOwnerResolutionReview(
		selection: OwnerResolutionReviewSelection,
		config: CoordinatorAuthLinkConfig,
	): Promise<OwnerResolutionReviewResult> {
		return (await this.prepare(selection, config)).result;
	}

	async confirmOwnerResolutionReview(
		selection: OwnerResolutionReviewConfirmation,
		config: CoordinatorAuthLinkConfig,
	): Promise<OwnerResolutionReviewResult> {
		const confirmed = capture(selection, [
			"confirmOwnerResolutionDigest",
		])?.confirmOwnerResolutionDigest;
		const prepared = await this.prepare(selection, config);
		if (
			!isHash(confirmed) ||
			!prepared.review ||
			!prepared.evidence ||
			confirmed !== prepared.result.owner_resolution_digest
		)
			throw new OwnerResolutionReviewError("review_stale");
		try {
			const applied = await commitReviewedOwnerResolution({
				backend: this.backend,
				evidence: prepared.evidence,
				review: prepared.review,
				now: new Date(this.clock()).toISOString(),
			});
			return {
				...prepared.result,
				state: "ready",
				...receiptResult(
					applied.controller,
					applied.resolution,
					applied.controllerDisposition,
					applied.resolutionDisposition,
				),
			};
		} catch {
			throw new OwnerResolutionReviewError("owner_resolution_outcome_unknown");
		}
	}

	private async prepare(input: unknown, config: unknown): Promise<PreparedReview> {
		const selection = captureSelection(input);
		const capturedConfig = captureAuthLinkConfig(config);
		const result = baseResult(selection, capturedConfig);
		if (!selection || !capturedConfig?.enabled) {
			result.reasons = [
				"invalid_selection_or_config: select a current device and an enabled account configuration",
			];
			return { result };
		}
		try {
			await requireReviewSchema(this.backend);
			return await this.prepareCaptured(selection, capturedConfig, result);
		} catch (error) {
			return {
				result: {
					...result,
					reasons: [
						error instanceof ReviewUnavailable
							? error.message
							: "review_unavailable: ask the operator to inspect current ownership evidence",
					],
				},
			};
		}
	}

	private async captureSubject(
		selection: OwnerResolutionReviewSelection,
		config: CoordinatorAuthLinkConfig,
	): Promise<CapturedSubject> {
		const { signer, enrollmentIdentityId } = await readResolutionRequester(this.backend, selection);
		const history = await captureControllerHistory(
			{
				coordinatorId: config.coordinatorId,
				deviceId: signer.deviceId,
				publicKey: signer.publicKey,
				fingerprint: signer.fingerprint,
			},
			<T>(sql: string, values: string[]) => this.backend.all<T>({ sql, values }),
		);
		const evidence = new CoordinatorDeviceOwnershipEvidence(this.backend, config);
		const collected = await evidence.collect({
			canonicalOwnerId: selection.identityId,
			actualSigner: signer,
			verifiedHistory: history,
		});
		if (
			collected.kind !== "collected" ||
			!["compatible", "weak_label_review_required"].includes(collected.decision)
		)
			throw new ReviewUnavailable(
				"ownership_unavailable: inspect current device revocations, owner conflicts and historical labels",
			);
		const ownershipEvidenceDigest = await evidence.reviewedEvidenceDigest(
			collected.recheckSnapshot,
		);
		if (!ownershipEvidenceDigest)
			throw new ReviewUnavailable("evidence_unavailable: preview ownership evidence again");
		return {
			signer,
			enrollmentIdentityId,
			history,
			evidence,
			ownershipEvidenceDigest,
			weakLabels: collected.weakLabels,
			recheckSnapshot: collected.recheckSnapshot,
		};
	}

	private async requireUnchangedCapture(
		selection: OwnerResolutionReviewSelection,
		config: CoordinatorAuthLinkConfig,
		subject: CapturedSubject,
		target: ResolutionTarget,
	): Promise<void> {
		const check = await this.backend.first<{ matches: number }>(
			subject.evidence.prepareAtomicRecheck(subject.recheckSnapshot),
		);
		const currentTarget = await readResolutionTarget(this.backend, selection, config);
		if (
			check?.matches !== 1 ||
			currentTarget.link_id !== target.link_id ||
			currentTarget.auth_config_revision !== target.auth_config_revision ||
			currentTarget.created_at_ms !== target.created_at_ms
		)
			throw new ReviewUnavailable("review_changed: preview the current ownership evidence again");
		await requireReviewSchema(this.backend);
	}

	private async prepareCaptured(
		selection: OwnerResolutionReviewSelection,
		config: CoordinatorAuthLinkConfig,
		base: OwnerResolutionReviewResult,
	): Promise<PreparedReview> {
		const target = await readResolutionTarget(this.backend, selection, config);
		const subject = await this.captureSubject(selection, config);
		const { signer, history, evidence, ownershipEvidenceDigest } = subject;
		const source = await readResolutionSource({
			backend: this.backend,
			config,
			selection,
			signer,
			history,
			evidence,
		});
		const invites = await readResolutionInvites(this.backend, signer);
		await this.requireUnchangedCapture(selection, config, subject, target);
		const digest = await sha([
			"owner-resolution-review-v1",
			PURPOSE,
			SCOPE,
			selection,
			config.coordinatorId,
			config.issuer,
			config.revision,
			ownershipEvidenceDigest,
			target,
			controllerHistoryDigestEvidence(history),
			source.controller,
			source.resolution,
			invites,
		]);
		const review = await buildInternalReview({
			selection,
			config,
			subject,
			source,
			target,
			invites,
			digest,
		});
		return {
			evidence,
			review,
			result: preparedResult(base, subject, target, source, digest),
		};
	}
}
