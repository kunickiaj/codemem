export type SyncActionFeedback = {
	message: string;
	tone: "success" | "warning";
};

export function SyncInlineFeedback({ feedback }: { feedback: SyncActionFeedback | null }) {
	if (!feedback?.message) return null;
	return (
		<div
			className={`sync-inline-feedback ${feedback.tone}`}
			role={feedback.tone === "warning" ? "alert" : "status"}
			aria-live={feedback.tone === "warning" ? "assertive" : "polite"}
		>
			{feedback.message}
		</div>
	);
}
