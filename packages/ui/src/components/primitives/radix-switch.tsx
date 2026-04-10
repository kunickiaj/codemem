import * as Switch from "@radix-ui/react-switch";

type RadixSwitchProps = {
	"aria-labelledby"?: string;
	checked: boolean;
	className?: string;
	disabled?: boolean;
	id?: string;
	name?: string;
	onCheckedChange: (checked: boolean) => void;
	thumbClassName?: string;
};

export function RadixSwitch({
	"aria-labelledby": ariaLabelledBy,
	checked,
	className,
	disabled = false,
	id,
	name,
	onCheckedChange,
	thumbClassName,
}: RadixSwitchProps) {
	return (
		<Switch.Root
			aria-labelledby={ariaLabelledBy}
			checked={checked}
			className={className}
			disabled={disabled}
			id={id}
			name={name}
			onCheckedChange={onCheckedChange}
		>
			<Switch.Thumb className={thumbClassName} />
		</Switch.Root>
	);
}
