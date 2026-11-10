import { readCoordinatorDeviceSetup } from "@codemem/core";
import type { AccountContext, AccountContextReader } from "./context.js";
import { sameAuthority } from "./link-registry.js";
import type { AccountLinkViewV1, AccountStatusOptions } from "./status.js";

/** Eligibility is a signed read. Only an explicit sign-in starts the existing ceremony. */
export async function attachDeviceConnection(
	options: AccountStatusOptions & { readContext: AccountContextReader },
	context: AccountContext,
	view: AccountLinkViewV1,
	signal: AbortSignal,
): Promise<void> {
	if (
		!options.registry?.supportsSignIn?.() ||
		view.ownerProjection ||
		view.remote.kind !== "status" ||
		view.remote.state !== "linked" ||
		!view.remote.identityMatches
	)
		return;
	// A test that injects account status must opt into this additional signed read.
	const read =
		options.readRemoteDeviceSetup ?? (options.readRemoteStatus ? null : readCoordinatorDeviceSetup);
	if (!read) return;
	const before = options.readContext(context.groupId);
	if (
		"error" in before ||
		before.setup !== "ready" ||
		!before.context ||
		!sameAuthority(context, before.context)
	) {
		contextChanged(view);
		return;
	}
	let connectRequired = false;
	try {
		const { dbPath, keysDir, coordinatorUrl, groupId, identityId } = context;
		const result = await read({
			dbPath,
			keysDir,
			coordinatorUrl,
			groupId,
			currentIdentityId: identityId,
			signal,
		});
		connectRequired = result.kind === "connect_required";
	} catch {
		// Older or unavailable coordinators must not hide healthy account actions.
	}
	try {
		const after = options.readContext(context.groupId);
		if (signal.aborted || JSON.stringify(before) !== JSON.stringify(after)) {
			contextChanged(view);
			return;
		}
	} catch {
		contextChanged(view);
		return;
	}
	if (!connectRequired) return;
	view.canConnectDevice = true;
	view.canSignIn = true;
	view.blockedReason = null;
}

function contextChanged(view: AccountLinkViewV1): void {
	view.remote = { kind: "unavailable", code: "context_changed" };
	view.blockedReason = "status_unavailable";
	view.canLink = false;
	view.canSignIn = false;
	view.canConnectDevice = false;
}
