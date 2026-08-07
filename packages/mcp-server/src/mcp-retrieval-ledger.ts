import { createHash, randomUUID } from "node:crypto";
import {
	type MemoryFilters,
	type RetrievalStatus,
	type RetrievalSurface,
	reconcileFailedRetrievalSurface,
	recordRetrievalSurface,
} from "@codemem/core";
import { canonicalJson } from "./canonical-json.js";
import { errorContent, jsonContent } from "./content.js";
import type { ToolRegistrationContext } from "./tool-context.js";

export interface McpRetrievalResult<T> {
	value: T;
	memoryIds: number[];
	candidateCount?: number;
	filters?: MemoryFilters;
	retrievalStatus?: RetrievalStatus;
	error?: string;
}

interface McpRetrievalInput {
	surface: RetrievalSurface;
	toolName: string;
	toolArguments: unknown;
	query?: string | null;
	limit?: number | null;
	resolveFilters?: () => MemoryFilters | undefined;
	requestId?: string | number;
	sourceSessionId?: string | null;
	invocationIdentity?: object;
}

const MCP_SESSION_RETRY_TTL_MS = 5 * 60 * 1000;
const MCP_SESSION_RETRY_MAX_ENTRIES = 2000;

interface InvocationLedgerIdentity {
	baseRequestId: string | null;
	requestId: string | null;
	attemptId: string;
}

interface PendingFailure {
	identity: InvocationLedgerIdentity;
	expiresAt: number;
	order: number;
}

interface SessionIdentityTracker {
	byInvocation: WeakMap<object, InvocationLedgerIdentity>;
	activeByRequest: Map<string, number>;
	pendingFailures: Map<string, PendingFailure[]>;
	pendingFailureCount: number;
	nextPendingFailureOrder: number;
	nextInvocationSequence: number;
}

// Track only live invocation objects and per-base FIFO failure queues. Pending
// identities expire after five minutes and are capped at 2,000 entries total.
// The outer WeakMap releases the whole tracker with its server registration context.
const sessionIdentityTrackers = new WeakMap<ToolRegistrationContext, SessionIdentityTracker>();
let fallbackAttemptSequence = 0;

function recordMcpRetrieval(
	context: ToolRegistrationContext,
	input: Parameters<typeof recordRetrievalSurface>[1],
	reconcileTransientFailure: boolean,
): void {
	if (!context.captureRetrievalLedger) return;
	try {
		const outcome = recordRetrievalSurface(context.store.db, input);
		if (
			reconcileTransientFailure &&
			!outcome.ok &&
			outcome.reason === "idempotency_conflict" &&
			((input.retrievalStatus === "succeeded" && input.deliveryStatus === "handed_off") ||
				(input.retrievalStatus === "no_results" && input.deliveryStatus === "not_attempted"))
		) {
			reconcileFailedRetrievalSurface(context.store.db, input);
		}
	} catch {
		// MCP responses must remain independent from local diagnostics.
	}
}

function requestAttemptId(requestId: string | null): string {
	if (requestId == null) return randomUUID();
	const hex = requestId.slice(0, 32).split("");
	hex[12] = "5";
	hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
	const value = hex.join("");
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function baseRequestIdentity(
	context: ToolRegistrationContext,
	input: McpRetrievalInput,
): string | null {
	if (input.requestId == null) return null;
	const callContentDigest = createHash("sha256")
		.update(
			canonicalJson({
				method: "tools/call",
				params: { name: input.toolName, arguments: input.toolArguments },
			}),
		)
		.digest("hex");
	return createHash("sha256")
		.update(
			JSON.stringify([
				input.sourceSessionId ?? context.retrievalLedgerScopeId,
				input.requestId,
				callContentDigest,
			]),
		)
		.digest("hex");
}

function sessionIdentityTracker(context: ToolRegistrationContext): SessionIdentityTracker {
	let tracker = sessionIdentityTrackers.get(context);
	if (!tracker) {
		tracker = {
			byInvocation: new WeakMap(),
			activeByRequest: new Map(),
			pendingFailures: new Map(),
			pendingFailureCount: 0,
			nextPendingFailureOrder: 0,
			nextInvocationSequence: 0,
		};
		sessionIdentityTrackers.set(context, tracker);
	}
	return tracker;
}

function prunePendingFailures(tracker: SessionIdentityTracker, now: number): void {
	for (const [requestId, pending] of tracker.pendingFailures) {
		const retained = pending.filter((entry) => entry.expiresAt > now);
		tracker.pendingFailureCount -= pending.length - retained.length;
		if (retained.length === 0) tracker.pendingFailures.delete(requestId);
		else if (retained.length !== pending.length) tracker.pendingFailures.set(requestId, retained);
	}
	while (tracker.pendingFailureCount > MCP_SESSION_RETRY_MAX_ENTRIES) {
		let oldestRequestId: string | undefined;
		let oldestOrder = Number.POSITIVE_INFINITY;
		for (const [requestId, pending] of tracker.pendingFailures) {
			const order = pending[0]?.order;
			if (order != null && order < oldestOrder) {
				oldestRequestId = requestId;
				oldestOrder = order;
			}
		}
		if (oldestRequestId === undefined) break;
		const pending = tracker.pendingFailures.get(oldestRequestId);
		const removed = pending?.shift();
		if (!pending || !removed) {
			tracker.pendingFailures.delete(oldestRequestId);
			continue;
		}
		tracker.pendingFailureCount -= 1;
		if (pending.length === 0) tracker.pendingFailures.delete(oldestRequestId);
	}
}

function takePendingFailure(
	tracker: SessionIdentityTracker,
	baseRequestId: string,
): InvocationLedgerIdentity | undefined {
	const pending = tracker.pendingFailures.get(baseRequestId);
	if (!pending) return undefined;
	const failure = pending.shift();
	if (!failure) return undefined;
	tracker.pendingFailureCount -= 1;
	if (pending.length === 0) tracker.pendingFailures.delete(baseRequestId);
	return failure.identity;
}

function removePendingFailure(
	tracker: SessionIdentityTracker,
	baseRequestId: string,
	attemptId: string,
): void {
	const pending = tracker.pendingFailures.get(baseRequestId);
	const index = pending?.findIndex((entry) => entry.identity.attemptId === attemptId) ?? -1;
	if (!pending || index < 0) return;
	pending.splice(index, 1);
	tracker.pendingFailureCount -= 1;
	if (pending.length === 0) tracker.pendingFailures.delete(baseRequestId);
}

function enqueuePendingFailure(
	tracker: SessionIdentityTracker,
	baseRequestId: string,
	identity: InvocationLedgerIdentity,
	now: number,
): void {
	const pending = tracker.pendingFailures.get(baseRequestId) ?? [];
	if (pending.some((entry) => entry.identity.attemptId === identity.attemptId)) return;
	pending.push({
		identity,
		expiresAt: now + MCP_SESSION_RETRY_TTL_MS,
		order: tracker.nextPendingFailureOrder,
	});
	tracker.nextPendingFailureOrder += 1;
	tracker.pendingFailures.set(baseRequestId, pending);
	tracker.pendingFailureCount += 1;
	prunePendingFailures(tracker, now);
}

function fallbackInvocationIdentity(): InvocationLedgerIdentity {
	try {
		return { baseRequestId: null, requestId: null, attemptId: randomUUID() };
	} catch {
		const timestamp = Date.now().toString(16).slice(-8).padStart(8, "0");
		const sequence = fallbackAttemptSequence.toString(16).slice(-4).padStart(4, "0");
		fallbackAttemptSequence = (fallbackAttemptSequence + 1) % 0x1_0000;
		return {
			baseRequestId: null,
			requestId: null,
			attemptId: `00000000-0000-4000-8000-${timestamp}${sequence}`,
		};
	}
}

function beginInvocation(
	context: ToolRegistrationContext,
	input: McpRetrievalInput,
): InvocationLedgerIdentity {
	const baseRequestId = baseRequestIdentity(context, input);
	if (context.retrievalLedgerIdentityMode === "stateless" || baseRequestId == null) {
		return {
			baseRequestId,
			requestId: baseRequestId,
			attemptId: requestAttemptId(baseRequestId),
		};
	}

	const tracker = sessionIdentityTracker(context);
	prunePendingFailures(tracker, Date.now());
	const candidateInvocation = input.invocationIdentity
		? tracker.byInvocation.get(input.invocationIdentity)
		: undefined;
	const knownInvocation =
		candidateInvocation?.baseRequestId === baseRequestId ? candidateInvocation : undefined;
	let identity = knownInvocation;
	if (!identity) {
		const activeCount = tracker.activeByRequest.get(baseRequestId) ?? 0;
		const pending = activeCount === 0 ? takePendingFailure(tracker, baseRequestId) : undefined;
		if (pending) {
			identity = pending;
		} else {
			const invocationSequence = tracker.nextInvocationSequence;
			tracker.nextInvocationSequence += 1;
			const requestId = createHash("sha256")
				.update(JSON.stringify([baseRequestId, context.retrievalLedgerScopeId, invocationSequence]))
				.digest("hex");
			identity = {
				baseRequestId,
				requestId,
				attemptId: requestAttemptId(requestId),
			};
		}
		if (input.invocationIdentity) tracker.byInvocation.set(input.invocationIdentity, identity);
	}
	tracker.activeByRequest.set(baseRequestId, (tracker.activeByRequest.get(baseRequestId) ?? 0) + 1);
	return identity;
}

function safeBeginInvocation(
	context: ToolRegistrationContext,
	input: McpRetrievalInput,
): InvocationLedgerIdentity {
	try {
		return beginInvocation(context, input);
	} catch {
		return fallbackInvocationIdentity();
	}
}

function completeInvocation(
	context: ToolRegistrationContext,
	identity: InvocationLedgerIdentity,
	status: "completed" | "failed",
): void {
	if (context.retrievalLedgerIdentityMode === "stateless" || identity.baseRequestId == null) return;
	const tracker = sessionIdentityTracker(context);
	const activeCount = tracker.activeByRequest.get(identity.baseRequestId) ?? 0;
	if (activeCount <= 1) tracker.activeByRequest.delete(identity.baseRequestId);
	else tracker.activeByRequest.set(identity.baseRequestId, activeCount - 1);

	if (status === "failed") {
		enqueuePendingFailure(tracker, identity.baseRequestId, identity, Date.now());
	} else {
		removePendingFailure(tracker, identity.baseRequestId, identity.attemptId);
	}
}

function safeCompleteInvocation(
	context: ToolRegistrationContext,
	identity: InvocationLedgerIdentity,
	status: "completed" | "failed",
): void {
	try {
		completeInvocation(context, identity, status);
	} catch {
		// Retrieval diagnostics must never alter the MCP tool result.
	}
}

export async function withMcpRetrieval<T>(
	context: ToolRegistrationContext,
	input: McpRetrievalInput,
	retrieve: (
		filters: MemoryFilters | undefined,
	) => McpRetrievalResult<T> | Promise<McpRetrievalResult<T>>,
) {
	const invocation = safeBeginInvocation(context, input);
	const ledgerRequestId = invocation.requestId;
	const attemptId = invocation.attemptId;
	const startedAt = new Date();
	let filters: MemoryFilters | undefined;
	try {
		filters = input.resolveFilters?.();
		const output = await retrieve(filters);
		const completedAt = new Date();
		const response = output.error ? errorContent(output.error) : jsonContent(output.value);
		const streamId = input.sourceSessionId ?? context.retrievalLedgerScopeId;
		const hasResults = output.memoryIds.length > 0;
		const isNotFoundCompletion = output.error === "not_found" && !hasResults;
		const isFailedResult =
			(output.error != null && !isNotFoundCompletion) ||
			(output.retrievalStatus === "failed" && !hasResults);
		const recordedMemoryIds = isFailedResult ? [] : output.memoryIds;
		const deliveredRetrievalStatus = output.retrievalStatus === "unknown" ? "unknown" : "succeeded";
		recordMcpRetrieval(
			context,
			{
				attemptId,
				surface: input.surface,
				trigger: "explicit",
				startedAt: startedAt.toISOString(),
				completedAt: completedAt.toISOString(),
				retrievalStatus: isFailedResult
					? "failed"
					: hasResults
						? deliveredRetrievalStatus
						: "no_results",
				deliveryStatus: isFailedResult || !hasResults ? "not_attempted" : "handed_off",
				candidateIds: recordedMemoryIds,
				selectedIds: recordedMemoryIds,
				candidateCount: hasResults && !isFailedResult ? output.candidateCount : 0,
				recorderVersion: "mcp-retrieval-v1",
				source: "mcp",
				streamId,
				sourceSessionId: input.sourceSessionId ?? null,
				requestId: ledgerRequestId,
				latencyMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
				filters: output.filters ?? filters,
				query: input.query,
				limitRequested: input.limit,
				failureCode: isFailedResult ? "tool_failed" : undefined,
				failureStage: isFailedResult ? "retrieval" : undefined,
			},
			!isFailedResult,
		);
		safeCompleteInvocation(context, invocation, isFailedResult ? "failed" : "completed");
		return response;
	} catch (error) {
		const completedAt = new Date();
		const streamId = input.sourceSessionId ?? context.retrievalLedgerScopeId;
		recordMcpRetrieval(
			context,
			{
				attemptId,
				surface: input.surface,
				trigger: "explicit",
				startedAt: startedAt.toISOString(),
				completedAt: completedAt.toISOString(),
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				candidateIds: [],
				selectedIds: [],
				recorderVersion: "mcp-retrieval-v1",
				source: "mcp",
				streamId,
				sourceSessionId: input.sourceSessionId ?? null,
				requestId: ledgerRequestId,
				latencyMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
				query: input.query,
				limitRequested: input.limit,
				filters,
				failureCode: "tool_failed",
				failureStage: "retrieval",
			},
			false,
		);
		safeCompleteInvocation(context, invocation, "failed");
		return errorContent(error instanceof Error ? error.message : String(error));
	}
}
