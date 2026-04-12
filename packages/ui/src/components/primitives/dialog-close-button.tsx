type DialogCloseButtonProps = {
	ariaLabel: string;
	className?: string;
	onClick: () => void;
	label?: string;
};

export function DialogCloseButton({
	ariaLabel,
	className = "modal-close-button",
	onClick,
	label = "Close",
}: DialogCloseButtonProps) {
	return (
		<button aria-label={ariaLabel} className={className} onClick={onClick} type="button">
			<span aria-hidden="true" className="modal-close-button-icon">
				✕
			</span>
			<span className="modal-close-button-label">{label}</span>
		</button>
	);
}
