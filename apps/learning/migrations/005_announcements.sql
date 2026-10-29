-- Announcements: what a course's teachers post for the class, newest first
-- on the course page. Archived rather than deleted, like assignments.

CREATE TABLE announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  body        text NOT NULL,
  archived    boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_course ON announcements (tenant_id, course_id, archived, created_at DESC);
