CREATE TABLE `pinned_builds` (
	`build_id` text PRIMARY KEY NOT NULL,
	`pinned_at` integer NOT NULL,
	`reason` text
);
