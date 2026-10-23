import { type Signal, signal } from "@preact/signals";
import { render } from "preact";
import { useLayoutEffect } from "preact/hooks";

type OperationTone = "pending" | "success" | "warning";
interface OperationStatus {
	id: symbol;
	message: string;
	detail?: string;
	tone: OperationTone;
}

interface StatusHost {
	status: Signal<OperationStatus | null>;
	dispose: () => void;
}

const hosts = new WeakMap<HTMLElement, StatusHost>();

function createHeaderMeasurement(root: HTMLElement) {
	let previous: { value: string; priority: string } | null = null;
	return () => {
		if (!root.isConnected) return;
		const header = root.closest("header");
		if (!header) return;
		const style = root.ownerDocument.body.style;
		if (!root.querySelector(".operation-status")) {
			if (previous) {
				style.setProperty("--header-sticky-offset", previous.value, previous.priority);
				previous = null;
			}
			return;
		}
		const height = header.getBoundingClientRect().height;
		if (!height) return;
		previous ??= {
			value: style.getPropertyValue("--header-sticky-offset"),
			priority: style.getPropertyPriority("--header-sticky-offset"),
		};
		style.setProperty("--header-sticky-offset", `${height}px`);
	};
}

function OperationStatusHost({
	measure,
	status,
}: {
	measure: () => void;
	status: StatusHost["status"];
}) {
	const current = status.value;
	useLayoutEffect(measure);
	const dismiss = () => {
		if (status.value?.id === current?.id && current?.tone !== "pending") status.value = null;
	};
	return (
		<div className={current ? "operation-status" : undefined} data-tone={current?.tone}>
			<div role="status" aria-label="Device sync" aria-live="polite" aria-atomic="true">
				{current && <span>{current.message}</span>}
				{current?.detail && <span className="operation-status-detail"> {current.detail}</span>}
			</div>
			{current && current.tone !== "pending" && (
				<button type="button" className="ghost" onClick={dismiss} aria-label="Dismiss sync status">
					Dismiss
				</button>
			)}
		</div>
	);
}

/** Mount the empty live region before an action starts; status survives tab changes, not reloads. */
export function mountOperationStatusHost(root: HTMLElement): () => void {
	const existing = hosts.get(root);
	if (existing) return existing.dispose;
	const status = signal<OperationStatus | null>(null);
	const measure = createHeaderMeasurement(root);
	const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
	const header = root.closest("header");
	if (header) observer?.observe(header);
	window.addEventListener("resize", measure);
	const dispose = () => {
		if (hosts.get(root)?.status !== status) return;
		observer?.disconnect();
		window.removeEventListener("resize", measure);
		render(null, root);
		hosts.delete(root);
		measure();
	};
	hosts.set(root, { status, dispose });
	render(<OperationStatusHost measure={measure} status={status} />, root);
	return dispose;
}

/** The token belongs to this entry only: late results cannot replace a newer entry. */
export function startOperationStatus(message: string, detail?: string) {
	const root = document.getElementById("operationStatusRoot");
	if (!root) return null;
	mountOperationStatusHost(root);
	const host = hosts.get(root);
	if (!host) return null;
	const id = Symbol("operation");
	host.status.value = { id, message, detail, tone: "pending" };
	return {
		finish(message: string, tone: "success" | "warning"): boolean {
			if (
				!root.isConnected ||
				hosts.get(root) !== host ||
				host.status.value?.id !== id ||
				host.status.value.tone !== "pending"
			)
				return false;
			host.status.value = { id, message, tone };
			return true;
		},
	};
}
