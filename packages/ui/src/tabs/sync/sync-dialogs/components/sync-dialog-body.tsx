/* Body renderer shared by the three dialog kinds. Renders the title,
 * close button, description/summary, kind-specific content (input
 * field or duplicate-person flow), and the footer action buttons.
 * Submission validation for input dialogs stays local so an invalid
 * value does not resolve the outer dialog. */

import { useEffect, useState } from "preact/hooks";
import { AutocompleteInput } from "../../../../components/primitives/autocomplete-input";
import { DialogCloseButton } from "../../../../components/primitives/dialog-close-button";
import { TextInput } from "../../../../components/primitives/text-input";
import { dialogToneClassName, resolveCurrentDialog } from "../internal";
import type { SyncDialogRequest } from "../types";
import { DuplicatePersonDialogContent } from "./duplicate-person-content";

export function SyncDialogBody({
	descriptionId,
	request,
	titleId,
}: {
	descriptionId: string;
	request: SyncDialogRequest;
	titleId: string;
}) {
	const [inputValue, setInputValue] = useState(
		request.kind === "input" ? request.initialValue || "" : "",
	);
	const [errorText, setErrorText] = useState<string | null>(null);
	const supportsLabels = request.kind !== "duplicate-person";
	const inputErrorId = "syncDialogInputError";

	useEffect(() => {
		if (request.kind === "input") {
			setInputValue(request.initialValue || "");
			setErrorText(null);
		}
	}, [request]);

	const cancelLabel = supportsLabels ? request.cancelLabel || "Cancel" : "Cancel";
	const confirmLabel = supportsLabels
		? request.confirmLabel || (request.kind === "confirm" ? "Confirm" : "Save")
		: "Confirm";

	const submit = () => {
		if (request.kind === "confirm") {
			resolveCurrentDialog(true);
			return;
		}
		if (request.kind === "duplicate-person") return;
		const trimmed = inputValue.trim();
		const validation = request.validate?.(trimmed) || null;
		if (validation) {
			setErrorText(validation);
			return;
		}
		resolveCurrentDialog(trimmed);
	};

	return (
		<div className="modal-card sync-dialog-card">
			<div className="modal-header">
				<h2 id={titleId}>{request.title}</h2>
				<DialogCloseButton
					ariaLabel={`Close ${request.title}`}
					onClick={() => resolveCurrentDialog(request.kind === "confirm" ? false : null)}
				/>
			</div>
			<div className="modal-body">
				{request.kind !== "duplicate-person" ? (
					<div className="small" id={descriptionId}>
						{request.description}
					</div>
				) : null}
				{request.kind === "duplicate-person" ? (
					<div className="small" id={descriptionId}>
						{request.summary}
					</div>
				) : null}
				{request.kind === "input" ? (
					<div className="field">
						{request.suggestions?.length ? (
							<AutocompleteInput
								aria-describedby={errorText ? `${descriptionId} ${inputErrorId}` : descriptionId}
								autoFocus
								className={errorText ? "sync-dialog-input sync-field-error" : "sync-dialog-input"}
								data-sync-primary-action="true"
								onSubmit={submit}
								onValueChange={(value) => {
									setInputValue(value);
									if (errorText) setErrorText(null);
								}}
								placeholder={request.placeholder}
								suggestions={request.suggestions}
								value={inputValue}
							/>
						) : (
							<TextInput
								aria-describedby={errorText ? `${descriptionId} ${inputErrorId}` : descriptionId}
								autoFocus
								className={errorText ? "sync-dialog-input sync-field-error" : "sync-dialog-input"}
								data-sync-primary-action="true"
								onInput={(event) => {
									setInputValue(event.currentTarget.value);
									if (errorText) setErrorText(null);
								}}
								onKeyDown={(event) => {
									if (event.key !== "Enter") return;
									event.preventDefault();
									submit();
								}}
								placeholder={request.placeholder}
								type="text"
								value={inputValue}
							/>
						)}
						{errorText ? (
							<div className="sync-field-hint" id={inputErrorId}>
								{errorText}
							</div>
						) : null}
					</div>
				) : null}
				{request.kind === "duplicate-person" ? (
					<DuplicatePersonDialogContent descriptionId={descriptionId} request={request} />
				) : null}
			</div>
			<div className="modal-footer">
				<div className="small" />
				<div className="sync-dialog-actions">
					<button
						className="settings-button"
						data-sync-dialog-action="cancel"
						onClick={() => resolveCurrentDialog(request.kind === "confirm" ? false : null)}
						type="button"
					>
						{cancelLabel}
					</button>
					{request.kind !== "duplicate-person" ? (
						<button
							autoFocus
							className={`settings-button ${dialogToneClassName(request.kind === "confirm" ? request.tone : undefined)}`}
							data-sync-dialog-action="confirm"
							onClick={submit}
							type="button"
						>
							{confirmLabel}
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}
