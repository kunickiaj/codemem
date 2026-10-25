import { useEffect, useRef, useState } from "preact/hooks";
import type { RecoverySupportRequest } from "./account-owner-recovery-types";

export type RecoveryRequestCopy = (args: {
	request: RecoverySupportRequest;
	text: string;
}) => void | boolean | Promise<void> | Promise<boolean>;

interface CopyContext {
	key: string;
	pending: boolean;
}
interface CopyFeedback {
	context: CopyContext;
	pending: boolean;
	error: string | null;
}

function dispatchCopy(options: {
	callback: RecoveryRequestCopy;
	request: RecoverySupportRequest;
	text: string;
	finish: (outcome: { failed: boolean }) => void;
}): void {
	try {
		const result = options.callback({ request: options.request, text: options.text });
		if (result === undefined || typeof result === "boolean") {
			options.finish({ failed: result === false });
			return;
		}
		void Promise.resolve(result).then(
			(copied) => options.finish({ failed: copied === false }),
			() => options.finish({ failed: true }),
		);
	} catch {
		options.finish({ failed: true });
	}
}

export function useRecoveryRequestCopy(options: {
	key: string;
	request: RecoverySupportRequest;
	text: string;
	busy: boolean;
	onCopy?: RecoveryRequestCopy;
}) {
	const current = useRef<CopyContext>({ key: options.key, pending: false });
	const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
	if (current.current.key !== options.key) current.current = { key: options.key, pending: false };
	useEffect(
		() => () => {
			current.current = { key: "", pending: false };
		},
		[],
	);
	const copy = () => {
		if (options.busy || current.current.pending || !options.onCopy) return;
		const context = current.current;
		context.pending = true;
		setFeedback({ context, pending: true, error: null });
		dispatchCopy({
			callback: options.onCopy,
			request: options.request,
			text: options.text,
			finish: ({ failed }) => {
				if (current.current !== context) return;
				context.pending = false;
				setFeedback({
					context,
					pending: false,
					error: failed ? "Copy did not work. Select and copy the request text." : null,
				});
			},
		});
	};
	const visible = feedback?.context === current.current ? feedback : null;
	return { copy, copying: visible?.pending ?? false, error: visible?.error ?? null };
}
