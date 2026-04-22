/* Ant.design-style Autocomplete built on top of Radix Popover.
 *
 * Radix has no native autocomplete primitive (see
 * radix-ui/primitives#1486). This wraps a plain <input> with a
 * Popover-anchored filtered suggestion list, arrow-key navigation,
 * Enter/Tab commit, Escape dismiss, and portal-safe positioning so it
 * renders correctly inside modal dialogs with clipping parents.
 *
 * Free-text entry is always allowed — suggestions are purely
 * accelerators, not an exclusive set. */

import * as Popover from "@radix-ui/react-popover";
import type { JSX, Ref } from "preact";
import { forwardRef } from "preact/compat";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "preact/hooks";

type InputAttrs = Omit<
	JSX.InputHTMLAttributes<HTMLInputElement>,
	"onChange" | "onInput" | "value" | "ref"
>;

export type AutocompleteInputProps = InputAttrs & {
	value: string;
	onValueChange: (value: string) => void;
	suggestions: string[];
	onSubmit?: () => void;
	maxSuggestions?: number;
};

export const AutocompleteInput = forwardRef(function AutocompleteInput(
	{
		value,
		onValueChange,
		suggestions,
		onSubmit,
		maxSuggestions = 20,
		onKeyDown,
		onFocus,
		onBlur,
		className,
		...inputProps
	}: AutocompleteInputProps,
	externalRef: Ref<HTMLInputElement>,
) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	useImperativeHandle(externalRef, () => inputRef.current as HTMLInputElement, []);

	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);

	const filtered = useMemo(() => {
		const q = value.trim().toLowerCase();
		const base = q ? suggestions.filter((s) => s.toLowerCase().includes(q)) : suggestions;
		return base.slice(0, maxSuggestions);
	}, [value, suggestions, maxSuggestions]);

	useEffect(() => {
		if (activeIndex >= filtered.length) setActiveIndex(filtered.length - 1);
	}, [filtered.length, activeIndex]);

	const shouldOpen = open && filtered.length > 0;

	const commit = (selection: string) => {
		onValueChange(selection);
		setOpen(false);
		setActiveIndex(-1);
		inputRef.current?.focus();
	};

	const handleKeyDown: JSX.KeyboardEventHandler<HTMLInputElement> = (event) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setOpen(true);
			setActiveIndex((i) => (filtered.length === 0 ? -1 : Math.min(i + 1, filtered.length - 1)));
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			if (!open) setOpen(true);
			setActiveIndex((i) => Math.max(i - 1, -1));
			return;
		}
		if (event.key === "Escape" && shouldOpen) {
			event.preventDefault();
			setOpen(false);
			setActiveIndex(-1);
			return;
		}
		if ((event.key === "Tab" || event.key === "Enter") && activeIndex >= 0) {
			const pick = filtered[activeIndex];
			if (pick) {
				event.preventDefault();
				commit(pick);
				return;
			}
		}
		if (event.key === "Enter" && onSubmit) {
			event.preventDefault();
			onSubmit();
			return;
		}
		onKeyDown?.(event);
	};

	return (
		<Popover.Root open={shouldOpen} onOpenChange={setOpen}>
			<Popover.Anchor asChild>
				<input
					{...inputProps}
					ref={inputRef}
					className={className}
					value={value}
					onInput={(event) => {
						onValueChange((event.currentTarget as HTMLInputElement).value);
						setOpen(true);
						setActiveIndex(-1);
					}}
					onFocus={(event) => {
						// Don't open on focus — only open once the user signals
						// intent (types, or presses arrow-down). Opening on focus
						// makes the dropdown appear immediately when the dialog
						// mounts with autoFocus, which hides the input.
						onFocus?.(event);
					}}
					onBlur={(event) => {
						// Let click-on-option fire before closing.
						window.setTimeout(() => setOpen(false), 120);
						onBlur?.(event);
					}}
					onKeyDown={handleKeyDown}
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={shouldOpen}
					aria-controls="autocompleteListbox"
					aria-activedescendant={
						activeIndex >= 0 ? `autocomplete-option-${activeIndex}` : undefined
					}
				/>
			</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					align="start"
					className="autocomplete-popover"
					onOpenAutoFocus={(event) => event.preventDefault()}
					onCloseAutoFocus={(event) => event.preventDefault()}
					sideOffset={4}
					style={{ width: "var(--radix-popover-trigger-width)" }}
				>
					<div className="autocomplete-listbox" id="autocompleteListbox" role="listbox">
						{filtered.map((suggestion, index) => {
							const active = index === activeIndex;
							return (
								<div
									aria-selected={active}
									className={active ? "autocomplete-option active" : "autocomplete-option"}
									id={`autocomplete-option-${index}`}
									key={suggestion}
									onMouseDown={(event) => {
										event.preventDefault();
										commit(suggestion);
									}}
									onMouseEnter={() => setActiveIndex(index)}
									role="option"
									tabIndex={-1}
								>
									{suggestion}
								</div>
							);
						})}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
});
