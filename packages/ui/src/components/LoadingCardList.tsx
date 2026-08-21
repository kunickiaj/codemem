interface LoadingCardListProps {
	detailRowCount?: number;
	label: string;
}

export function LoadingCardList({ detailRowCount = 3, label }: LoadingCardListProps) {
	return (
		<>
			<span className="sr-only" role="status">
				{label}
			</span>
			<div aria-busy="true" className="loading-card-list">
				{Array.from({ length: 2 }, (_, cardIndex) => (
					<div aria-hidden="true" className="loading-card" key={cardIndex}>
						<div className="loading-card-header">
							<span
								className={`loading-card-line loading-card-title ${cardIndex % 2 ? "w-45" : "w-60"}`}
							/>
							<span className="loading-card-badge" />
						</div>
						<div className="loading-card-details">
							{Array.from({ length: detailRowCount }, (_, detailIndex) => (
								<div className="loading-card-detail" key={detailIndex}>
									<span className="loading-card-line loading-card-label" />
									<span
										className={`loading-card-line ${(cardIndex + detailIndex) % 2 ? "w-45" : "w-60"}`}
									/>
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</>
	);
}
