import { useEffect, useRef, useState } from "preact/hooks";
import {
	loadCoordinatorAdminGroupsFiltered,
	loadCoordinatorAdminJoinRequests,
	loadCoordinatorAdminStatus,
	reviewCoordinatorAdminJoinRequest,
} from "../lib/api/coordinator-admin";

/** Groups asked about at once, so a coordinator with many groups is read in batches. */
const GROUP_BATCH_SIZE = 5;

export interface DeviceJoinRequest {
	requestId: string;
	groupId: string;
	deviceId: string;
	displayName: string;
	fingerprint: string;
}

export interface DeviceJoinRequestsApi {
	/** Join requests for each group this Viewer can administer, or null when it cannot. */
	load: (
		signal: AbortSignal,
	) => Promise<{ requests: DeviceJoinRequest[]; failedGroups: number } | null>;
	review: (requestId: string, action: "approve" | "deny") => Promise<{ setupWarning: boolean }>;
}

type RawRequest = {
	request_id?: unknown;
	device_id?: unknown;
	display_name?: unknown;
	fingerprint?: unknown;
};

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Every group this Viewer can administer. The coordinator knows groups that this device's
 * sync settings do not name, so the coordinator's list comes first. When it cannot be read,
 * the locally configured groups stand in and the caller reports the gap.
 */
async function administeredGroups(
	configured: unknown,
	signal: AbortSignal,
): Promise<{ groups: string[]; listFailed: boolean }> {
	try {
		const payload = (await loadCoordinatorAdminGroupsFiltered(false, { signal })) as {
			items?: unknown;
		};
		if (!Array.isArray(payload?.items)) throw new Error("groups_invalid");
		const groups = (payload.items as { group_id?: unknown; archived_at?: unknown }[])
			.filter((group) => !group?.archived_at)
			.map((group) => text(group?.group_id))
			.filter(Boolean);
		return { groups, listFailed: false };
	} catch {
		if (signal.aborted) throw new DOMException("The request was aborted", "AbortError");
		const groups = (Array.isArray(configured) ? configured : []).map(text).filter(Boolean);
		return { groups, listFailed: true };
	}
}

async function readGroupRequests(
	groupId: string,
	signal: AbortSignal,
): Promise<DeviceJoinRequest[]> {
	const payload = (await loadCoordinatorAdminJoinRequests(groupId, { signal })) as {
		items?: unknown;
	};
	if (!Array.isArray(payload?.items)) throw new Error("join_requests_invalid");
	return (payload.items as RawRequest[]).flatMap((item) => {
		const requestId = text(item?.request_id);
		if (!requestId) return [];
		return [
			{
				requestId,
				groupId,
				deviceId: text(item.device_id),
				displayName: text(item.display_name),
				fingerprint: text(item.fingerprint),
			},
		];
	});
}

/** Runs `read` for every group, a few at a time, and keeps each group's own outcome. */
async function readInBatches<T>(groups: string[], read: (groupId: string) => Promise<T>) {
	const results: PromiseSettledResult<T>[] = [];
	for (let start = 0; start < groups.length; start += GROUP_BATCH_SIZE) {
		const batch = groups.slice(start, start + GROUP_BATCH_SIZE);
		results.push(...(await Promise.allSettled(batch.map(read))));
	}
	return results;
}

async function loadFromViewer(signal: AbortSignal) {
	const status = (await loadCoordinatorAdminStatus({ signal })) as {
		readiness?: string;
		has_admin_secret?: boolean;
		groups?: unknown;
	};
	// Approving needs the admin secret, so a device without it has nothing to review here.
	if (status.readiness !== "ready" || status.has_admin_secret !== true) return null;
	const { groups, listFailed } = await administeredGroups(status.groups, signal);
	const results = await readInBatches(groups, (groupId) => readGroupRequests(groupId, signal));
	if (signal.aborted) throw new DOMException("The request was aborted", "AbortError");
	const requests = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
	const failedReads = results.filter((result) => result.status === "rejected").length;
	if (groups.length > 0 && failedReads === groups.length)
		throw new Error("join_requests_unavailable");
	const failedGroups = failedReads + (listFailed ? 1 : 0);
	return { requests, failedGroups };
}

export const defaultDeviceJoinRequestsApi: DeviceJoinRequestsApi = {
	load: loadFromViewer,
	review: async (requestId, action) => {
		const result = (await reviewCoordinatorAdminJoinRequest(requestId, action)) as {
			setup_warning?: unknown;
		};
		return { setupWarning: Boolean(result?.setup_warning) };
	},
};

function isMissingRequest(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return message.includes("request_not_found") || message.includes("join request not found");
}

function requestName(request: DeviceJoinRequest): string {
	return request.displayName || "Unnamed device";
}

function reviewMessage(
	request: DeviceJoinRequest,
	action: "approve" | "deny",
	outcome: { setupWarning: boolean },
): { text: string; tone: "success" | "warning" } {
	const name = requestName(request);
	if (action === "deny") return { text: `Denied ${name}.`, tone: "success" };
	if (outcome.setupWarning) {
		return {
			text: `Approved ${name}, but its default group access could not be set up. Check the coordinator connection.`,
			tone: "warning",
		};
	}
	return { text: `Approved ${name}.`, tone: "success" };
}

function failureMessage(request: DeviceJoinRequest, action: "approve" | "deny", error: unknown) {
	const name = requestName(request);
	if (isMissingRequest(error))
		return `The join request from ${name} no longer exists. The list was refreshed.`;
	return `Could not ${action} ${name}. Check the coordinator connection and try again.`;
}

type Listing =
	| { state: "loading" }
	| { state: "hidden" }
	| { state: "error" }
	| { state: "ready"; requests: DeviceJoinRequest[]; failedGroups: number };

type ReviewMessage = { text: string; tone: "success" | "warning" };

/** Reads the requests again when Devices refreshes and whenever `reload` is called. */
function useJoinRequestListing(api: DeviceJoinRequestsApi, refreshRevision: number) {
	const [listing, setListing] = useState<Listing>({ state: "loading" });
	const [reloads, setReloads] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		void api.load(controller.signal).then(
			(loaded) => {
				if (controller.signal.aborted) return;
				setListing(
					loaded === null
						? { state: "hidden" }
						: { state: "ready", requests: loaded.requests, failedGroups: loaded.failedGroups },
				);
			},
			() => {
				if (!controller.signal.aborted) setListing({ state: "error" });
			},
		);
		return () => controller.abort();
	}, [api, refreshRevision, reloads]);
	return { listing, reload: () => setReloads((count) => count + 1) };
}

/** Runs one review at a time and reports its result in a status that takes focus afterward. */
function useJoinRequestReview(
	api: DeviceJoinRequestsApi,
	reload: () => void,
	onReviewed?: () => unknown,
) {
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [message, setMessage] = useState<ReviewMessage | null>(null);
	const statusRef = useRef<HTMLParagraphElement>(null);
	async function review(request: DeviceJoinRequest, action: "approve" | "deny") {
		if (pendingId) return;
		setPendingId(request.requestId);
		setMessage(null);
		try {
			const outcome = await api.review(request.requestId, action);
			setMessage(reviewMessage(request, action, outcome));
		} catch (error) {
			setMessage({ text: failureMessage(request, action, error), tone: "warning" });
		} finally {
			setPendingId(null);
			reload();
			await Promise.resolve()
				.then(() => onReviewed?.())
				.catch(() => undefined);
			// The reviewed row is gone, so its buttons cannot keep focus.
			statusRef.current?.focus();
		}
	}
	return { message, pendingId, review, statusRef };
}

/**
 * Join requests from devices that want to enter a coordinator group. Only a Viewer that
 * holds the coordinator admin secret can list or review them, so any other Viewer shows
 * nothing here.
 */
export function DeviceJoinRequests({
	api = defaultDeviceJoinRequestsApi,
	onReviewed,
	refreshRevision = 0,
}: {
	api?: DeviceJoinRequestsApi;
	/** Refreshes Devices after a review, because an approved device joins its list. */
	onReviewed?: () => unknown;
	refreshRevision?: number;
}) {
	const { listing, reload } = useJoinRequestListing(api, refreshRevision);
	const reviewing = useJoinRequestReview(api, reload, onReviewed);
	if (listing.state === "hidden" || listing.state === "loading") return null;
	if (listing.state === "error")
		return <JoinRequestsError onRetry={reload} reviewing={reviewing} />;
	const { requests, failedGroups } = listing;
	if (requests.length === 0 && failedGroups === 0 && !reviewing.message) return null;
	return (
		<JoinRequestsSection failedGroups={failedGroups} requests={requests} reviewing={reviewing} />
	);
}

function JoinRequestsError({
	onRetry,
	reviewing,
}: {
	onRetry: () => void;
	reviewing: ReturnType<typeof useJoinRequestReview>;
}) {
	const { message, statusRef } = reviewing;
	return (
		<section aria-labelledby="devices-join-requests-heading" className="devices-join-requests">
			<h3 id="devices-join-requests-heading">Join requests</h3>
			{/* A review that already went through must stay visible when the reload fails. */}
			{message ? (
				<p
					aria-live="polite"
					className="devices-join-requests-status"
					data-tone={message.tone}
					ref={statusRef}
					role="status"
					tabIndex={-1}
				>
					{message.text}
				</p>
			) : null}
			<p role="status">
				{message
					? "Could not reload join requests after this review. Check the coordinator connection, then select Retry."
					: "Could not load join requests. Check the coordinator connection."}
			</p>
			<button className="settings-button" onClick={onRetry} type="button">
				Retry
			</button>
		</section>
	);
}

function JoinRequestsSection({
	failedGroups,
	requests,
	reviewing,
}: {
	failedGroups: number;
	requests: DeviceJoinRequest[];
	reviewing: ReturnType<typeof useJoinRequestReview>;
}) {
	const { message, pendingId, review, statusRef } = reviewing;
	const multipleGroups = new Set(requests.map((request) => request.groupId)).size > 1;
	return (
		<section aria-labelledby="devices-join-requests-heading" className="devices-join-requests">
			<h3 id="devices-join-requests-heading">
				Join requests{" "}
				{requests.length > 0 ? (
					<span className="devices-heading-count">· {requests.length}</span>
				) : null}
			</h3>
			<p
				aria-live="polite"
				className="devices-join-requests-status"
				data-tone={message?.tone}
				ref={statusRef}
				role="status"
				tabIndex={-1}
			>
				{message?.text ?? ""}
			</p>
			{failedGroups > 0 ? (
				<p role="status">Some join requests could not be loaded. Refresh Devices to try again.</p>
			) : null}
			{requests.length > 0 ? (
				<ul className="devices-join-requests-list">
					{requests.map((request) => (
						<JoinRequestRow
							busy={pendingId !== null}
							key={`${request.groupId}:${request.requestId}`}
							onReview={review}
							pending={pendingId === request.requestId}
							request={request}
							showGroup={multipleGroups}
						/>
					))}
				</ul>
			) : null}
		</section>
	);
}

function JoinRequestRow({
	busy,
	onReview,
	pending,
	request,
	showGroup,
}: {
	busy: boolean;
	onReview: (request: DeviceJoinRequest, action: "approve" | "deny") => void;
	pending: boolean;
	request: DeviceJoinRequest;
	showGroup: boolean;
}) {
	const name = requestName(request);
	return (
		<li className="devices-join-request">
			<div className="devices-join-request-identity">
				<strong>{name}</strong>
				{showGroup ? <span className="small">Group {request.groupId}</span> : null}
				<details className="device-sync-details">
					<summary>Device details</summary>
					<div className="small">Device ID {request.deviceId || "unknown"}</div>
					{request.fingerprint ? (
						<div className="small">Fingerprint {request.fingerprint}</div>
					) : null}
				</details>
			</div>
			<div className="devices-join-request-actions">
				<button
					aria-label={`Approve join request from ${name}`}
					className="settings-save"
					disabled={busy}
					onClick={() => onReview(request, "approve")}
					type="button"
				>
					Approve
				</button>
				<button
					aria-label={`Deny join request from ${name}`}
					className="settings-button danger"
					disabled={busy}
					onClick={() => onReview(request, "deny")}
					type="button"
				>
					Deny
				</button>
				{pending ? <span className="small">Working…</span> : null}
			</div>
		</li>
	);
}
