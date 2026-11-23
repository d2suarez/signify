-- Folders inside folders (teacher story 01, 2026-11-22): a unit can sit
-- inside another unit of the same course ("Unit 3" > "Chapter 7").
--
-- parent_id: the folder this one sits in; NULL = a top-level unit.
--   `position` now orders a folder among its siblings (same parent).
--   Deleting a folder (src/lib/units.ts) first moves its folders, lessons and
--   assignments up into its parent, so nothing is ever lost; the FK's SET NULL
--   is only a safety net.

ALTER TABLE units ADD COLUMN parent_id uuid REFERENCES units(id) ON DELETE SET NULL;
CREATE INDEX units_parent ON units (tenant_id, course_id, parent_id, position);
