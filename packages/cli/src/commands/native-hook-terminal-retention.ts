import { logHookEvent } from "./claude-hook-plugin-log.js";
import type { HookDeliveryOutcome } from "./hook-delivery-outcome.js";
import { type NativeHookProvider, retainNativeHookReceipt } from "./native-hook-retained-spool.js";

type NativeHookRetentionOptions = {
	provider: NativeHookProvider;
	dir: string;
	receipt: string;
	rejection: Extract<HookDeliveryOutcome, { outcome: "terminal" }>;
};

/** Call only while holding the provider ingest lock. Never substitutes delivery acceptance. */
export function retainNativeHookRejection({
	provider,
	dir,
	receipt,
	rejection,
}: NativeHookRetentionOptions): boolean {
	try {
		const retained = retainNativeHookReceipt({ dir, receipt, ...rejection });
		logHookEvent(
			`codemem ${provider}-hook-ingest rejection retained status=${retained.status} reason=${retained.reason} receipt=${retained.receipt}; inspect with diagnostics capture list-rejected --format native-hook-v1 --provider ${provider}`,
		);
		if (retained.lock === "release_failed") {
			logHookEvent(
				`codemem ${provider}-hook-ingest retention lock release failed; bytes retained, drain stopped. Stop capture and inspect receipt locks before retrying.`,
			);
			return false;
		}
		return true;
	} catch {
		logHookEvent(
			`codemem ${provider}-hook-ingest could not retain rejection safely; drain stopped. Stop capture and inspect active and retained receipts, directory write access, filesystem support, and receipt locks before retrying. Publication may be incomplete.`,
		);
		return false;
	}
}

export async function retainNativeHookRejectionWithLock(
	options: NativeHookRetentionOptions & {
		withLock: <T>(fn: () => Promise<T> | T) => Promise<T>;
	},
): Promise<void> {
	try {
		await options.withLock(() => retainNativeHookRejection(options));
	} catch {
		logHookEvent(
			`codemem ${options.provider}-hook-ingest retention deferred; inspect spooled receipts, ingest lock, and spool access before retrying.`,
		);
	}
}
