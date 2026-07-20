import { useEffect, useRef, useState } from "preact/hooks";
import type { ShareOperationReadModel } from "../../../lib/api/sync";
import { openProjectShareFlow } from "../../project-sharing";
import { renderIntoSyncMount } from "./render-root";

type Feedback = { message: string; tone: "success" | "warning" };

interface ProjectShareOperationsProps {
	operations: ShareOperationReadModel[];
	onAdvance: (operationId: string) => Promise<ShareOperationReadModel>;
	onLoadOperation?: (operationId: string) => Promise<ShareOperationReadModel>;
	onReload: () => Promise<void>;
	copyText?: (text: string) => Promise<void>;
}

const feedbackByOperation = new Map<string, Feedback>();
let focusFeedbackForOperation: string | null = null;

const RECOVERY_ERROR_COPY: Record<string, string> = {
	operation_device_binding_missing: "The accepted device has not been linked yet.",
	operation_not_found: "This sharing operation is no longer available.",
	operation_scope_mismatch: "The invitation no longer matches the reviewed project access.",
	operation_state_invalid: "The invitation is no longer in a recoverable state.",
	reassign_capability_required: "A participating device must be updated before setup can continue.",
};

function recoveryErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (
		RECOVERY_ERROR_COPY[message] ?? "Setup could not be retried. Review diagnostics for details."
	);
}

function byPerson(operations: ShareOperationReadModel[]): ShareOperationReadModel[][] {
	const grouped = new Map<string, ShareOperationReadModel[]>();
	for (const operation of operations) {
		const personId = operation.person.actor_id;
		grouped.set(personId, [...(grouped.get(personId) ?? []), operation]);
	}
	return [...grouped.values()];
}

function personDevices(operations: ShareOperationReadModel[]) {
	return [
		...new Map(
			operations
				.flatMap((operation) => operation.devices)
				.map((device) => [device.device_id, device]),
		).values(),
	];
}

function relationshipLabel(state: ShareOperationReadModel["lifecycle"]["state"]): string {
	switch (state) {
		case "waiting_for_acceptance":
			return "Invitation pending";
		case "active":
			return "Sharing";
		case "revoking":
			return "Removing sharing";
		case "revoked":
			return "Previously shared";
		case "cancelled":
			return "Invitation cancelled";
		default:
			return "Sharing setup";
	}
}

type OperationCardProps = Omit<ProjectShareOperationsProps, "operations"> & {
	operation: ShareOperationReadModel;
};

function OperationCard({
	operation,
	onAdvance,
	onLoadOperation,
	onReload,
	copyText,
}: OperationCardProps) {
	const [busy, setBusy] = useState(false);
	const [feedback, setFeedback] = useState<Feedback | null>(
		() => feedbackByOperation.get(operation.operation_id) ?? null,
	);
	const feedbackRef = useRef<HTMLDivElement | null>(null);
	const action = operation.lifecycle.primary_action;

	useEffect(() => {
		if (focusFeedbackForOperation !== operation.operation_id || !feedbackRef.current) return;
		focusFeedbackForOperation = null;
		feedbackRef.current.focus();
	}, [feedback?.message, operation.operation_id]);

	async function copyInvite(link?: string) {
		setBusy(true);
		try {
			let inviteLink = link;
			if (!inviteLink && onLoadOperation) {
				const detail = await onLoadOperation(operation.operation_id);
				const detailAction = detail.lifecycle.primary_action;
				if (detailAction?.kind === "copy_invite") inviteLink = detailAction.invite_link;
			}
			if (!inviteLink) throw new Error("Invitation is no longer available. Refresh the status.");
			await (copyText ?? ((text) => navigator.clipboard.writeText(text)))(inviteLink);
			const next = { message: "Invite copied.", tone: "success" } satisfies Feedback;
			feedbackByOperation.set(operation.operation_id, next);
			setFeedback(next);
		} catch (error) {
			const next = {
				message: error instanceof Error ? error.message : "Invite could not be copied.",
				tone: "warning",
			} satisfies Feedback;
			feedbackByOperation.set(operation.operation_id, next);
			setFeedback(next);
		} finally {
			setBusy(false);
		}
	}

	async function retrySetup() {
		setBusy(true);
		try {
			const updated = await onAdvance(operation.operation_id);
			const next =
				updated.lifecycle.state === "active"
					? ({ message: "Setup complete.", tone: "success" } satisfies Feedback)
					: updated.lifecycle.state === "needs_attention"
						? ({ message: "Setup still needs attention.", tone: "warning" } satisfies Feedback)
						: ({
								message: `Retry started. ${updated.lifecycle.label}.`,
								tone: "success",
							} satisfies Feedback);
			feedbackByOperation.set(operation.operation_id, next);
			focusFeedbackForOperation = operation.operation_id;
			setFeedback(next);
			await onReload();
		} catch (error) {
			const next = {
				message: recoveryErrorMessage(error),
				tone: "warning",
			} satisfies Feedback;
			feedbackByOperation.set(operation.operation_id, next);
			setFeedback(next);
			queueMicrotask(() => feedbackRef.current?.focus());
		} finally {
			setBusy(false);
		}
	}

	function restartSharing() {
		const projectIds = operation.projects
			.map((project) => project.project_id?.trim())
			.filter((projectId): projectId is string => Boolean(projectId));
		if (projectIds.length !== operation.projects.length) {
			const next = {
				message: "The original project selection is unavailable. Refresh Projects and try again.",
				tone: "warning",
			} satisfies Feedback;
			feedbackByOperation.set(operation.operation_id, next);
			setFeedback(next);
			return;
		}
		if (!openProjectShareFlow(projectIds, operation.person.display_name)) {
			const next = {
				message: "Project sharing is unavailable. Refresh Projects and try again.",
				tone: "warning",
			} satisfies Feedback;
			feedbackByOperation.set(operation.operation_id, next);
			setFeedback(next);
		}
	}

	function runAction() {
		if (!action) return;
		if (action.kind === "copy_invite") {
			void copyInvite(action.invite_link);
			return;
		}
		if (action.kind === "retry_setup") {
			void retrySetup();
			return;
		}
		restartSharing();
	}

	return (
		<section
			aria-label={`${relationshipLabel(operation.lifecycle.state)} operation`}
			className="project-share-operation-card"
		>
			<div className="peer-scope-summary">{relationshipLabel(operation.lifecycle.state)}</div>
			<ul
				aria-label={`${relationshipLabel(operation.lifecycle.state)} projects`}
				className="peer-scope-chips"
			>
				{operation.projects.map((project, index) => (
					<li className="peer-scope-chip" key={`${project.display_name}:${index}`}>
						{project.display_name}
					</li>
				))}
			</ul>
			<div className="peer-scope-summary">{operation.lifecycle.label}</div>
			<div
				className="peer-meta"
				role={operation.lifecycle.state === "needs_attention" ? "alert" : undefined}
			>
				{operation.lifecycle.explanation}
			</div>
			{action ? (
				<div className="peer-actions">
					<button
						aria-busy={busy}
						className="settings-button"
						disabled={busy}
						type="button"
						onClick={runAction}
					>
						{busy ? (action.kind === "copy_invite" ? "Copying…" : "Retrying…") : action.label}
					</button>
				</div>
			) : null}
			{feedback ? (
				<div
					ref={feedbackRef}
					className={`settings-note ${feedback.tone === "warning" ? "project-attention-note" : ""}`}
					role="status"
					tabIndex={-1}
				>
					{feedback.message}
				</div>
			) : null}
		</section>
	);
}

function PersonGroup({
	operations,
	...props
}: ProjectShareOperationsProps & {
	operations: ShareOperationReadModel[];
}) {
	const person = operations[0].person;
	const devices = personDevices(operations);
	return (
		<article
			aria-label={`Project sharing with ${person.display_name}`}
			className="peer-card project-share-person-group"
		>
			<h3 className="device-row-name">{person.display_name}</h3>
			{devices.length > 0 ? (
				<ul
					aria-label={`Devices for ${person.display_name}`}
					className="peer-scope-rejections-list"
				>
					{devices.map((device) => (
						<li key={device.device_id}>{device.display_name}</li>
					))}
				</ul>
			) : null}
			{operations.map((operation) => (
				<OperationCard key={operation.operation_id} operation={operation} {...props} />
			))}
		</article>
	);
}

export function ProjectShareOperations(props: ProjectShareOperationsProps) {
	if (props.operations.length === 0) return null;
	return (
		<div className="project-share-person-groups">
			{byPerson(props.operations).map((operations) => (
				<PersonGroup key={operations[0].person.actor_id} {...props} operations={operations} />
			))}
		</div>
	);
}

export function renderProjectShareOperations(
	mount: HTMLElement,
	props: ProjectShareOperationsProps,
) {
	renderIntoSyncMount(mount, <ProjectShareOperations {...props} />);
}

export function resetProjectShareOperationFeedbackForTests() {
	feedbackByOperation.clear();
	focusFeedbackForOperation = null;
}
