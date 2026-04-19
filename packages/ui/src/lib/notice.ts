import { dismissAllToasts, pushToast } from "../components/primitives/toast";

/**
 * Legacy signature kept for callsite stability. Now delegates to the Radix
 * Toast host (mounted once at app boot). Historically rendered via a static
 * #globalNotice div; that markup is gone — ToastHost owns the UI.
 */
export function showGlobalNotice(message: string, type: "success" | "warning" = "success"): void {
	pushToast(message, type);
}

/** Back-compat: clears the entire toast queue. */
export function hideGlobalNotice(): void {
	dismissAllToasts();
}
