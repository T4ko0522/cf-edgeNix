CREATE TABLE `build_closure` (
	`build_id` text NOT NULL,
	`store_hash` text NOT NULL,
	PRIMARY KEY(`build_id`, `store_hash`)
);
--> statement-breakpoint
CREATE INDEX `idx_build_closure_store` ON `build_closure` (`store_hash`);--> statement-breakpoint
CREATE TABLE `build_manifests` (
	`build_id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`system` text NOT NULL,
	`git_rev` text NOT NULL,
	`flake_lock_hash` text NOT NULL,
	`toplevel_store_path` text NOT NULL,
	`closure_json_key` text NOT NULL,
	`manifest_key` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_build_manifests_host` ON `build_manifests` (`host`,`created_at`);--> statement-breakpoint
CREATE TABLE `builds` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`system` text NOT NULL,
	`git_rev` text NOT NULL,
	`flake_lock_hash` text NOT NULL,
	`toplevel_store_path` text NOT NULL,
	`status` text DEFAULT 'staging' NOT NULL,
	`retention_class` text,
	`created_at` integer NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_builds_host_published` ON `builds` (`host`,`published_at`);--> statement-breakpoint
CREATE TABLE `nar_files` (
	`file_hash` text PRIMARY KEY NOT NULL,
	`nar_key` text NOT NULL,
	`file_size` integer NOT NULL,
	`compression` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rollback_roots` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`build_id` text NOT NULL,
	`reason` text,
	`pinned` integer DEFAULT 0 NOT NULL,
	`keep_until` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `store_paths` (
	`store_hash` text PRIMARY KEY NOT NULL,
	`store_path` text NOT NULL,
	`narinfo_key` text NOT NULL,
	`nar_key` text NOT NULL,
	`nar_hash` text NOT NULL,
	`nar_size` integer NOT NULL,
	`file_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`compression` text NOT NULL,
	`first_seen_build_id` text,
	`created_at` integer NOT NULL
);
