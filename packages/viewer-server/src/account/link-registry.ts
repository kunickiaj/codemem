import { randomUUID } from "node:crypto";
import {
	CoordinatorAccountLinkError,
	changeCoordinatorAccount,
	linkCoordinatorAccount,
} from "@codemem/core";
import type { AccountContext, AccountContextReader } from "./context.js";

type CoordinatorAuthLinkAuthorityKind = Parameters<
	typeof linkCoordinatorAccount
>[0]["expectedAuthority"];

export type AccountLinkFailure =
	| "schema_upgrade_required"
	| "configuration_invalid"
	| "device_unavailable"
	| "request_failed"
	| "review_required"
	| "link_conflict"
	| "invalid_response"
	| "context_changed"
	| "identity_mismatch"
	| "link_stopped"
	| "cancellation_unconfirmed"
	| "receiver_close_failed";
export interface AccountLinkOperationV1 {
	intent?: "connect" | "refresh" | "disconnect";
	operationId: string;
	groupId: string;
	contextId: string;
	state: "starting" | "awaiting_browser" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
	failure: AccountLinkFailure | null;
	browserUrlAvailable: boolean;
	startedAt: string;
	deadlineAt: string;
	finishedAt: string | null;
}
export type AccountLinkStartResult =
	| { operation: AccountLinkOperationV1 }
	| { error: "account_link_in_progress"; operationId?: string }
	| { error: "account_shutting_down" | "account_context_changed" };
export interface AccountLinkRegistry {
	tryReserveRecovery?(): AccountRecoveryReservation | null;
	start(options: {
		intent?: "connect" | "refresh" | "disconnect";
		context: AccountContext;
		expectedCoordinatorId: string;
		expectedAuthority: CoordinatorAuthLinkAuthorityKind;
		expectedLifecycleToken?: symbol;
		expectedLinkId?: string;
	}): AccountLinkStartResult;
	lifecycleToken(): symbol;
	get(operationId: string): AccountLinkOperationV1 | null;
	forContext(contextId: string): AccountLinkOperationV1 | null;
	hasActive(): boolean;
	browserUrl(operationId: string): string | null;
	cancel(operationId: string): AccountLinkOperationV1 | null;
	close(): Promise<void>;
}
export interface AccountRecoveryReservation {
	isCurrent(): boolean;
	release(): void;
}
export interface AccountLinkRegistryOptions {
	readContext: AccountContextReader;
	link?: typeof linkCoordinatorAccount;
	change?: typeof changeCoordinatorAccount;
	now?: () => number;
}
interface Job {
	operation: AccountLinkOperationV1;
	context: AccountContext;
	controller: AbortController;
	url: string | null;
	deliveries: number;
	cancelled: boolean;
	abortFailure: "invalid_response" | "context_changed" | null;
	expectedLinkId?: string;
	done: Promise<void>;
}
const DEADLINE_MS = 10 * 60_000;
const RETENTION_MS = 15 * 60_000;
// One viewer JS runtime, including duplicate module loads; no cross-worker coordination.
// Only opaque owner/lifecycle tokens are shared. Jobs, contexts, and URLs stay instance-private.
const BUSY_SLOT = Symbol.for("codemem.account-link.busy-owner");
const runtime = globalThis as typeof globalThis & {
	[BUSY_SLOT]?: { owner: symbol | null; lifecycle?: symbol };
};
runtime[BUSY_SLOT] ??= { owner: null };
const busySlot = runtime[BUSY_SLOT];
busySlot.lifecycle ??= Symbol();
function releaseBusyOwner(owner: symbol): void {
	if (busySlot.owner !== owner) return;
	busySlot.owner = null;
	busySlot.lifecycle = Symbol();
}
const AUTHORITY_FIELDS = [
	"contextId",
	"dbPath",
	"keysDir",
	"configPath",
	"coordinatorUrl",
	"groupId",
	"deviceId",
	"fingerprint",
	"identityId",
] as const;
export function sameAuthority(captured: AccountContext, fresh: AccountContext): boolean {
	return (
		AUTHORITY_FIELDS.every((key) => captured[key] === fresh[key]) &&
		captured.fileIdentity.dev === fresh.fileIdentity.dev &&
		captured.fileIdentity.ino === fresh.fileIdentity.ino
	);
}
function terminal(job: Job): boolean {
	return job.operation.finishedAt !== null;
}
function safeFailure(error: unknown): AccountLinkFailure {
	if (!(error instanceof CoordinatorAccountLinkError)) return "request_failed";
	if (error.code === "invalid_options") return "configuration_invalid";
	switch (error.code) {
		case "device_unavailable":
		case "request_failed":
		case "schema_upgrade_required":
		case "review_required":
		case "link_conflict":
		case "invalid_response":
		case "context_changed":
		case "identity_mismatch":
		case "link_stopped":
		case "cancellation_unconfirmed":
		case "receiver_close_failed":
			return error.code;
		default:
			return "request_failed";
	}
}
function validBrowserUrl(
	value: string,
	origin: string,
	intent: AccountLinkOperationV1["intent"],
): boolean {
	try {
		const url = new URL(value);
		return (
			url.origin === origin &&
			url.pathname ===
				(intent === "refresh" || intent === "disconnect"
					? "/auth/account/change/start"
					: "/auth/link/start") &&
			!url.username &&
			!url.password &&
			!url.hash
		);
	} catch {
		return false;
	}
}

/** Private URLs and captured profiles stay inside this process, never in public snapshots. */
class InProcessAccountLinkRegistry implements AccountLinkRegistry {
	#options: AccountLinkRegistryOptions;
	#now: () => number;
	#jobs = new Map<string, Job>();
	#shuttingDown = false;
	#closing: Promise<void> | null = null;
	#uncertainOwner: symbol | null = null;
	#recoveryOwner: symbol | null = null;
	constructor(options: AccountLinkRegistryOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}
	#current(context: AccountContext): boolean {
		try {
			const fresh = this.#options.readContext(context.groupId);
			return (
				!("error" in fresh) &&
				fresh.setup === "ready" &&
				fresh.context !== null &&
				sameAuthority(context, fresh.context)
			);
		} catch {
			return false;
		}
	}
	#cleanup(): void {
		const finished = [...this.#jobs.values()].filter(terminal);
		for (const [index, job] of finished.entries()) {
			if (job.operation.state === "outcome_unknown") continue;
			const expired = this.#now() - Date.parse(job.operation.finishedAt ?? "") >= RETENTION_MS;
			if (expired || index < finished.length - 8) this.#jobs.delete(job.operation.operationId);
		}
	}
	#active(): Job | undefined {
		this.#cleanup();
		return [...this.#jobs.values()].find(
			(job) => !terminal(job) || (!this.#shuttingDown && job.operation.state === "outcome_unknown"),
		);
	}
	#inProgress(): { error: "account_link_in_progress"; operationId?: string } | null {
		const pending = this.#active();
		if (pending)
			return { error: "account_link_in_progress", operationId: pending.operation.operationId };
		return busySlot.owner ? { error: "account_link_in_progress" } : null;
	}
	#snapshot(job: Job): AccountLinkOperationV1 {
		return { ...job.operation };
	}
	#clearUrl(job: Job): void {
		job.url = null;
		job.operation.browserUrlAvailable = false;
	}
	#finish(
		job: Job,
		state: AccountLinkOperationV1["state"],
		failure: AccountLinkFailure | null,
	): void {
		if (terminal(job)) return;
		this.#clearUrl(job);
		Object.assign(job.operation, {
			state,
			failure,
			finishedAt: new Date(this.#now()).toISOString(),
		});
		this.#cleanup();
	}
	#browserStart(job: Job, url: string): void {
		if (this.#shuttingDown || terminal(job) || job.controller.signal.aborted) return;
		if (!this.#current(job.context)) job.abortFailure = "context_changed";
		else if (!validBrowserUrl(url, job.context.coordinatorUrl, job.operation.intent))
			job.abortFailure = "invalid_response";
		if (job.abortFailure) {
			this.#clearUrl(job);
			job.controller.abort();
			return;
		}
		job.url = url;
		job.operation.state = "awaiting_browser";
		job.operation.browserUrlAvailable = job.deliveries < 5;
	}
	async #run(
		job: Job,
		expectedCoordinatorId: string,
		expectedAuthority: CoordinatorAuthLinkAuthorityKind,
	): Promise<void> {
		try {
			if (terminal(job) || job.controller.signal.aborted) {
				this.#finish(job, "cancelled", "link_stopped");
				return;
			}
			const { dbPath, keysDir, groupId, coordinatorUrl, identityId } = job.context;
			const options = {
				dbPath,
				keysDir,
				groupId,
				coordinatorUrl,
				expectedIdentityId: identityId,
				expectedCoordinatorId,
				assertCurrentContext: () => this.#current(job.context),
				signal: job.controller.signal,
				onBrowserStart: (url: string) => this.#browserStart(job, url),
			};
			const intent = job.operation.intent ?? "connect";
			if (intent === "connect") {
				await (this.#options.link ?? linkCoordinatorAccount)({ ...options, expectedAuthority });
			} else {
				const result = await (this.#options.change ?? changeCoordinatorAccount)({
					...options,
					intent,
					expectedLinkId: job.expectedLinkId,
				});
				if (
					result.state !== "completed" ||
					result.intent !== intent ||
					result.coordinatorId !== expectedCoordinatorId ||
					result.identityId !== identityId
				)
					throw new CoordinatorAccountLinkError("invalid_response");
			}
			this.#finish(job, "succeeded", null);
		} catch (error) {
			this.#fail(job, error);
		}
	}
	#fail(job: Job, error: unknown): void {
		let failure = safeFailure(error);
		if (job.abortFailure && (failure === "link_stopped" || failure === "request_failed"))
			failure = job.abortFailure;
		let state: AccountLinkOperationV1["state"] = "failed";
		if (failure === "cancellation_unconfirmed" || failure === "receiver_close_failed")
			state = "outcome_unknown";
		else if (job.cancelled && (failure === "link_stopped" || failure === "request_failed"))
			state = "cancelled";
		this.#finish(job, state, failure);
	}
	start({
		intent = "connect",
		context,
		expectedCoordinatorId,
		expectedAuthority,
		expectedLifecycleToken,
		expectedLinkId,
	}: Parameters<AccountLinkRegistry["start"]>[0]): AccountLinkStartResult {
		if (this.#shuttingDown) return { error: "account_shutting_down" };
		const pending = this.#inProgress();
		if (pending) return pending;
		if (expectedLifecycleToken && expectedLifecycleToken !== this.lifecycleToken())
			return { error: "account_context_changed" };
		if (!this.#current(context)) return { error: "account_context_changed" };
		const started = this.#now();
		const job: Job = {
			context: { ...context, fileIdentity: { ...context.fileIdentity } },
			expectedLinkId,
			controller: new AbortController(),
			url: null,
			deliveries: 0,
			cancelled: false,
			abortFailure: null,
			done: Promise.resolve(),
			operation: {
				intent,
				operationId: randomUUID(),
				groupId: context.groupId,
				contextId: context.contextId,
				state: "starting",
				failure: null,
				browserUrlAvailable: false,
				startedAt: new Date(started).toISOString(),
				deadlineAt: new Date(started + DEADLINE_MS).toISOString(),
				finishedAt: null,
			},
		};
		// Context readers and clocks are callbacks and can reenter start() synchronously.
		if (this.#shuttingDown) return { error: "account_shutting_down" };
		const reentrantPending = this.#inProgress();
		if (reentrantPending) return reentrantPending;
		if (expectedLifecycleToken && expectedLifecycleToken !== this.lifecycleToken())
			return { error: "account_context_changed" };
		const owner = Symbol();
		busySlot.owner = owner;
		busySlot.lifecycle = Symbol();
		this.#jobs.set(job.operation.operationId, job);
		// A shutdown timeout ends the public record, not the underlying Core work.
		job.done = Promise.resolve()
			.then(() => this.#run(job, expectedCoordinatorId, expectedAuthority))
			.finally(() => {
				if (job.operation.state === "outcome_unknown" && !this.#shuttingDown)
					this.#uncertainOwner = owner;
				else releaseBusyOwner(owner);
			});
		return { operation: this.#snapshot(job) };
	}
	lifecycleToken(): symbol {
		busySlot.lifecycle ??= Symbol();
		return busySlot.lifecycle;
	}
	tryReserveRecovery(): AccountRecoveryReservation | null {
		if (this.#shuttingDown || this.#inProgress()) return null;
		// Cleanup can invoke a clock callback that closes the registry or claims the slot.
		if (this.#shuttingDown || busySlot.owner) return null;
		const owner = Symbol();
		busySlot.owner = owner;
		busySlot.lifecycle = Symbol();
		this.#recoveryOwner = owner;
		return {
			isCurrent: () =>
				!this.#shuttingDown && this.#recoveryOwner === owner && busySlot.owner === owner,
			release: () => {
				if (this.#recoveryOwner !== owner) return;
				this.#recoveryOwner = null;
				releaseBusyOwner(owner);
			},
		};
	}
	get(operationId: string): AccountLinkOperationV1 | null {
		this.#cleanup();
		const job = this.#jobs.get(operationId);
		return job ? this.#snapshot(job) : null;
	}
	browserUrl(operationId: string): string | null {
		this.#cleanup();
		const job = this.#jobs.get(operationId);
		if (
			!job ||
			this.#shuttingDown ||
			terminal(job) ||
			job.controller.signal.aborted ||
			job.operation.state !== "awaiting_browser" ||
			job.deliveries >= 5
		)
			return null;
		if (!this.#current(job.context)) {
			job.abortFailure = "context_changed";
			this.#clearUrl(job);
			job.controller.abort();
			return null;
		}
		const url = job.url;
		if (url) job.deliveries += 1;
		if (job.deliveries >= 5) this.#clearUrl(job);
		return url;
	}
	cancel(operationId: string): AccountLinkOperationV1 | null {
		this.#cleanup();
		const job = this.#jobs.get(operationId);
		if (!job) return null;
		if (!terminal(job)) {
			job.cancelled = true;
			this.#clearUrl(job);
			job.controller.abort();
		}
		return this.#snapshot(job);
	}
	async #drain(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all([...this.#jobs.values()].map((job) => job.done)),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5000);
				}),
			]);
		} finally {
			clearTimeout(timer);
			for (const job of this.#jobs.values())
				this.#finish(job, "outcome_unknown", "cancellation_unconfirmed");
		}
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#shuttingDown = true;
		if (this.#recoveryOwner) {
			releaseBusyOwner(this.#recoveryOwner);
			this.#recoveryOwner = null;
		}
		for (const job of this.#jobs.values()) {
			this.#clearUrl(job);
			if (!terminal(job)) {
				job.cancelled = true;
				job.controller.abort();
			}
		}
		this.#closing = this.#drain().finally(() => {
			if (this.#uncertainOwner) releaseBusyOwner(this.#uncertainOwner);
		});
		return this.#closing;
	}
	hasActive(): boolean {
		return Boolean(this.#active() || busySlot.owner);
	}
	forContext(contextId: string): AccountLinkOperationV1 | null {
		this.#cleanup();
		const job = [...this.#jobs.values()]
			.reverse()
			.find((item) => item.operation.contextId === contextId);
		return job ? this.#snapshot(job) : null;
	}
}

export function createAccountLinkRegistry(
	options: AccountLinkRegistryOptions,
): AccountLinkRegistry {
	return new InProcessAccountLinkRegistry(options);
}
