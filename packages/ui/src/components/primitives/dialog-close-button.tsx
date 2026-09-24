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
			<svg aria-hidden="true" className="modal-close-button-icon" fill="none" viewBox="0 0 24 24">
				<path
					d="M18 6 6 18M6 6l12 12"
					stroke="currentColor"
					strokeLinecap="round"
					strokeWidth="2"
				/>
			</svg>
			<span className="modal-close-button-label">{label}</span>
		</button>
	);
}
