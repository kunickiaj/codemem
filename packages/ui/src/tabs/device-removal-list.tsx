import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { fetchJson } from "../lib/api/internal";
import { confirmAndBlockRemovedDevice, type DeviceBlockApi } from "./device-block-confirmation";

interface RemovedEnrollment {
	device_id: string;
	group_id: string;
	display_name: string | null;
	removal_seq: number;
}

type Listing =
	| { state: "loading" }
	| { state: "ready"; items: RemovedEnrollment[] }
	| { state: "error" };

export function RemovedDevicesPanel({ blockApi }: { blockApi?: DeviceBlockApi } = {}) {
	const [open, setOpen] = useState(false);
	const [listing, setListing] = useState<Listing>({ state: "loading" });
	const [revision, setRevision] = useState(0);
	const heading = useRef<HTMLElement>(null);
	const retry = () => {
		heading.current?.focus();
		setRevision((value) => value + 1);
	};

	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		setListing({ state: "loading" });
		void fetchJson<{ items: RemovedEnrollment[] }>("/api/sync/devices/removals", {
			signal: controller.signal,
		}).then(
			(payload) => {
				if (controller.signal.aborted) return;
				const items = payload?.items;
				setListing(Array.isArray(items) ? { state: "ready", items } : { state: "error" });
			},
			() => {
				if (!controller.signal.aborted) setListing({ state: "error" });
			},
		);
		return () => controller.abort();
	}, [open, revision]);

	return (
		<details className="card" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary ref={heading}>Removed devices</summary>
			{open && <RemovedEnrollments listing={listing} onRetry={retry} blockApi={blockApi} />}
		</details>
	);
}

function RemovedEnrollments({
	listing,
	onRetry,
	blockApi,
}: {
	listing: Listing;
	onRetry: () => void;
	blockApi?: DeviceBlockApi;
}) {
	if (listing.state === "loading") return <p role="status">Loading removed devices…</p>;
	if (listing.state === "error") {
		return (
			<>
				<p role="status">Could not list removed devices. Check your coordinator settings.</p>
				<button className="settings-button" type="button" onClick={onRetry}>
					Retry
				</button>
			</>
		);
	}
	if (listing.items.length === 0) return <p>No removed devices</p>;
	return (
		<ul>
			{listing.items.map((item) => (
				<li key={item.removal_seq}>
					{item.display_name || item.device_id} · {item.group_id}
					{blockApi && <BlockRemovedDevice item={item} api={blockApi} onBlocked={onRetry} />}
				</li>
			))}
		</ul>
	);
}

function BlockRemovedDevice({
	item,
	api,
	onBlocked,
}: {
	item: RemovedEnrollment;
	api: DeviceBlockApi;
	onBlocked: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const displayName = item.display_name || item.device_id;
	async function block() {
		setBusy(true);
		setFailed(false);
		try {
			if (
				await confirmAndBlockRemovedDevice(
					{ groupId: item.group_id, deviceId: item.device_id, displayName },
					api,
				)
			)
				onBlocked();
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<button
				aria-label={`Block ${displayName} permanently`}
				className="settings-button"
				disabled={busy}
				onClick={() => void block()}
				type="button"
			>
				Block device permanently
			</button>
			{failed && (
				<span role="status">Could not confirm the block. Refresh Devices before trying again.</span>
			)}
		</>
	);
}

export function mountRemovedDevices(mount: HTMLElement) {
	render(<RemovedDevicesPanel />, mount);
}
