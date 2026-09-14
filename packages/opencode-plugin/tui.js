import { CodememNotifications } from "./rpc.js";

const DEFAULT_MAX_SEEN_NOTICES = 64;
const DEFAULT_REPLAY_TIMEOUT_MS = 250;
const TOAST_VARIANTS = new Set(["info", "success", "warning", "error"]);

const sameLocation = (left, right) =>
	left?.directory === right?.directory &&
	(left?.workspaceID ?? null) === (right?.workspaceID ?? null);

const normalizeNotice = (value) => {
	if (!value || typeof value !== "object") return null;
	const id = typeof value.id === "string" ? value.id : "";
	const message = typeof value.message === "string" ? value.message : "";
	const variant = TOAST_VARIANTS.has(value.variant) ? value.variant : "warning";
	if (!id || !message) return null;
	return { id, message, variant };
};

export const createCodememTuiPlugin = ({
	maxSeenNotices = DEFAULT_MAX_SEEN_NOTICES,
	replayTimeoutMs = DEFAULT_REPLAY_TIMEOUT_MS,
} = {}) =>
	({
		id: "codemem.tui",
		async setup(context) {
			const seen = new Set();
			let active = true;
			const seenLimit =
				Number.isSafeInteger(maxSeenNotices) && maxSeenNotices > 0
					? maxSeenNotices
					: DEFAULT_MAX_SEEN_NOTICES;
			const location = context.location ?? context.data?.location?.default?.();
			const show = (input) => {
				if (!active) return;
				const notice = normalizeNotice(input);
				if (!notice || seen.has(notice.id)) return;
				seen.add(notice.id);
				while (seen.size > seenLimit) seen.delete(seen.values().next().value);
				try {
					context.ui.toast.show({
						title: "Codemem",
						message: notice.message,
						variant: notice.variant,
					});
				} catch {
					// Notifications must not affect the TUI plugin lifecycle.
				}
			};

			let notifications;
			try {
				notifications = context.client.rpc(CodememNotifications);
			} catch {
				return undefined;
			}

			let unsubscribe = () => {};
			try {
				unsubscribe = notifications.events.on("notice", (event) => {
					if (location && !sameLocation(event.location, location)) return;
					show(event.data);
				});
			} catch {
				// Replay can still deliver notices when live subscription is unavailable.
			}

			const replayAbort = new AbortController();
			const replayLimit =
				Number.isSafeInteger(replayTimeoutMs) && replayTimeoutMs > 0
					? replayTimeoutMs
					: DEFAULT_REPLAY_TIMEOUT_MS;
			let replayTimer;
			const replayTimeout = new Promise((resolve) => {
				replayTimer = setTimeout(() => {
					replayAbort.abort();
					resolve(null);
				}, replayLimit);
				replayTimer.unref?.();
			});
			const replayTask = Promise.resolve()
				.then(() =>
					notifications.drain({}, {
						...(location ? { location } : {}),
						signal: replayAbort.signal,
					}),
				)
				.catch(() => null);
			const replay = await Promise.race([replayTask, replayTimeout]);
			clearTimeout(replayTimer);
			for (const notice of Array.isArray(replay?.notices) ? replay.notices : []) show(notice);

			return () => {
				active = false;
				replayAbort.abort();
				try {
					unsubscribe();
				} catch {
					// Best-effort cleanup only.
				}
			};
		},
	});

export default createCodememTuiPlugin();
