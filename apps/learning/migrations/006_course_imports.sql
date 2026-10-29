-- Course imports (Common Cartridge, e.g. a Schoology course export). Each
-- import is recorded with what it made, so a teacher can see where content
-- came from and is warned before bringing the same file in twice.
--
-- Quizzes and discussions can't be imported yet; their source (QTI XML for
-- quizzes, the topic text for discussions) is kept in import_sources so a
-- later quiz feature can turn them into real quizzes without a re-upload.

CREATE TABLE course_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  file_name   text NOT NULL DEFAULT '',
  -- sha256 of the uploaded file, to notice the same export coming in again.
  file_sha256 text NOT NULL,
  -- What the import made and skipped (counts and names), as shown to the teacher.
  summary     jsonb NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_imports_course ON course_imports (tenant_id, course_id, created_at DESC);

CREATE TABLE import_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  import_id   uuid NOT NULL REFERENCES course_imports(id) ON DELETE CASCADE,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('quiz', 'discussion')),
  title       text NOT NULL,
  unit_title  text,
  source      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_sources_course ON import_sources (tenant_id, course_id, kind);
