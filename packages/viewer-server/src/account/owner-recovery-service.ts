import { randomBytes } from "node:crypto";
import {
	coordinatorAuthControllerReviewAction,
	type ResolvedAccountOwnerReceiptReference,
	readAccountOwnerAssociation,
	readCoordinatorAccountLinkStatus,
	readCoordinatorResolvedAccountOwnerReceiptStatus,
	readCoordinatorResolvedAccountOwnerStatus,
} from "@codemem/core";
import { retainAccountOwnerAssociation } from "../../../core/src/account-owner-association.js";
import type { AccountContextReader } from "./context.js";
import type { AccountLinkRegistry, AccountRecoveryReservation } from "./link-registry.js";
import {
	type RecoveryOwnerCandidate,
	readRecoveryCandidates,
} from "./owner-recovery-candidates.js";
import {
	assertNoCompetingOwner,
	assertRecoverySelection,
	captureRecoveryContext,
	type RecoveryCapture,
	type RecoveryDestinations,
	recoveryDestinations,
	recoveryProfile,
} from "./owner-recovery-context.js";
import {
	parseRecoveryReply,
	RECOVERY_SCOPE,
	recoveryId,
	requireRecovery,
	unsafeStorageMessage,
	type ValidatedRecoveryReview,
	validateRecoveryReview,
} from "./owner-recovery-evidence.js";
import type {
	RecoveryPreview,
	RecoveryPreviewRequest,
	RecoveryResult,
	RecoverySelection,
} from "./owner-recovery-types.js";

export type {
	RecoveryPreview,
	RecoveryPreviewRequest,
	RecoveryProfile,
	RecoveryResult,
	RecoverySelection,
} from "./owner-recovery-types.js";
export interface AccountOwnerRecoveryServiceOptions {
	readContext: AccountContextReader;
	readAdminSecret: () => string | null | undefined;
	registry: AccountLinkRegistry;
	readRemoteStatus?: typeof readCoordinatorAccountLinkStatus;
	readRemoteOwnerStatus?: typeof readCoordinatorResolvedAccountOwnerStatus;
	readRemoteReceiptStatus?: typeof readCoordinatorResolvedAccountOwnerReceiptStatus;
	reviewOwner?: typeof coordinatorAuthControllerReviewAction;
	/** Read-only device-owner preview used only to suggest recorded owners. */
	previewDeviceOwner?: typeof coordinatorAuthControllerReviewAction;
	/** Configured `sync_coordinator_timeout_s`, read on every request. */
	readCoordinatorTimeoutS?: () => number;
	now?: () => number;
}
/**
 * Scoped owner reviews read the full Team history, and confirming sends a fresh preview
 * and then the commit. Each request can take several seconds on the live coordinator, so
 * the 3s sync default would abort a commit the user already approved.
 */
export const MIN_OWNER_REVIEW_TIMEOUT_S = 10;
interface RetainedReview {
	capture: RecoveryCapture;
	destinations: RecoveryDestinations;
	preview: RecoveryPreview;
	purpose: RecoveryPreviewRequest["purpose"];
	createdAt: number;
	reviews: Map<string, ValidatedRecoveryReview>;
	/** Original complete canonical responses are retained, not browser projections. */
	evidence: Map<string, Record<string, unknown>>;
	outcome?: Promise<RecoveryResult>;
}
interface AppliedRecoveryGroup {
	outcome: RecoveryResult["groups"][number];
	verifiedReceipt?: ResolvedAccountOwnerReceiptReference;
}
const CANDIDATE_TTL_MS = 60_000;
function groupAction(state: ValidatedRecoveryReview["state"]): "new" | "reuse" | "blocked" {
	if (state === "ready") return "new";
	if (state === "restored") return "reuse";
	return "blocked";
}
function uniqueRows<T>(rows: T[]): T[] {
	return [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()];
}
function staleDenial(error: unknown): boolean {
	return (
		error instanceof Error &&
		"status" in error &&
		error.status === 409 &&
		"code" in error &&
		error.code === "review_stale"
	);
}
/** No routes or configuration composition: these callbacks are private server capabilities. */
class AccountOwnerRecoveryService {
	#options: AccountOwnerRecoveryServiceOptions;
	#handles = new Map<string, RetainedReview>();
	#candidateCache?: { semanticId: string; at: number; candidates: RecoveryOwnerCandidate[] };
	#reservations = new Set<AccountRecoveryReservation>();
	#controller = new AbortController();
	#closed = false;
	constructor(options: AccountOwnerRecoveryServiceOptions) {
		this.#options = options;
	}
	#now(): number {
		return (this.#options.now ?? Date.now)();
	}
	#timeoutS(): number {
		const configured = this.#options.readCoordinatorTimeoutS?.() ?? 0;
		return Math.max(MIN_OWNER_REVIEW_TIMEOUT_S, Number.isFinite(configured) ? configured : 0);
	}
	#assertCurrent(capture: RecoveryCapture, reservation?: AccountRecoveryReservation): void {
		requireRecovery(!this.#closed, "unavailable");
		requireRecovery(!reservation || reservation.isCurrent(), "context_changed");
		const current = captureRecoveryContext(this.#options.readContext);
		requireRecovery(
			current.semanticId === capture.semanticId &&
				!this.#closed &&
				(!reservation || reservation.isCurrent()),
			"context_changed",
		);
	}
	#capture(): RecoveryCapture {
		requireRecovery(!this.#closed, "unavailable");
		const capture = captureRecoveryContext(this.#options.readContext);
		this.#assertCurrent(capture);
		return capture;
	}
	async #discover(capture: RecoveryCapture): Promise<string> {
		this.#assertCurrent(capture);
		const c = capture.context;
		const response = await (this.#options.readRemoteStatus ?? readCoordinatorAccountLinkStatus)({
			dbPath: c.dbPath,
			keysDir: c.keysDir,
			coordinatorUrl: c.coordinatorUrl,
			groupId: c.groupId,
			identityId: c.identityId,
			signal: this.#controller.signal,
		});
		this.#assertCurrent(capture);
		requireRecovery(
			response.kind === "status" &&
				recoveryId(response.status.coordinatorId) &&
				response.status.deviceId === c.deviceId &&
				response.status.fingerprint === c.fingerprint &&
				response.status.groupId === c.groupId,
			"unavailable",
		);
		return response.status.coordinatorId;
	}
	async getProfile() {
		const capture = this.#capture();
		const coordinatorId = await this.#discover(capture);
		this.#assertCurrent(capture);
		const adminSecret = this.#options.readAdminSecret();
		const candidates = adminSecret ? await this.#candidates(capture, adminSecret) : [];
		this.#assertCurrent(capture);
		return {
			version: 1 as const,
			profile: recoveryProfile(capture, coordinatorId),
			reviewAccess: adminSecret ? ("operator" as const) : ("request" as const),
			candidates,
		};
	}
	async #candidates(capture: RecoveryCapture, adminSecret: string) {
		// Suggestions share the coordinator's admin review rate limit with preview and
		// confirm, so reopening the dialog for the same profile reuses recent results.
		const cached = this.#candidateCache;
		if (cached?.semanticId === capture.semanticId && this.#now() - cached.at < CANDIDATE_TTL_MS)
			return structuredClone(cached.candidates);
		const c = capture.context;
		const candidates = await readRecoveryCandidates({
			previewDeviceOwner: this.#options.previewDeviceOwner ?? coordinatorAuthControllerReviewAction,
			remoteUrl: c.coordinatorUrl,
			adminSecret,
			groups: capture.groups,
			device: { deviceId: c.deviceId, fingerprint: c.fingerprint, identityId: c.identityId },
			timeoutS: this.#timeoutS(),
		});
		this.#assertCurrent(capture);
		this.#candidateCache = { semanticId: capture.semanticId, at: this.#now(), candidates };
		return structuredClone(candidates);
	}
	#reviewInput(
		capture: RecoveryCapture,
		selection: RecoverySelection,
		groupId: string,
	): Parameters<typeof coordinatorAuthControllerReviewAction>[0] {
		const adminSecret = this.#options.readAdminSecret();
		requireRecovery(typeof adminSecret === "string" && adminSecret.length > 0);
		this.#assertCurrent(capture);
		return {
			remoteUrl: capture.context.coordinatorUrl,
			adminSecret,
			purpose: "existing_account_owner" as const,
			resolutionScope: RECOVERY_SCOPE,
			groupId,
			deviceId: capture.context.deviceId,
			fingerprint: capture.context.fingerprint,
			identityId: selection.existingOwnerId,
			timeoutS: this.#timeoutS(),
		};
	}
	async #previewReview(entry: RetainedReview, groupId: string): Promise<void> {
		const input = this.#reviewInput(entry.capture, entry.preview, groupId);
		this.#assertCurrent(entry.capture);
		const raw = await (this.#options.reviewOwner ?? coordinatorAuthControllerReviewAction)(input);
		this.#assertCurrent(entry.capture);
		const evidence = structuredClone(raw);
		entry.reviews.set(groupId, validateRecoveryReview(evidence, entry.preview, groupId));
		entry.evidence.set(groupId, evidence);
	}
	#newReview(request: RecoveryPreviewRequest, capture: RecoveryCapture): RetainedReview {
		return {
			capture,
			destinations: recoveryDestinations(capture, request.profile.coordinatorId),
			purpose: request.purpose,
			createdAt: this.#now(),
			reviews: new Map(),
			evidence: new Map(),
			preview: {
				...structuredClone(request),
				scope: RECOVERY_SCOPE,
				approvalDigest: randomBytes(32).toString("hex"),
				groupPreviews: [],
				history: {
					complete: false,
					rows: [],
					operatorHelp:
						"Ask the coordinator operator to review the existing account owner and provide receipt references.",
				},
				reviewedWeakLabels: [],
			},
		};
	}
	#projectReviews(entry: RetainedReview): void {
		const reviews = [...entry.reviews.values()];
		entry.preview.history = {
			complete: true,
			rows: uniqueRows(reviews.flatMap((review) => review.rows)),
		};
		entry.preview.reviewedWeakLabels = uniqueRows(reviews.flatMap((review) => review.labels));
		entry.preview.groupPreviews = entry.preview.groups.map((groupId) => {
			const review = entry.reviews.get(groupId);
			requireRecovery(review);
			return {
				groupId,
				action: groupAction(review.state),
				reason:
					review.state === "needs_review"
						? review.reasons.join("; ")
						: "Fresh coordinator owner review.",
			};
		});
	}
	#retainHandle(entry: RetainedReview): RecoveryPreview {
		for (const [key, value] of this.#handles) {
			if (this.#now() - value.createdAt >= 5 * 60_000) this.#handles.delete(key);
		}
		while (this.#handles.size >= 16) {
			const oldest = this.#handles.keys().next().value;
			requireRecovery(oldest);
			this.#handles.delete(oldest);
		}
		this.#handles.set(entry.preview.approvalDigest, entry);
		return structuredClone(entry.preview);
	}
	async preview(request: RecoveryPreviewRequest): Promise<RecoveryPreview> {
		const capture = this.#capture();
		const coordinatorId = await this.#discover(capture);
		this.#assertCurrent(capture);
		assertRecoverySelection(request, recoveryProfile(capture, coordinatorId));
		requireRecovery(
			recoveryId(request.requestId) &&
				(request.purpose === "review" || request.purpose === "check_status"),
		);
		const entry = this.#newReview(request, capture);
		const admin = this.#options.readAdminSecret();
		this.#assertCurrent(capture);
		if (admin) {
			for (const groupId of entry.preview.groups) await this.#previewReview(entry, groupId);
			this.#projectReviews(entry);
		} else {
			await this.#requestAssistance(entry);
		}
		this.#assertCurrent(capture);
		return this.#retainHandle(entry);
	}
	async #requestAssistance(entry: RetainedReview): Promise<void> {
		for (const groupId of entry.preview.groups) {
			this.#assertCurrent(entry.capture);
			await (this.#options.readRemoteOwnerStatus ?? readCoordinatorResolvedAccountOwnerStatus)({
				...entry.capture.context,
				groupId,
				ownerIdentityId: entry.preview.existingOwnerId,
				signal: this.#controller.signal,
			});
			this.#assertCurrent(entry.capture);
		}
		entry.preview.groupPreviews = entry.preview.groups.map((groupId) => ({
			groupId,
			action: "blocked",
			reason: "An operator must review the full retained history.",
		}));
	}
	#reserve(): AccountRecoveryReservation {
		requireRecovery(!this.#closed, "unavailable");
		const reservation = this.#options.registry.tryReserveRecovery?.();
		requireRecovery(reservation, "busy");
		requireRecovery(reservation.isCurrent(), "context_changed");
		this.#reservations.add(reservation);
		return reservation;
	}
	#release(reservation: AccountRecoveryReservation): void {
		reservation.release();
		this.#reservations.delete(reservation);
	}
	async confirm(input: { preview: unknown; approvalDigest: string }): Promise<RecoveryResult> {
		requireRecovery(!this.#closed, "unavailable");
		const entry = this.#handles.get(input.approvalDigest);
		requireRecovery(entry && JSON.stringify(entry.preview) === JSON.stringify(input.preview));
		if (entry.outcome) return structuredClone(await entry.outcome);
		requireRecovery(
			this.#now() - entry.createdAt < 5 * 60_000 &&
				entry.purpose === "review" &&
				entry.preview.history.complete &&
				entry.preview.groupPreviews.every((group) => group.action !== "blocked"),
		);
		const reservation = this.#reserve();
		entry.outcome = this.#applyReview(entry, reservation).finally(() => this.#release(reservation));
		return structuredClone(await entry.outcome);
	}
	async #applyReview(
		entry: RetainedReview,
		reservation: AccountRecoveryReservation,
	): Promise<RecoveryResult> {
		this.#assertCurrent(entry.capture, reservation);
		assertNoCompetingOwner(entry.destinations, entry.preview.existingOwnerId);
		this.#assertCurrent(entry.capture, reservation);
		const groups: RecoveryResult["groups"][number][] = [];
		let verifiedReceipt: ResolvedAccountOwnerReceiptReference | undefined;
		for (const groupId of entry.preview.groups) {
			const applied = await this.#applyGroup(entry, groupId, reservation, { verifiedReceipt });
			groups.push(applied.outcome);
			// Carry only a published receipt, within this captured selection and apply call.
			verifiedReceipt ??= applied.verifiedReceipt;
		}
		return { preview: structuredClone(entry.preview), groups };
	}
	async #confirmNew(
		entry: RetainedReview,
		groupId: string,
		reservation: AccountRecoveryReservation,
	): Promise<ResolvedAccountOwnerReceiptReference> {
		const review = entry.reviews.get(groupId);
		requireRecovery(review?.digest);
		const input = this.#reviewInput(entry.capture, entry.preview, groupId);
		this.#assertCurrent(entry.capture, reservation);
		const raw = await (this.#options.reviewOwner ?? coordinatorAuthControllerReviewAction)({
			...input,
			confirmOwnerResolutionDigest: review.digest,
			assertBeforeOwnerResolutionConfirm: () => this.#assertCurrent(entry.capture, reservation),
		});
		this.#assertCurrent(entry.capture, reservation);
		const confirmed = validateRecoveryReview(structuredClone(raw), entry.preview, groupId);
		requireRecovery(
			confirmed.state === "ready" && confirmed.digest === review.digest && confirmed.receipt,
		);
		return confirmed.receipt;
	}
	async #applyGroup(
		entry: RetainedReview,
		groupId: string,
		reservation: AccountRecoveryReservation,
		options: { verifiedReceipt?: ResolvedAccountOwnerReceiptReference },
	): Promise<AppliedRecoveryGroup> {
		try {
			this.#assertCurrent(entry.capture, reservation);
			const review = entry.reviews.get(groupId);
			requireRecovery(review && review.state !== "needs_review");
			let receipt = options.verifiedReceipt ?? review.receipt;
			if (!options.verifiedReceipt && review.state === "ready")
				receipt = await this.#confirmNew(entry, groupId, reservation);
			this.#assertCurrent(entry.capture, reservation);
			requireRecovery(receipt);
			const outcome = await this.#verifyAndRetain(entry, groupId, receipt, reservation, {
				afterRemoteConfirmation: Boolean(options.verifiedReceipt) || review.state === "ready",
			});
			if (outcome.status !== "confirmed") return { outcome };
			return { outcome, verifiedReceipt: structuredClone(receipt) };
		} catch (error) {
			return {
				outcome: {
					groupId,
					status: staleDenial(error) ? "failed" : "unknown",
					message:
						unsafeStorageMessage(error) ??
						"Check coordinator status or import original receipts before trying again.",
				},
			};
		}
	}
	async #verifyAndRetain(
		entry: RetainedReview,
		groupId: string,
		receipt: ResolvedAccountOwnerReceiptReference,
		reservation: AccountRecoveryReservation,
		options: { afterRemoteConfirmation?: boolean } = {},
	): Promise<RecoveryResult["groups"][number]> {
		this.#assertCurrent(entry.capture, reservation);
		const response = await (
			this.#options.readRemoteReceiptStatus ?? readCoordinatorResolvedAccountOwnerReceiptStatus
		)({
			dbPath: entry.capture.context.dbPath,
			keysDir: entry.capture.context.keysDir,
			coordinatorUrl: entry.capture.context.coordinatorUrl,
			groupId,
			ownerIdentityId: entry.preview.existingOwnerId,
			receipt: structuredClone(receipt),
			signal: this.#controller.signal,
		});
		this.#assertCurrent(entry.capture, reservation);
		if (!this.#validOwnerProof(response, entry, groupId))
			return {
				groupId,
				status: options.afterRemoteConfirmation ? "unknown" : "failed",
				message: "The original owner receipt could not be verified with a linked account.",
			};
		this.#publish(entry, groupId, receipt, reservation);
		return {
			groupId,
			status: "confirmed",
			message: "Verified existing owner context retained; memory authorship is unchanged.",
		};
	}
	#validOwnerProof(
		response: Awaited<ReturnType<typeof readCoordinatorResolvedAccountOwnerReceiptStatus>>,
		entry: RetainedReview,
		groupId: string,
	): boolean {
		if (response.kind !== "owner_status") return false;
		const status = response.status,
			p = entry.preview.profile;
		return (
			status.version === 1 &&
			status.coordinatorId === p.coordinatorId &&
			status.groupId === groupId &&
			status.deviceId === p.deviceId &&
			status.fingerprint === p.fingerprint &&
			status.state === "owner_confirmed" &&
			status.ownerIdentity === entry.preview.existingOwnerId &&
			status.profileState === "linked" &&
			status.profile !== null &&
			typeof status.profile === "object" &&
			!Array.isArray(status.profile)
		);
	}
	#publish(
		entry: RetainedReview,
		groupId: string,
		receipt: ResolvedAccountOwnerReceiptReference,
		reservation: AccountRecoveryReservation,
	): void {
		this.#assertCurrent(entry.capture, reservation);
		assertNoCompetingOwner(entry.destinations, entry.preview.existingOwnerId);
		const destination = entry.destinations.get(groupId);
		requireRecovery(destination);
		const { profile, pins } = destination;
		const existing = readAccountOwnerAssociation(profile, { expectedProfilePins: pins });
		this.#assertCurrent(entry.capture, reservation);
		if (!existing)
			retainAccountOwnerAssociation(
				profile,
				{
					ownerIdentityId: entry.preview.existingOwnerId,
					attestationId: receipt.attestationId,
					reviewDigest: receipt.reviewEvidenceDigest,
				},
				{ expectedProfilePins: pins },
			);
		this.#assertCurrent(entry.capture, reservation);
	}
	async importReply(input: {
		selection: RecoverySelection;
		replyText: string;
	}): Promise<RecoveryResult> {
		const reservation = this.#reserve();
		try {
			const capture = this.#capture();
			const coordinatorId = await this.#discover(capture);
			this.#assertCurrent(capture, reservation);
			assertRecoverySelection(input.selection, recoveryProfile(capture, coordinatorId));
			const receipts = parseRecoveryReply(input.replyText, input.selection);
			const entry = this.#newReview(
				{ ...input.selection, requestId: randomBytes(16).toString("hex"), purpose: "review" },
				capture,
			);
			assertNoCompetingOwner(entry.destinations, entry.preview.existingOwnerId);
			const groups: RecoveryResult["groups"][number][] = [];
			for (const [groupId, receipt] of receipts)
				groups.push(await this.#importGroup(entry, groupId, receipt, reservation));
			return { preview: entry.preview, groups };
		} finally {
			this.#release(reservation);
		}
	}
	async #importGroup(
		entry: RetainedReview,
		groupId: string,
		receipt: ResolvedAccountOwnerReceiptReference,
		reservation: AccountRecoveryReservation,
	): Promise<RecoveryResult["groups"][number]> {
		try {
			return await this.#verifyAndRetain(entry, groupId, receipt, reservation);
		} catch (error) {
			return {
				groupId,
				status: "unknown",
				message:
					unsafeStorageMessage(error) ??
					"Context or proof outcome changed; check status before importing again.",
			};
		}
	}
	async close(): Promise<void> {
		this.#closed = true;
		this.#controller.abort();
		this.#handles.clear();
		for (const reservation of this.#reservations) this.#release(reservation);
	}
}
export function createAccountOwnerRecoveryService(options: AccountOwnerRecoveryServiceOptions) {
	return new AccountOwnerRecoveryService(options);
}
