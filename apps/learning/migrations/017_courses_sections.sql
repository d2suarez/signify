-- Courses that last, and the yearly classes that are their sections.
--
-- A `courses` row has always been one Signify ID class, and an ID class
-- belongs to one school year, so a `courses` row is really a SECTION: it
-- keeps its own roster (from ID), lessons, assignments, gradebook and
-- updates. The table keeps its old name so that nothing pointing at it
-- moves. This migration adds the course above it, one that lasts from year
-- to year (`catalog_courses`, "Course" on screen).
--
-- Nothing is copied automatically (Desmond, 2026-11-17). A teacher copies
-- content from another class they teach or taught when they choose, and
-- asks another teacher's class to share its content (that class's teacher
-- or a school admin says yes).

CREATE TABLE catalog_courses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  subject     text NOT NULL DEFAULT '',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_courses_tenant ON catalog_courses (tenant_id, name);

-- Every existing class becomes the first section of a course of its own,
-- with the same name. No content row moves.
ALTER TABLE courses ADD COLUMN catalog_id uuid;
UPDATE courses SET catalog_id = gen_random_uuid();
INSERT INTO catalog_courses (id, tenant_id, name, subject, created_by, created_at)
  SELECT catalog_id, tenant_id, name, subject, 'migration-017', created_at FROM courses;
ALTER TABLE courses ADD CONSTRAINT courses_catalog_fk FOREIGN KEY (catalog_id) REFERENCES catalog_courses(id);
CREATE INDEX courses_catalog ON courses (tenant_id, catalog_id);

-- The school year Signify ID gives the class ('2026', '2026-27'; '' = not said).
ALTER TABLE courses ADD COLUMN school_year text NOT NULL DEFAULT '';

-- Staff Signify ID has listed as teaching a section, kept after the class is
-- archived in ID (ID then stops listing it), so a teacher can still copy
-- their own old content. Only this: it never opens a past class's students,
-- work or grades, which still need ID to list the class.
CREATE TABLE section_teachers (
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, user_id)
);
CREATE INDEX section_teachers_user ON section_teachers (tenant_id, user_id);

-- Classes the teachers of existing courses taught so far: the creators of
-- their lessons and assignments (the only staff ids already here).
INSERT INTO section_teachers (tenant_id, course_id, user_id)
  SELECT DISTINCT tenant_id, course_id, created_by FROM lessons
  UNION SELECT DISTINCT tenant_id, course_id, created_by FROM assignments
  ON CONFLICT DO NOTHING;

-- A teacher asks to copy from another teacher's class. Answered by one of
-- that class's teachers or a school admin; a yes lets the asker copy its
-- content (never students, work or grades) until it is taken back.
CREATE TABLE share_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  source_id       uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  requested_by    text NOT NULL,
  -- The asker's own display name when they asked, so whoever answers knows
  -- who is asking (Learning can't ask Signify ID about someone outside the
  -- answerer's classes). The one name kept here; it is the asker's own.
  requested_name  text NOT NULL DEFAULT '',
  -- The class the asker wants it for (shown to whoever answers).
  for_course_id   uuid REFERENCES courses(id) ON DELETE SET NULL,
  message         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn', 'revoked')),
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_requests_source ON share_requests (tenant_id, source_id, status);
CREATE INDEX share_requests_asker ON share_requests (tenant_id, requested_by, status);
-- One open or granted request per person per class.
CREATE UNIQUE INDEX share_requests_live ON share_requests (source_id, requested_by) WHERE status IN ('pending', 'approved');

-- Every copy, for the record: what came from where.
CREATE TABLE content_copies (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  from_course   uuid NOT NULL,
  to_course     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  copied_by     text NOT NULL,
  copied_at     timestamptz NOT NULL DEFAULT now(),
  counts        jsonb NOT NULL
);
