type DialogCloseButtonProps = {
	ariaDisabled?: boolean;
	ariaLabel: string;
	className?: string;
	disabled?: boolean;
	onClick: () => void;
	label?: string;
};

export function DialogCloseButton({
	ariaDisabled = false,
	ariaLabel,
	className = "modal-close-button",
	disabled = false,
	onClick,
	label = "Close",
}: DialogCloseButtonProps) {
	return (
		<button
			aria-disabled={ariaDisabled ? "true" : undefined}
			aria-label={ariaLabel}
			className={className}
			disabled={disabled}
			onClick={() => {
				if (!ariaDisabled) onClick();
			}}
			type="button"
		>
			<i aria-hidden="true" className="modal-close-button-icon" data-lucide="x" />
			<span className="modal-close-button-label">{label}</span>
		</button>
	);
}
