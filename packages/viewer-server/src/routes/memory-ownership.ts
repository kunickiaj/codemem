import {
	commitMemoryOwnershipRecovery,
	MemoryOwnershipRecoveryError,
	type MemoryStore,
	previewMemoryOwnershipRecovery,
	verifyMemoryOwnership,
} from "@codemem/core";
import { Hono } from "hono";

const actions = {
	verify: verifyMemoryOwnership,
	preview: previewMemoryOwnershipRecovery,
	commit: commitMemoryOwnershipRecovery,
};

const recoveryActions: Record<string, string> = {
	ownership_identity_changed: "reload_identity",
	ownership_sync_reset_pending: "finish_sync_reset",
	ownership_private_record_not_owned: "remove_unavailable_records",
	ownership_records_unavailable: "refresh_record_selection",
	ownership_privacy_evidence_invalid: "inspect_record_metadata",
	ownership_recovery_operation_conflict: "start_new_preview",
};

/** Mount only behind the viewer's local mutation protections when the repair stack is enabled. */
export function memoryOwnershipRoutes(storeFactory: () => MemoryStore): Hono {
	const app = new Hono();
	for (const [action, handler] of Object.entries(actions)) {
		app.post(`/api/memories/ownership/${action}`, async (context) => {
			let input: unknown;
			try {
				input = await context.req.json();
			} catch {
				return context.json(
					{ error: "ownership_request_invalid", nextAction: "refresh_preview" },
					400,
				);
			}
			try {
				return context.json(handler(storeFactory(), input));
			} catch (error) {
				if (error instanceof MemoryOwnershipRecoveryError) {
					return context.json(
						{ error: error.code, nextAction: recoveryActions[error.code] ?? "refresh_preview" },
						error.status,
					);
				}
				throw error;
			}
		});
	}
	return app;
}
