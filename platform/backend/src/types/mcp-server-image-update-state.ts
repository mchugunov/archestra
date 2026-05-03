import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const McpServerImageUpdateStatusSchema = z.enum([
  "unknown",
  "up_to_date",
  "update_available",
  "restart_triggered",
  "check_failed",
]);

const imageUpdateStateExtendedFields = {
  status: McpServerImageUpdateStatusSchema,
};

export const SelectMcpServerImageUpdateStateSchema = createSelectSchema(
  schema.mcpServerImageUpdateStatesTable,
  imageUpdateStateExtendedFields,
);

export const InsertMcpServerImageUpdateStateSchema = createInsertSchema(
  schema.mcpServerImageUpdateStatesTable,
  {
    status: McpServerImageUpdateStatusSchema.optional(),
  },
);

export const UpdateMcpServerImageUpdateStateSchema = createUpdateSchema(
  schema.mcpServerImageUpdateStatesTable,
  {
    status: McpServerImageUpdateStatusSchema.optional(),
  },
).omit({
  mcpServerId: true,
});

export type McpServerImageUpdateStatus = z.infer<
  typeof McpServerImageUpdateStatusSchema
>;

export type McpServerImageUpdateState = z.infer<
  typeof SelectMcpServerImageUpdateStateSchema
>;
export type InsertMcpServerImageUpdateState = z.infer<
  typeof InsertMcpServerImageUpdateStateSchema
>;
export type UpdateMcpServerImageUpdateState = z.infer<
  typeof UpdateMcpServerImageUpdateStateSchema
>;
