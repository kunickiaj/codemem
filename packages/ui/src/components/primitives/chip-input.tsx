/* Preact chip input — type + Enter (or comma) to add, Backspace to remove
 * the last chip when the input is empty, × to remove a specific chip.
 * Reuses the existing `.peer-scope-*` CSS from the Sync tab so the visual
 * language stays consistent. Free-text, no validation beyond trimming. */

import type { JSX } from "preact";
import { useRef } from "preact/hooks";

export interface ChipInputProps {
	values: string[];
	onValuesChange: (next: string[]) => void;
	placeholder?: string;
	emptyLabel?: string;
	disabled?: boolean;
	"aria-labelledby"?: string;
}

function parseIncoming(raw: string): string[] {
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function ChipInput({
	values,
	onValuesChange,
	placeholder,
	emptyLabel,
	disabled,
	"aria-labelledby": ariaLabelledby,
}: ChipInputProps) {
	const inputRef = useRef<HTMLInputElement | null>(null);

	const commit = () => {
		const input = inputRef.current;
		if (!input) return;
		const incoming = parseIncoming(input.value);
		if (!incoming.length) return;
		const next = Array.from(new Set([...values, ...incoming]));
		onValuesChange(next);
		input.value = "";
	};

	const removeAt = (index: number) => {
		const next = values.filter((_, i) => i !== index);
		onValuesChange(next);
	};

	const handleKeyDown: JSX.KeyboardEventHandler<HTMLInputElement> = (event) => {
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			commit();
			return;
		}
		if (event.key === "Backspace" && !event.currentTarget.value && values.length > 0) {
			event.preventDefault();
			removeAt(values.length - 1);
		}
	};

	return (
		<div class="peer-scope-editor">
			<ul class="peer-scope-chips">
				{values.length === 0 && emptyLabel ? (
					<li class="peer-scope-chip empty">{emptyLabel}</li>
				) : null}
				{values.map((value, index) => (
					<li class="peer-scope-chip" key={`${value}::${index}`}>
						<span>{value}</span>
						{!disabled ? (
							<button
								aria-label={`Remove ${value}`}
								class="peer-scope-chip-remove"
								onClick={() => removeAt(index)}
								type="button"
							>
								×
							</button>
						) : null}
					</li>
				))}
			</ul>
			<input
				aria-labelledby={ariaLabelledby}
				class="peer-scope-input"
				disabled={disabled}
				onBlur={commit}
				onKeyDown={handleKeyDown}
				placeholder={placeholder}
				ref={inputRef}
				type="text"
			/>
		</div>
	);
}
