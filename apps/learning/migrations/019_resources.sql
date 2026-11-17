-- Class resources: a teacher's library for one course (one Signify ID class,
-- i.e. one section; clubs are courses too). Each resource is ONE block, in
-- exactly the shape lessons hold (blocks.ts, kept through normalizeBlocks),
-- or a pointer to one of the course's lessons. Adding a resource to a lesson
-- copies its block(s) in with new ids; the resource itself never changes.
-- Students see a resource only when `visible` (text, link and board only).
-- Archived rather than deleted.

CREATE TABLE class_resources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('block', 'lesson')),
  title       text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  block       jsonb,
  lesson_id   uuid REFERENCES lessons(id) ON DELETE CASCADE,
  visible     boolean NOT NULL DEFAULT false,
  position    integer NOT NULL DEFAULT 0,
  archived    boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL,
  updated_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'block' AND block IS NOT NULL AND lesson_id IS NULL)
      OR (kind = 'lesson' AND lesson_id IS NOT NULL AND block IS NULL))
);
CREATE INDEX class_resources_course ON class_resources (tenant_id, course_id, archived, position);
