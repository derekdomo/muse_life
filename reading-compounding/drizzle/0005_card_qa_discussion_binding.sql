ALTER TABLE `knowledge_cards` ADD COLUMN `qa_question_request_id` text;
--> statement-breakpoint
ALTER TABLE `knowledge_cards` ADD COLUMN `qa_snippet_version` integer;
--> statement-breakpoint
ALTER TABLE `knowledge_cards` ADD COLUMN `qa_source_text` text;
--> statement-breakpoint
ALTER TABLE `knowledge_cards` ADD COLUMN `qa_source_label` text;
