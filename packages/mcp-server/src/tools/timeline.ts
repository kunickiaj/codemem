import { dedupeOrderedIds, type MemoryItemResponse, projectMatchesFilter } from "@codemem/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent, jsonContent } from "../content.js";
import { getManyForMcp } from "../memory-access.js";
import { buildFilters } from "../project-scope.js";
import { filterSchema } from "../schemas.js";
import type { ToolRegistrationContext } from "../tool-context.js";

export function registerTimelineTools(server: McpServer, context: ToolRegistrationContext): void {
	const { defaultProject, store } = context;

	server.tool(
		"memory_timeline",
		"Get a chronological window of memories around an anchor (by ID or query).",
		{
			query: z.string().optional().describe("Search query to find anchor"),
			memory_id: z.number().int().optional().describe("Anchor memory ID"),
			depth_before: z.number().int().min(0).default(3).describe("Items before anchor"),
			depth_after: z.number().int().min(0).default(3).describe("Items after anchor"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args, defaultProject());
				const items = store.timeline(
					args.query ?? null,
					args.memory_id ?? null,
					args.depth_before,
					args.depth_after,
					filters,
				);
				return jsonContent({ items });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	server.tool(
		"memory_expand",
		"Fetch memories by ID with surrounding timeline context.",
		{
			ids: z
				.array(z.union([z.number(), z.string()]))
				.max(200)
				.describe("Memory IDs to expand"),
			depth_before: z.number().int().min(0).default(3).describe("Timeline items before"),
			depth_after: z.number().int().min(0).default(3).describe("Timeline items after"),
			include_observations: z.boolean().default(false).describe("Include full observation details"),
			...filterSchema,
		},
		async (args) => {
			try {
				// Explicit blank `project` clears scoping for cross-project expansion.
				// Only fall back to the server default when `project` is omitted entirely.
				const filterDefaultProject =
					args.project !== undefined && !args.project.trim() ? null : defaultProject();
				const filters = buildFilters(args, filterDefaultProject);
				const resolvedProject = filters?.project ?? null;
				const { ordered: orderedIds, invalid: invalidIds } = dedupeOrderedIds(args.ids);
				const errors: Array<Record<string, unknown>> = [];

				if (invalidIds.length > 0) {
					errors.push({
						code: "INVALID_ARGUMENT",
						field: "ids",
						message: "some ids are not valid integers",
						ids: invalidIds,
					});
				}

				const missingNotFound: number[] = [];
				const missingProjectMismatch: number[] = [];
				const missingFilterMismatch: number[] = [];
				const anchors: MemoryItemResponse[] = [];
				const timelineItems: MemoryItemResponse[] = [];
				const timelineSeen = new Set<number>();
				const sessionProjects = new Map<number, string | null>();

				for (const memoryId of orderedIds) {
					const item = store.get(memoryId);
					if (!item?.active) {
						missingNotFound.push(memoryId);
						continue;
					}

					const sessionId = item.session_id;
					if (resolvedProject && sessionId > 0) {
						if (!sessionProjects.has(sessionId)) {
							const row = store.db
								.prepare("SELECT project FROM sessions WHERE id = ? LIMIT 1")
								.get(sessionId) as { project: string | null } | undefined;
							sessionProjects.set(sessionId, typeof row?.project === "string" ? row.project : null);
						}
						if (!projectMatchesFilter(resolvedProject, sessionProjects.get(sessionId) ?? null)) {
							missingProjectMismatch.push(memoryId);
							continue;
						}
					} else if (resolvedProject && sessionId <= 0) {
						missingProjectMismatch.push(memoryId);
						continue;
					}

					const expanded = store.timeline(
						null,
						memoryId,
						args.depth_before,
						args.depth_after,
						filters,
					);
					const anchor = expanded.find((expandedItem) => expandedItem.id === memoryId);
					if (!anchor) {
						missingFilterMismatch.push(memoryId);
						continue;
					}

					anchors.push(anchor);
					for (const expandedItem of expanded) {
						const expandedId = expandedItem.id;
						if (expandedId <= 0 || timelineSeen.has(expandedId)) continue;
						timelineSeen.add(expandedId);
						timelineItems.push(expandedItem);
					}
				}

				if (missingNotFound.length > 0) {
					errors.push({
						code: "NOT_FOUND",
						field: "ids",
						message: "some requested ids were not found",
						ids: missingNotFound,
					});
				}
				if (missingProjectMismatch.length > 0) {
					errors.push({
						code: "PROJECT_MISMATCH",
						field: "project",
						message: "some requested ids are outside the requested project scope",
						ids: missingProjectMismatch,
					});
				}
				if (missingFilterMismatch.length > 0) {
					errors.push({
						code: "FILTER_MISMATCH",
						field: "filters",
						message: "some requested ids are outside the requested filters",
						ids: missingFilterMismatch,
					});
				}

				let observations: MemoryItemResponse[] = [];
				if (args.include_observations) {
					const observationSeen = new Set<number>();
					const observationIds: number[] = [];
					for (const item of [...anchors, ...timelineItems]) {
						if (item.id > 0 && !observationSeen.has(item.id)) {
							observationSeen.add(item.id);
							observationIds.push(item.id);
						}
					}
					observations = getManyForMcp(store, observationIds, filters);
				}

				return jsonContent({
					anchors,
					timeline: timelineItems,
					observations,
					missing_ids: orderedIds.filter(
						(memoryId: number) =>
							missingNotFound.includes(memoryId) ||
							missingProjectMismatch.includes(memoryId) ||
							missingFilterMismatch.includes(memoryId),
					),
					errors,
					metadata: {
						project: resolvedProject,
						requested_ids_count: orderedIds.length,
						returned_anchor_count: anchors.length,
						timeline_count: timelineItems.length,
						include_observations: args.include_observations,
					},
				});
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
