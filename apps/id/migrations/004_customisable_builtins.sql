-- ===================================================================
-- Super admins can edit the built-in roles
--
-- The built-ins are defined in code and re-applied at every boot, which is
-- how a newly added app's permissions reach every school's teachers without
-- anyone having to remember. That same mechanism would silently undo an edit
-- on the next deploy.
--
-- So an edited built-in is marked, and the boot-time sync leaves it alone.
-- The trade is deliberate and visible in the console: a customised role stops
-- receiving new permissions automatically, and can be reset to its default.
-- ===================================================================

ALTER TABLE roles ADD COLUMN customised boolean NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN customised_at timestamptz;
ALTER TABLE roles ADD COLUMN customised_by uuid REFERENCES users(id) ON DELETE SET NULL;
