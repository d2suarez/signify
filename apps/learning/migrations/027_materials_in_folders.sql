-- Any material in a folder (teacher story 01, step A13): a class resource
-- (link, video, Google Slides/Docs, file, text, Board, Desk tool…) can sit in
-- a unit or folder beside lessons and assignments, in one shared order.
--
-- unit_id: the folder it is in; NULL = only in the Resources list.
-- unit_position: its place among the folder's lessons, assignments and
--   materials (organize.ts numbers them together); `position` stays its
--   place in the Resources list.
-- A resource keeps `visible` as "students can see it", in the folder too.

ALTER TABLE class_resources ADD COLUMN unit_id uuid REFERENCES units(id) ON DELETE SET NULL;
ALTER TABLE class_resources ADD COLUMN unit_position integer;
CREATE INDEX class_resources_unit ON class_resources (tenant_id, course_id, unit_id) WHERE unit_id IS NOT NULL;
