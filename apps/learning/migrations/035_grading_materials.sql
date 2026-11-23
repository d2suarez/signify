-- Answer keys and grading materials (teacher story 01, step A11; the
-- grade assistant's "what the teacher sets up"). Teacher-only attachments
-- on an assignment: an uploaded file (course_files) or a link, with what
-- it is (the key, the reading, the teacher guide, anything else). Kept in
-- their own table so they are never part of an assignment as students,
-- parents, previews, Updates or copies get it; a file attached here is
-- opened by the class's teachers only (files.ts canOpen), wherever else it
-- is used.

CREATE TABLE grading_materials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'key' CHECK (role IN ('key', 'reading', 'guide', 'other')),
  title         text NOT NULL DEFAULT '',
  file_id       uuid REFERENCES course_files(id) ON DELETE CASCADE,
  url           text,
  position      integer NOT NULL DEFAULT 0,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((file_id IS NULL) <> (url IS NULL))
);
CREATE INDEX grading_materials_assignment ON grading_materials (tenant_id, assignment_id);
CREATE INDEX grading_materials_file ON grading_materials (tenant_id, file_id);
