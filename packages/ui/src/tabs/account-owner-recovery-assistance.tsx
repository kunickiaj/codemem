import { useId, useState } from "preact/hooks";
import { type RecoveryRequestCopy, useRecoveryRequestCopy } from "./account-owner-recovery-copy";
import {
	buildRecoverySupportRequest,
	type RecoverySelection,
	recoveryProfileKey,
} from "./account-owner-recovery-types";

export interface RecoveryAssistanceProps {
	selection: RecoverySelection;
	busy: boolean;
	onCopyRequest?: RecoveryRequestCopy;
	/** Dispatch only: the backend must verify the reply with fresh device-signed authority. */
	onImportReply?: (args: { selection: RecoverySelection; replyText: string }) => void;
}

export function RecoveryAssistance(props: RecoveryAssistanceProps) {
	const id = useId();
	const [reply, setReply] = useState("");
	const [error, setError] = useState<string | null>(null);
	const request = buildRecoverySupportRequest(props.selection);
	const text = JSON.stringify(request, null, 2);
	const supportCopy = useRecoveryRequestCopy({
		key: recoveryProfileKey(props.selection.profile) + text,
		request,
		text,
		busy: props.busy,
		onCopy: props.onCopyRequest,
	});
	const importReply = () => {
		if (props.busy || !props.onImportReply) return;
		try {
			JSON.parse(reply);
		} catch {
			setError("The operator reply is not valid JSON. Correct it and try verifying again.");
			return;
		}
		setError(null);
		props.onImportReply({ selection: props.selection, replyText: reply });
	};
	return (
		<section aria-label="Operator assistance">
			<h3>Ask a coordinator operator to review</h3>
			<p>
				Send this request directly to your coordinator operator. It contains device and group
				identifiers, so do not post it publicly or paste admin credentials.
			</p>
			<p>No admin secret or private key is included.</p>
			<label htmlFor={`${id}-request`}>Support request (no credentials)</label>
			<textarea id={`${id}-request`} className="settings-input" readOnly value={text} rows={10} />
			{props.onCopyRequest ? (
				<button
					type="button"
					className="settings-button"
					disabled={props.busy || supportCopy.copying}
					onClick={supportCopy.copy}
				>
					Copy support request
				</button>
			) : null}
			{supportCopy.error ? <p role="alert">{supportCopy.error}</p> : null}
			<p>
				Paste only the operator's approval reply, without credentials. The coordinator must verify
				it for this device before it can be used.
			</p>
			<label htmlFor={`${id}-reply`}>Noncredential operator approval reply (JSON)</label>
			<textarea
				id={`${id}-reply`}
				className="settings-input"
				value={reply}
				rows={6}
				aria-invalid={error ? "true" : undefined}
				aria-describedby={error ? `${id}-error` : undefined}
				onInput={(event) => {
					setReply(event.currentTarget.value);
					setError(null);
				}}
			/>
			{error ? (
				<p id={`${id}-error`} role="alert">
					{error}
				</p>
			) : null}
			<button
				type="button"
				className="settings-button"
				disabled={props.busy || !reply.trim() || !props.onImportReply}
				onClick={importReply}
			>
				Verify operator reply
			</button>
		</section>
	);
}
