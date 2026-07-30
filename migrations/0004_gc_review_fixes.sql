ALTER TABLE `builds` ADD `restorable` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_build_closure_nar` ON `build_closure` (`nar_key`);
--> statement-breakpoint
CREATE TRIGGER `reject_non_staging_finalize`
BEFORE UPDATE OF `status` ON `builds`
WHEN NEW.`status` = 'published' AND OLD.`status` != 'staging'
BEGIN
	SELECT RAISE(ABORT, 'build is not staging');
END;
