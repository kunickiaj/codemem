import * as Select from "@radix-ui/react-select";

const EMPTY_SENTINEL = "__codemem-empty-select__";

/* Inline SVGs for the select trigger chevron and item indicator. Using
 * inline SVG (not <i data-lucide=...>) sidesteps a race condition: Radix
 * Select mounts its content in a Portal on open, after the Settings
 * dialog's only createIcons() pass has already run, so a lucide stub
 * inside the portal would never get replaced. */
function SelectChevronIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="14"
			stroke="currentColor"
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="2"
			viewBox="0 0 24 24"
			width="14"
		>
			<title>Open</title>
			<path d="m6 9 6 6 6-6" />
		</svg>
	);
}

function SelectCheckIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="14"
			stroke="currentColor"
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="2"
			viewBox="0 0 24 24"
			width="14"
		>
			<title>Selected</title>
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

function encodeValue(value: string): string {
	return value === "" ? EMPTY_SENTINEL : value;
}

function decodeValue(value: string): string {
	return value === EMPTY_SENTINEL ? "" : value;
}

export type RadixSelectOption = {
	value: string;
	label: string;
	disabled?: boolean;
};

type RadixSelectProps = {
	ariaLabel?: string;
	className?: string;
	contentClassName?: string;
	disabled?: boolean;
	id?: string;
	itemClassName?: string;
	onValueChange: (value: string) => void;
	options: RadixSelectOption[];
	placeholder?: string;
	triggerClassName?: string;
	value: string;
	viewportClassName?: string;
};

export function RadixSelect({
	ariaLabel,
	className,
	contentClassName,
	disabled = false,
	id,
	itemClassName,
	onValueChange,
	options,
	placeholder,
	triggerClassName,
	value,
	viewportClassName,
}: RadixSelectProps) {
	const encodedValue = value ? encodeValue(value) : undefined;

	return (
		<Select.Root
			disabled={disabled}
			onValueChange={(nextValue) => onValueChange(decodeValue(nextValue))}
			value={encodedValue}
		>
			<Select.Trigger
				aria-label={ariaLabel}
				className={triggerClassName ?? className}
				data-value={value}
				id={id}
				type="button"
			>
				<Select.Value placeholder={placeholder} />
				<Select.Icon className="sync-radix-select-icon" aria-hidden="true">
					<SelectChevronIcon />
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content className={contentClassName} position="popper">
					<Select.Viewport className={viewportClassName}>
						{options.map((option) => (
							<Select.Item
								key={encodeValue(option.value)}
								className={itemClassName}
								disabled={option.disabled}
								value={encodeValue(option.value)}
							>
								<Select.ItemText>{option.label}</Select.ItemText>
								<Select.ItemIndicator className="sync-radix-select-indicator">
									<SelectCheckIcon />
								</Select.ItemIndicator>
							</Select.Item>
						))}
					</Select.Viewport>
				</Select.Content>
			</Select.Portal>
		</Select.Root>
	);
}
