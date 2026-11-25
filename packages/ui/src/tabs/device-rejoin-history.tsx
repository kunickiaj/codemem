import { useEffect, useRef, useState } from "preact/hooks";
import { fetchJson } from "../lib/api/internal";
import type { DeviceIdentityInventoryV1 } from "../lib/api/sync";
import { DeviceRejoinNotice, validRejoin } from "./device-rejoin-notice";

const CURSOR_KEY = "codemem.device-rejoin-history.cursor.v1";
const SCOPE = /^[a-f0-9]{64}$/u;
const PAGE_SIZE = 50;
type Cursor = { scope: string; nextCursor: string | null };
type Event = { eventId: string; deviceId: string; finalizedAtMs: number };
type Page = Cursor & { localDeviceId: string; items: Event[] };
type View = Page & { prior: Cursor | null };

function id(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function readCursor(storageKey: string): Cursor | null {
	try {
		const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
		if (
			value &&
			typeof value.scope === "string" &&
			SCOPE.test(value.scope) &&
			(value.nextCursor === null || id(value.nextCursor))
		)
			return { scope: value.scope, nextCursor: value.nextCursor };
	} catch {
		// No saved cursor: first page.
	}
	return null;
}

function rememberPage(storageKey: string, view: View): void {
	try {
		const latest = readCursor(storageKey);
		// Another tab may already have moved this cursor forward.
		if (latest?.scope !== view.prior?.scope || latest?.nextCursor !== view.prior?.nextCursor)
			return;
		localStorage.setItem(
			storageKey,
			JSON.stringify({
				scope: view.scope,
				nextCursor: view.nextCursor,
			}),
		);
	} catch {
		// Keep the cursor in this view if storage is not available.
	}
}

function validPage(page: Page | null | undefined, cursor: Cursor | null): page is Page {
	return Boolean(
		page &&
			typeof page.scope === "string" &&
			SCOPE.test(page.scope) &&
			id(page.localDeviceId) &&
			Array.isArray(page.items) &&
			page.items.length <= PAGE_SIZE &&
			page.nextCursor ===
				(page.items.at(-1)?.eventId ?? (cursor?.scope === page.scope ? cursor.nextCursor : null)) &&
			page.items.every(
				(item) =>
					id(item?.eventId) &&
					validRejoin({
						rejoin: { deviceId: item.deviceId, rejoinedAtMs: item.finalizedAtMs },
					}) !== null,
			),
	);
}

async function fetchPage(cursor: Cursor | null, signal: AbortSignal) {
	const query = new URLSearchParams();
	if (cursor?.nextCursor) {
		query.set("scope", cursor.scope);
		query.set("after", cursor.nextCursor);
	}
	return fetchJson<Page | null>(`/api/sync/devices/rejoin-events${query.size ? `?${query}` : ""}`, {
		signal,
	});
}

function useRejoinHistory(options: {
	localDeviceId?: string;
	profile?: string;
	refreshRevision: number;
}) {
	const { localDeviceId, profile, refreshRevision } = options;
	const storageKey = `${CURSOR_KEY}:${JSON.stringify([localDeviceId, profile ?? ""])}`;
	const host = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<View | null>(null);
	const safeView = view?.localDeviceId === localDeviceId ? view : null;
	const lastShown = useRef<View | null>(null);
	useEffect(() => {
		if (!localDeviceId) return;
		const controller = new AbortController();
		const prior = readCursor(storageKey);
		const last = lastShown.current;
		const cursor = prior ?? (last?.localDeviceId === localDeviceId ? last : null);
		void fetchPage(cursor, controller.signal)
			.then((page) => {
				if (controller.signal.aborted) return;
				if (!validPage(page, cursor) || page.localDeviceId !== localDeviceId) {
					setView(null);
					return;
				}
				setView((previous) => {
					const retained = previous?.scope === page.scope ? previous.items : [];
					const combined = new Map(
						[...retained, ...page.items].map((item) => [item.eventId, item]),
					);
					return { ...page, items: [...combined.values()].slice(-PAGE_SIZE), prior };
				});
			})
			.catch(() => {
				if (!controller.signal.aborted) setView(null);
			});
		return () => controller.abort();
	}, [localDeviceId, refreshRevision, storageKey]);
	useEffect(() => {
		if (!safeView || !host.current || host.current.closest("[hidden]")) return;
		lastShown.current = safeView;
		rememberPage(storageKey, safeView);
	}, [safeView, storageKey]);
	return { host, events: safeView?.items ?? [] };
}

/** Recent history only. Access and actions are derived from the live inventory. */
export function DeviceRejoinHistory({
	localDeviceId,
	profile,
	refreshRevision,
	inventory,
}: {
	localDeviceId?: string;
	profile?: string;
	refreshRevision: number;
	inventory?: DeviceIdentityInventoryV1;
}) {
	const { host, events } = useRejoinHistory({ localDeviceId, profile, refreshRevision });
	const byDevice = new Map(inventory?.items.map((item) => [item.deviceId, item]));
	const items = events.filter(({ deviceId, finalizedAtMs }) => {
		if (deviceId === localDeviceId) return false;
		const item = byDevice.get(deviceId);
		return item?.state !== "conflicted" && item?.rejoin?.rejoinedAtMs !== finalizedAtMs;
	});
	return (
		<div ref={host}>
			{items.length ? (
				<aside aria-label="Device rejoin history">
					{items.map(({ eventId, deviceId, finalizedAtMs }) => (
						<DeviceRejoinNotice
							key={eventId}
							localDeviceId={localDeviceId}
							item={{
								displayName: byDevice.get(deviceId)?.displayName ?? "A device",
								rejoin: { deviceId, rejoinedAtMs: finalizedAtMs },
							}}
							showDeviceName
						/>
					))}
				</aside>
			) : null}
		</div>
	);
}
