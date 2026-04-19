import { signal } from "@preact/signals";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { render } from "preact";

export type ToastVariant = "success" | "warning" | "error" | "info";

interface ToastItem {
	id: number;
	message: string;
	variant: ToastVariant;
	durationMs: number;
}

/** Queue of active toasts — rendered by <ToastHost>, mutated by pushToast. */
const toasts = signal<ToastItem[]>([]);
let nextId = 1;

/**
 * Imperative API preserved so callsites that used the old
 * `showGlobalNotice(message, 'success' | 'warning')` helper don't have to
 * know about React state. Queues the toast; ToastHost renders it.
 */
export function pushToast(
	message: string,
	variant: ToastVariant = "success",
	durationMs = 8_000,
): void {
	if (!message) return;
	const id = nextId++;
	toasts.value = [...toasts.value, { id, message, variant, durationMs }];
}

/** Dismiss a specific toast (used by Radix onOpenChange). */
function dismissToast(id: number) {
	toasts.value = toasts.value.filter((t) => t.id !== id);
}

/** Dismiss all active toasts — rarely needed, exposed for completeness. */
export function dismissAllToasts() {
	toasts.value = [];
}

/**
 * Mount once via `mountToastHost(document.body)`. Renders the Radix
 * Provider + Viewport plus one Root per queued toast. Subscribes to the
 * signal so any pushToast triggers a re-render.
 */
export function ToastHost() {
	const items = toasts.value;
	return (
		<ToastPrimitive.Provider duration={8_000} swipeDirection="right">
			{items.map((item) => (
				<ToastPrimitive.Root
					key={item.id}
					className={`toast-root toast-${item.variant}`}
					duration={item.durationMs}
					onOpenChange={(open) => {
						if (!open) dismissToast(item.id);
					}}
					// role + aria-live derived from variant: errors/warnings are
					// 'alert' (interruptive), success/info are 'status' (polite).
					type={
						item.variant === "error" || item.variant === "warning" ? "foreground" : "background"
					}
				>
					<ToastPrimitive.Description className="toast-message">
						{item.message}
					</ToastPrimitive.Description>
					<ToastPrimitive.Close aria-label="Dismiss" className="toast-close">
						×
					</ToastPrimitive.Close>
				</ToastPrimitive.Root>
			))}
			<ToastPrimitive.Viewport className="toast-viewport" />
		</ToastPrimitive.Provider>
	);
}

/**
 * Attach the ToastHost to the given DOM element (usually document.body).
 * Idempotent — calls render() which replaces any previous tree.
 */
export function mountToastHost(root: HTMLElement) {
	render(<ToastHost />, root);
}
