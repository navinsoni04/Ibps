CREATE TABLE "motivation_items" (
	"id" uuid PRIMARY KEY,
	"owner_id" text NOT NULL,
	"category" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"media_type" text,
	"byte_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "motivation_items_owner_created_idx" ON "motivation_items" ("owner_id","created_at");