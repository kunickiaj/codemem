/**
 * Keyboard activation helpers.
 *
 * The viewer UI has very few <form> elements, so the browser default of
 * "Enter inside an input submits the surrounding form" does not apply across
 * most modals, inline forms, and inline editors. This module supplies a
 * single, well-tested keydown handler that surfaces the same behavior in a
 * framework-agnostic way: attach it via Preact's `onKeyDown`, an imperative
 * `addEventListener("keydown", ...)`, or a `<form>` `onSubmit` shim.
 *
 * Conventions, derived from VS Code / Linear / GitHub:
 *
 *   - Enter, when focus is on a single-line input (HTMLInputElement that is
 *     not type="button"/"submit"/etc, or any other non-button/non-link/
 *     non-select control), fires the scope's primary action.
 *   - Cmd+Enter (macOS) or Ctrl+Enter (other platforms) fires the primary
 *     action from anywhere inside the scope, including textareas and
 *     contenteditable regions.
 *   - Escape fires the scope's cancel handler if provided. Radix Dialog
 *     already handles Escape for modal close, so this is opt-in for
 *     non-Radix surfaces (inline editors, custom popovers, etc.).
 *   - The handler ignores composition events (IME candidate selection) and
 *     events that have already been prevented by a deeper listener.
 *   - The handler skips elements that opt out via the
 *     `data-primary-action-ignore="true"` attribute, anywhere on or above
 *     the focused element. Useful for multi-line composers or Radix
 *     listbox options that need their own Enter semantics.
 *
 * The helper does NOT intercept Enter on buttons, anchors, or selects: those
 * controls have well-defined native Enter behavior (click self, navigate,
 * open picker) and stealing it would be surprising.
 */

export interface PrimaryActionKeyboardOptions {
	/**
	 * Called when Enter (on a single-line control) or Cmd/Ctrl+Enter (anywhere
	 * including textareas) is pressed inside the scope.
	 */
	onSubmit: () => void;
	/**
	 * Optional: called when Escape is pressed inside the scope. Most modals
	 * delegate Escape to Radix and should leave this undefined.
	 */
	onCancel?: () => void;
	/**
	 * When true, the helper does nothing. Use this to honor a disabled or
	 * saving state on the primary action, so Enter does not fire while Save
	 * is grayed out.
	 */
	disabled?: boolean;
}

const FORM_CONTROL_TAGS = new Set(["BUTTON", "A", "SELECT"]);
const INPUT_TYPES_WITH_NATIVE_ENTER = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

function shouldIgnoreTarget(target: HTMLElement | null): boolean {
	if (!target) return false;
	if (typeof target.closest !== "function") return false;
	return target.closest('[data-primary-action-ignore="true"]') !== null;
}

function isTextareaOrEditable(target: HTMLElement | null): boolean {
	if (!target) return false;
	if (target instanceof HTMLTextAreaElement) return true;
	if ("isContentEditable" in target && target.isContentEditable) return true;
	return false;
}

function hasNativeEnterBehavior(target: HTMLElement | null): boolean {
	if (!target) return false;
	if (FORM_CONTROL_TAGS.has(target.tagName)) return true;
	return target instanceof HTMLInputElement && INPUT_TYPES_WITH_NATIVE_ENTER.has(target.type);
}

function hasPrimaryModifier(event: KeyboardEvent): boolean {
	return event.metaKey || event.ctrlKey;
}

/**
 * Handle a keydown event according to the primary-action conventions
 * documented at the top of this module.
 *
 * This function is a pure helper: it inspects the event, decides whether to
 * fire `onSubmit` or `onCancel`, and calls `event.preventDefault()` when it
 * acts. It never mutates DOM state directly. Callers should attach it to the
 * scope that owns the primary action (modal card, form element, inline
 * editor row).
 */
export function handlePrimaryActionKeyboard(
	event: KeyboardEvent,
	options: PrimaryActionKeyboardOptions,
): void {
	if (options.disabled) return;
	if (event.defaultPrevented) return;
	if (event.isComposing) return;
	if (event.key !== "Enter" && event.key !== "Escape") return;

	const target = event.target instanceof HTMLElement ? event.target : null;
	if (shouldIgnoreTarget(target)) return;

	if (event.key === "Escape") {
		if (!options.onCancel) return;
		event.preventDefault();
		options.onCancel();
		return;
	}

	// Enter — skip when focus is on a control with its own native Enter
	// semantics. Buttons/links/selects all do something useful on Enter
	// already and intercepting would be surprising.
	if (hasNativeEnterBehavior(target)) return;

	const requiresModifier = isTextareaOrEditable(target);
	if (requiresModifier && !hasPrimaryModifier(event)) return;

	event.preventDefault();
	options.onSubmit();
}
