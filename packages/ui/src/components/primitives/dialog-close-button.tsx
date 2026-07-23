type DialogCloseButtonProps = {
	ariaLabel: string;
	className?: string;
	disabled?: boolean;
	onClick: () => void;
	label?: string;
};

export function DialogCloseButton({
	ariaLabel,
	className = "modal-close-button",
	disabled = false,
	onClick,
	label = "Close",
}: DialogCloseButtonProps) {
	return (
		<button
			aria-label={ariaLabel}
			className={className}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			<i aria-hidden="true" className="modal-close-button-icon" data-lucide="x" />
			<span className="modal-close-button-label">{label}</span>
		</button>
	);
}
