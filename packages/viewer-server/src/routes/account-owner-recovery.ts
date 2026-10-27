import { type Context, Hono } from "hono";
import {
	AccountOwnerRecoveryError,
	exactRecoveryFields,
	recoveryId,
	recoveryRecord,
	requireRecovery,
	unsafeStorageMessage,
} from "../account/owner-recovery-evidence.js";
import type { createAccountOwnerRecoveryService } from "../account/owner-recovery-service.js";
import type { RecoveryProfile, RecoverySelection } from "../account/owner-recovery-types.js";

type Service = ReturnType<typeof createAccountOwnerRecoveryService>;
const ROOT = "/api/account/owner-recovery";
const LIMITS = { preview: 64 * 1024, confirm: 1024 * 1024, import: 64 * 1024 };

function bodyLength(request: Request): number | null {
	requireRecovery(!request.headers.has("Transfer-Encoding"));
	const length = request.headers.get("Content-Length");
	if (length === null) return null;
	requireRecovery(/^(0|[1-9][0-9]*)$/.test(length));
	const parsed = Number(length);
	requireRecovery(Number.isSafeInteger(parsed));
	return parsed;
}

/** Limit actual UTF-8 bytes and elapsed time, regardless of transport metadata. */
async function readBody(request: Request, cap: number): Promise<Record<string, unknown>> {
	const declared = bodyLength(request);
	requireRecovery(declared === null || declared <= cap);
	requireRecovery(
		/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
			request.headers.get("Content-Type") ?? "",
		),
	);
	const reader = request.body?.getReader();
	requireRecovery(reader);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stop = () => {};
	try {
		const expired = new Promise<never>((_, reject) => {
			stop = () => reject(new AccountOwnerRecoveryError());
			timer = setTimeout(stop, 10_000);
			request.signal.addEventListener("abort", stop, { once: true });
			if (request.signal.aborted) stop();
		});
		const bytes = new Uint8Array(cap);
		let length = 0;
		while (true) {
			const chunk = await Promise.race([reader.read(), expired]);
			if (chunk.done) break;
			requireRecovery(length + chunk.value.byteLength <= cap);
			bytes.set(chunk.value, length);
			length += chunk.value.byteLength;
		}
		requireRecovery(!request.signal.aborted && (declared === null || declared === length));
		return recoveryRecord(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))),
		);
	} catch {
		throw new AccountOwnerRecoveryError();
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", stop);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function stringList(value: unknown): string[] {
	requireRecovery(Array.isArray(value) && value.every(recoveryId));
	return value;
}
function profile(value: unknown): RecoveryProfile {
	const row = recoveryRecord(value);
	exactRecoveryFields(row, [
		"contextId",
		"memoryActorId",
		"deviceId",
		"fingerprint",
		"coordinatorOrigin",
		"coordinatorId",
		"configuredGroups",
	]);
	const { contextId, memoryActorId, deviceId, fingerprint, coordinatorOrigin, coordinatorId } = row;
	requireRecovery(
		recoveryId(contextId) &&
			recoveryId(memoryActorId) &&
			recoveryId(deviceId) &&
			recoveryId(fingerprint) &&
			recoveryId(coordinatorOrigin) &&
			recoveryId(coordinatorId),
	);
	return {
		contextId,
		memoryActorId,
		deviceId,
		fingerprint,
		coordinatorOrigin,
		coordinatorId,
		configuredGroups: stringList(row.configuredGroups),
	};
}
function selection(row: Record<string, unknown>): RecoverySelection {
	requireRecovery(recoveryId(row.existingOwnerId));
	return {
		profile: profile(row.profile),
		existingOwnerId: row.existingOwnerId,
		groups: stringList(row.groups),
	};
}

async function dispatch(c: Context, service: Service): Promise<Response> {
	const request = c.req.raw;
	requireRecovery(!new URL(request.url).search && !request.signal.aborted);
	if (c.req.path === ROOT && request.method === "GET") {
		const length = bodyLength(request);
		requireRecovery(request.body === null && (length === null || length === 0));
		return c.json(await service.getProfile());
	}
	if (request.method !== "POST") return c.json({ error: "account_owner_recovery_invalid" }, 405);
	if (c.req.path === `${ROOT}/preview`) {
		const body = await readBody(request, LIMITS.preview);
		exactRecoveryFields(body, ["profile", "existingOwnerId", "groups", "requestId", "purpose"]);
		requireRecovery(
			recoveryId(body.requestId) && (body.purpose === "review" || body.purpose === "check_status"),
		);
		return c.json(
			await service.preview({
				...selection(body),
				requestId: body.requestId,
				purpose: body.purpose,
			}),
		);
	}
	if (c.req.path === `${ROOT}/confirm`) {
		const body = await readBody(request, LIMITS.confirm);
		exactRecoveryFields(body, ["preview", "approvalDigest"]);
		requireRecovery(recoveryId(body.approvalDigest));
		// The service compares the whole opaque preview to its private retained copy.
		return c.json(
			await service.confirm({ preview: body.preview, approvalDigest: body.approvalDigest }),
		);
	}
	if (c.req.path === `${ROOT}/import`) {
		const body = await readBody(request, LIMITS.import);
		exactRecoveryFields(body, ["selection", "replyText"]);
		const selected = recoveryRecord(body.selection);
		exactRecoveryFields(selected, ["profile", "existingOwnerId", "groups"]);
		requireRecovery(typeof body.replyText === "string");
		return c.json(
			await service.importReply({ selection: selection(selected), replyText: body.replyText }),
		);
	}
	return c.json({ error: "account_owner_recovery_invalid" }, 404);
}

/** Mount only after createAccountGuard: this router grants no independent authority. */
export function accountOwnerRecoveryRoutes(service: Service): Hono {
	const app = new Hono();
	app.onError((error, c) => {
		const storage = unsafeStorageMessage(error);
		if (storage)
			return c.json({ error: "account_owner_recovery_storage_unsafe", detail: storage }, 409);
		if (!(error instanceof AccountOwnerRecoveryError))
			return c.json({ error: "account_owner_recovery_unavailable" }, 503);
		const statuses = { invalid: 400, busy: 409, context_changed: 409, unavailable: 503 } as const;
		return c.json({ error: `account_owner_recovery_${error.code}` }, statuses[error.code]);
	});
	app.all(ROOT, (c) => dispatch(c, service));
	app.all(`${ROOT}/*`, (c) => dispatch(c, service));
	return app;
}
