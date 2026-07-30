ALTER TABLE `build_closure` ADD `nar_key` text;
--> statement-breakpoint
CREATE TABLE `gc_marks` (
	`nar_key` text PRIMARY KEY NOT NULL,
	`marked_at` integer NOT NULL,
	`narinfo_deleted_at` integer
);
--> statement-breakpoint
CREATE TRIGGER `reject_marked_closure_insert`
BEFORE INSERT ON `build_closure`
WHEN NEW.`nar_key` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `gc_marks` WHERE `nar_key` = NEW.`nar_key`
)
BEGIN
	SELECT RAISE(ABORT, 'NAR is pending GC');
END;
--> statement-breakpoint
CREATE TRIGGER `reject_marked_closure_update`
BEFORE UPDATE OF `nar_key` ON `build_closure`
WHEN NEW.`nar_key` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `gc_marks` WHERE `nar_key` = NEW.`nar_key`
)
BEGIN
	SELECT RAISE(ABORT, 'NAR is pending GC');
END;
--> statement-breakpoint
CREATE TRIGGER `reject_marked_build_pin`
BEFORE INSERT ON `pinned_builds`
WHEN EXISTS (
	SELECT 1 FROM `build_closure` bc
	JOIN `gc_marks` gm ON gm.`nar_key` = bc.`nar_key`
	WHERE bc.`build_id` = NEW.`build_id`
)
BEGIN
	SELECT RAISE(ABORT, 'build is pending GC');
END;
--> statement-breakpoint
CREATE TRIGGER `reject_marked_rollback_root`
BEFORE INSERT ON `rollback_roots`
WHEN EXISTS (
	SELECT 1 FROM `build_closure` bc
	JOIN `gc_marks` gm ON gm.`nar_key` = bc.`nar_key`
	WHERE bc.`build_id` = NEW.`build_id`
)
BEGIN
	SELECT RAISE(ABORT, 'build is pending GC');
END;
--> statement-breakpoint
CREATE TRIGGER `reject_marked_build_finalize`
BEFORE UPDATE OF `status` ON `builds`
WHEN NEW.`status` = 'published' AND EXISTS (
	SELECT 1 FROM `build_closure` bc
	JOIN `gc_marks` gm ON gm.`nar_key` = bc.`nar_key`
	WHERE bc.`build_id` = NEW.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'build is pending GC');
END;
--> statement-breakpoint
CREATE TRIGGER `reject_marked_build_heartbeat`
BEFORE UPDATE OF `created_at` ON `builds`
WHEN EXISTS (
	SELECT 1 FROM `build_closure` bc
	JOIN `gc_marks` gm ON gm.`nar_key` = bc.`nar_key`
	WHERE bc.`build_id` = NEW.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'build is pending GC');
END;
