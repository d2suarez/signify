-- Organizing a course's material (src/lib/organize.ts).
--
-- position: a lesson's or assignment's place inside its unit. Lessons and
--   assignments share one order per unit; NULL = never placed by hand, sorted
--   after the placed ones by date as before.
-- student_view (lessons): 'hidden' = teachers only (every lesson so far),
--   'list' = students see it in the unit list and open it with a click,
--   'thread' = also shown in the class's Updates.
-- thread_post_id: the update that shows this item in the class's Updates
--   (lessons, and published assignments), so turning it off removes it.
-- import_id: the Common Cartridge import that made it, so an import can be
--   undone as a whole. Earlier imports are matched by their transaction
--   time: everything one import wrote has the same created_at as its record.

ALTER TABLE lessons ADD COLUMN position integer;
ALTER TABLE lessons ADD COLUMN student_view text NOT NULL DEFAULT 'hidden'
  CHECK (student_view IN ('hidden', 'list', 'thread'));
ALTER TABLE lessons ADD COLUMN thread_post_id uuid;
ALTER TABLE lessons ADD COLUMN import_id uuid;

ALTER TABLE assignments ADD COLUMN position integer;
ALTER TABLE assignments ADD COLUMN thread_post_id uuid;
ALTER TABLE assignments ADD COLUMN import_id uuid;

ALTER TABLE units ADD COLUMN import_id uuid;

ALTER TABLE course_imports ADD COLUMN undone_at timestamptz;

UPDATE lessons l SET import_id = i.id FROM course_imports i
 WHERE l.tenant_id = i.tenant_id AND l.course_id = i.course_id AND l.created_at = i.created_at;
UPDATE assignments a SET import_id = i.id FROM course_imports i
 WHERE a.tenant_id = i.tenant_id AND a.course_id = i.course_id AND a.created_at = i.created_at;
UPDATE units u SET import_id = i.id FROM course_imports i
 WHERE u.tenant_id = i.tenant_id AND u.course_id = i.course_id AND u.created_at = i.created_at;

CREATE INDEX lessons_import ON lessons (tenant_id, import_id) WHERE import_id IS NOT NULL;
CREATE INDEX assignments_import ON assignments (tenant_id, import_id) WHERE import_id IS NOT NULL;
