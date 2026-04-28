CREATE TYPE "public"."mcp_server_image_update_status" AS ENUM('unknown', 'up_to_date', 'update_available', 'restart_triggered');--> statement-breakpoint
CREATE TABLE "mcp_server_image_update_state" (
	"mcp_server_id" uuid PRIMARY KEY NOT NULL,
	"last_checked_at" timestamp,
	"running_image_digest" text,
	"available_image_digest" text,
	"status" "mcp_server_image_update_status" DEFAULT 'unknown' NOT NULL,
	"last_restarted_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "image_update_check_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "image_update_auto_restart_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ALTER COLUMN "image_update_check_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "mcp_server" ALTER COLUMN "image_update_auto_restart_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "mcp_server_image_update_state" ADD CONSTRAINT "mcp_server_image_update_state_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;
