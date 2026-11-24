import { deepStrictEqual, equal, match } from "node:assert/strict";
import type {
	CoordinatorDeviceRevocationCommit,
	CoordinatorDeviceRevocationPreview,
	CoordinatorRevokeDeviceActionOptions,
} from "@codemem/core";
import { it } from "vitest";
import {
	commitViewerDeviceBlock,
	type ViewerDeviceBlockDependencies,
	type ViewerDeviceBlockInput,
} from "./device-block-action.js";

type Removed = Extract<
	Awaited<ReturnType<ViewerDeviceBlockDependencies["remove"]>>,
	{ kind: "removed" }
>;
type Context = ReturnType<ViewerDeviceBlockDependencies["readContext"]>;

function refusal(status = 409, code = "revocation_target_unavailable") {
	return Object.assign(new Error("synthetic refusal"), { status, code });
}

function fixture() {
	const input: ViewerDeviceBlockInput = {
		groupId: "group",
		deviceId: "target",
		expectedContext: { coordinatorId: "coordinator", keyId: "b".repeat(64) },
		removal: {
			deviceIds: ["target"],
			expectedDigest: "c".repeat(64),
			coordinatorOrigin: "https://coordinator.invalid",
		},
	};
	const preview: CoordinatorDeviceRevocationPreview = {
		version: 1,
		state: "ready",
		coordinator_id: "coordinator",
		group_id: "group",
		device_id: "target",
		key_id: "b".repeat(64),
		scope: "whole_database_device_id_any_key_and_canonical_key_any_device_all_groups",
		expected_digest: "d".repeat(64),
	};
	const receipt: CoordinatorDeviceRevocationCommit = {
		...preview,
		state: "revoked",
		revocations: [
			{
				subject_kind: "device_id",
				subject_value: "target",
				revocation_id: "revocation-device",
				created_at: "2026-01-01",
			},
			{
				subject_kind: "ed25519_key",
				subject_value: preview.key_id,
				revocation_id: "revocation-key",
				created_at: "2026-01-01",
			},
		],
	};
	const removed: Removed = {
		kind: "removed",
		evidence: { removalId: "verified-removal", removalSeq: 4, source: "receipt" },
		localCleanup: { state: "deferred" },
		refreshPending: true,
	};
	const context: Context = {
		coordinator: { url: input.removal.coordinatorOrigin, adminSecret: "synthetic-admin" },
		local: { deviceId: "local", keyId: "a".repeat(64) },
	};
	const events: string[] = [];
	const requests: CoordinatorRevokeDeviceActionOptions[] = [];
	const removals: Parameters<ViewerDeviceBlockDependencies["remove"]>[0][] = [];
	let onRevoke: ViewerDeviceBlockDependencies["revoke"] = async (request) => {
		if (request.requiredRemovalId && request.requiredRemovalId !== removed.evidence.removalId)
			throw refusal();
		if (request.expectedDigest) {
			request.onDispatch?.();
			return receipt;
		}
		if (request.requiredRemovalId) return { ...preview, expected_digest: "e".repeat(64) };
		return preview;
	};
	let onRemove: ViewerDeviceBlockDependencies["remove"] = async () => removed;
	const deps: ViewerDeviceBlockDependencies = {
		readContext: () => context,
		revoke: async (request) => {
			requests.push(request);
			events.push(request.expectedDigest ? "block-commit" : "block-preview");
			return onRevoke(request);
		},
		remove: async (request) => {
			events.push("remove");
			removals.push(request);
			return onRemove(request);
		},
	};
	return {
		input,
		preview,
		receipt,
		removed,
		context,
		deps,
		requests,
		removals,
		events,
		setRevoke: (fn: typeof onRevoke) => {
			onRevoke = fn;
		},
		setRemove: (fn: typeof onRemove) => {
			onRemove = fn;
		},
		run: () => commitViewerDeviceBlock(input, deps),
	};
}

it("G6 previews enrollment and pin support before Remove, then previews and commits only its tombstone", async () => {
	const f = fixture();
	deepStrictEqual(await f.run(), { kind: "blocked", removal: f.removed, block: f.receipt });
	deepStrictEqual(f.events, [
		"block-preview",
		"block-preview",
		"remove",
		"block-preview",
		"block-commit",
	]);
	deepStrictEqual(f.removals, [f.input.removal]);
	const [ordinary, probe, pinned, commit] = f.requests;
	equal(ordinary?.requiredRemovalId, undefined);
	equal(ordinary?.expectedDigest, undefined);
	match(probe?.requiredRemovalId ?? "", /^[a-f0-9-]{36}$/u);
	equal(probe?.expectedDigest, undefined);
	equal(pinned?.requiredRemovalId, f.removed.evidence.removalId);
	equal(pinned?.expectedDigest, undefined);
	equal(commit?.requiredRemovalId, f.removed.evidence.removalId);
	equal(commit?.expectedDigest, "e".repeat(64));
	deepStrictEqual(commit?.expectedContext, f.input.expectedContext);
});

it("admits recovered listing evidence without repeating Remove or hiding deferred cleanup", async () => {
	const f = fixture();
	f.removed.evidence.source = "listing";
	const result = await f.run();
	equal(result.kind, "blocked");
	if (result.kind === "blocked") {
		equal(result.removal.evidence.source, "listing");
		equal(result.removal.localCleanup.state, "deferred");
		equal(result.removal.refreshPending, true);
	}
	equal(f.removals.length, 1);
});

for (const mode of ["unavailable", "wrong-key", "wrong-coordinator", "wrong-group", "wrong-id"]) {
	it(`G7 leaves enrollment untouched when ordinary preflight is ${mode}`, async () => {
		const f = fixture();
		f.setRevoke(async () => {
			if (mode === "unavailable") throw new Error("unavailable");
			const preview = { ...f.preview };
			if (mode === "wrong-key") preview.key_id = "e".repeat(64);
			if (mode === "wrong-coordinator") preview.coordinator_id = "changed";
			if (mode === "wrong-group") preview.group_id = "changed";
			if (mode === "wrong-id") preview.device_id = "changed";
			return preview;
		});
		deepStrictEqual(await f.run(), { kind: "refused", error: "block_preflight_refused" });
		equal(f.removals.length, 0);
		equal(f.requests.length, 1);
	});
}

for (const mode of ["ignored", "404", "500", "other-409", "lost"]) {
	it(`refuses before Remove when the pin compatibility probe is ${mode}`, async () => {
		const f = fixture();
		f.setRevoke(async (request) => {
			if (!request.requiredRemovalId || mode === "ignored") return f.preview;
			if (mode === "lost") throw new Error("lost probe reply");
			throw refusal(Number(mode.replace("other-", "")), "other_code");
		});
		equal((await f.run()).kind, "refused");
		equal(f.removals.length, 0);
		equal(f.requests.length, 2);
	});
}

for (const field of ["local-key", "local-id", "url", "secret"]) {
	it(`refuses before Remove if ${field} changes during preflight`, async () => {
		const f = fixture();
		f.setRevoke(async (request) => {
			if (!request.requiredRemovalId) return f.preview;
			if (field === "local-key" && f.context.local) f.context.local.keyId = "e".repeat(64);
			if (field === "local-id" && f.context.local) f.context.local.deviceId = "changed";
			if (field === "url" && f.context.coordinator)
				f.context.coordinator.url = "https://changed.invalid";
			if (field === "secret" && f.context.coordinator)
				f.context.coordinator.adminSecret = "changed";
			throw refusal();
		});
		deepStrictEqual(await f.run(), { kind: "refused", error: "block_context_changed" });
		equal(f.removals.length, 0);
	});
}

it("unknown Remove never reaches a tombstone preview or claims a definitive Block failure", async () => {
	const f = fixture();
	f.setRemove(async () => ({ kind: "unknown", error: "removal_outcome_unknown" }));
	deepStrictEqual(await f.run(), { kind: "unknown", error: "removal_outcome_unknown" });
	equal(f.requests.length, 2);
});

it("preserves an explicit Remove refusal without attempting Block", async () => {
	const f = fixture();
	f.setRemove(async () => ({ kind: "rejected", error: "removal_preview_stale" }));
	deepStrictEqual(await f.run(), { kind: "rejected", error: "removal_preview_stale" });
	equal(f.requests.length, 2);
});

it("classifies an exception from Remove conservatively and does not retry", async () => {
	const f = fixture();
	f.setRemove(async () => {
		throw new Error("synthetic lost removal reply");
	});
	equal((await f.run()).kind, "unknown");
	equal(f.removals.length, 1);
	equal(f.requests.length, 2);
});

it("keeps verified removal visible when local or coordinator context changes during Remove", async () => {
	const f = fixture();
	f.setRemove(async () => {
		f.context.local = null;
		return f.removed;
	});
	deepStrictEqual(await f.run(), {
		kind: "removed-but-block-refused",
		removal: f.removed,
		error: "block_context_changed",
	});
	equal(f.requests.length, 2);
});

for (const mode of ["unavailable", "key-changed", "coordinator-changed", "context-changed"]) {
	it(`G8 preserves Remove and avoids Block commit when pinned preview is ${mode}`, async () => {
		const f = fixture();
		f.setRevoke(async (request) => {
			if (!request.requiredRemovalId) return f.preview;
			if (request.requiredRemovalId !== f.removed.evidence.removalId) throw refusal();
			if (mode === "unavailable") throw new Error("no preview");
			if (mode === "key-changed") return { ...f.preview, key_id: "e".repeat(64) };
			if (mode === "coordinator-changed") return { ...f.preview, coordinator_id: "changed" };
			f.context.coordinator = null;
			return f.preview;
		});
		const result = await f.run();
		equal(result.kind, "removed-but-block-refused");
		equal(f.requests.length, 3);
	});
}

for (const mode of ["refused", "lost", "500", "invalid-success", "before-dispatch"]) {
	it(`G8 distinguishes ${mode} Block commit from a definite refusal`, async () => {
		const f = fixture();
		f.setRevoke(async (request) => {
			if (!request.requiredRemovalId) return f.preview;
			if (request.requiredRemovalId !== f.removed.evidence.removalId) throw refusal();
			if (!request.expectedDigest) return f.preview;
			if (mode === "before-dispatch") throw new Error("validation refused");
			request.onDispatch?.();
			if (mode === "lost") throw new Error("synthetic lost commit reply");
			if (mode === "500") throw refusal(500, "revocation_outcome_unknown");
			if (mode === "invalid-success") return { ...f.receipt, key_id: "e".repeat(64) };
			throw refusal(409, "revocation_preview_stale");
		});
		const result = await f.run();
		equal(
			result.kind,
			mode === "refused" || mode === "before-dispatch"
				? "removed-but-block-refused"
				: "removed-block-unknown",
		);
		if ("removal" in result) deepStrictEqual(result.removal, f.removed);
		equal(f.removals.length, 1);
		equal(f.requests.length, 4);
	});
}

it("captures caller-owned review values before the first await", async () => {
	const f = fixture();
	f.setRevoke(async (request) => {
		if (!request.requiredRemovalId) {
			f.input.deviceId = "replacement";
			f.input.expectedContext.keyId = "e".repeat(64);
			f.input.removal.deviceIds = ["replacement"];
			return f.preview;
		}
		if (request.requiredRemovalId !== f.removed.evidence.removalId) throw refusal();
		if (!request.expectedDigest) return f.preview;
		request.onDispatch?.();
		return f.receipt;
	});
	equal((await f.run()).kind, "blocked");
	deepStrictEqual(f.removals[0]?.deviceIds, ["target"]);
	equal(f.requests[3]?.deviceId, "target");
	equal(f.requests[3]?.expectedContext?.keyId, f.preview.key_id);
});

for (const mode of ["local-device", "local-key", "other-origin", "other-removal-target"]) {
	it(`rejects ${mode} input before any transport`, async () => {
		const f = fixture();
		if (mode === "local-device" && f.context.local) f.context.local.deviceId = "target";
		if (mode === "local-key" && f.context.local) f.context.local.keyId = f.preview.key_id;
		if (mode === "other-origin") f.input.removal.coordinatorOrigin = "https://changed.invalid";
		if (mode === "other-removal-target") f.input.removal.deviceIds = ["other"];
		equal((await f.run()).kind, "refused");
		deepStrictEqual(f.events, []);
	});
}
