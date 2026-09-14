export const CODEMEM_NOTIFICATION_RPC_ID = "codemem.notifications";

const noticeSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		message: { type: "string" },
		variant: { enum: ["info", "success", "warning", "error"] },
	},
	required: ["id", "message", "variant"],
	additionalProperties: false,
};

export const CodememNotifications = {
	id: CODEMEM_NOTIFICATION_RPC_ID,
	methods: {
		drain: {
			input: { type: "object", additionalProperties: false },
			output: {
				type: "object",
				properties: {
					notices: { type: "array", items: noticeSchema },
				},
				required: ["notices"],
				additionalProperties: false,
			},
		},
	},
	events: {
		notice: { schema: noticeSchema },
	},
};
