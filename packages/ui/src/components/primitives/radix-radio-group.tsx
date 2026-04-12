import * as RadioGroup from "@radix-ui/react-radio-group";
import type { ComponentChildren } from "preact";

export type RadixRadioOption = {
	disabled?: boolean;
	label: ComponentChildren;
	value: string;
};

type RadixRadioGroupProps = {
	ariaDescribedby?: string;
	ariaLabel?: string;
	autoFocusValue?: string;
	indicatorClassName?: string;
	itemClassName?: string;
	itemLabelClassName?: string;
	name?: string;
	onValueChange: (value: string) => void;
	options: RadixRadioOption[];
	rootClassName?: string;
	value: string;
};

export function RadixRadioGroup({
	ariaDescribedby,
	ariaLabel,
	autoFocusValue,
	indicatorClassName,
	itemClassName,
	itemLabelClassName,
	name,
	onValueChange,
	options,
	rootClassName,
	value,
}: RadixRadioGroupProps) {
	return (
		<RadioGroup.Root
			aria-describedby={ariaDescribedby}
			aria-label={ariaLabel}
			className={rootClassName}
			name={name}
			onValueChange={onValueChange}
			value={value}
		>
			{options.map((option, index) => {
				const inputId = `radio-option-input-${index}`;
				const labelId = `radio-option-label-${index}`;
				return (
					<label className={itemClassName} htmlFor={inputId} key={option.value}>
						<RadioGroup.Item
							id={inputId}
							aria-labelledby={labelId}
							autoFocus={autoFocusValue === option.value}
							disabled={option.disabled}
							value={option.value}
						>
							<RadioGroup.Indicator className={indicatorClassName} />
						</RadioGroup.Item>
						<span className={itemLabelClassName} id={labelId}>
							{option.label}
						</span>
					</label>
				);
			})}
		</RadioGroup.Root>
	);
}
