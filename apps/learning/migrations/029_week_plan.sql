-- The planner picks any material and shows standards (teacher story 01,
-- steps B1, B2).
--
-- plan_items: an assignment (quizzes are assignments) or a class resource
--   (a folder material: link, video, PDF, Slides…) placed on a class's day.
--   A pointer, never a copy (story 01 design rule 1: the folder tree is the
--   one home of every material). Lessons are still placed by their own
--   `planned_for`. A material can be on several days, once per day.
-- plan_day_standards: standards a teacher adds to a day by hand, beside the
--   ones the day's lessons and materials already measure.

CREATE TABLE plan_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  day         date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('assignment', 'resource')),
  ref_id      uuid NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, day, kind, ref_id)
);
CREATE INDEX plan_items_day ON plan_items (tenant_id, course_id, day);

CREATE TABLE plan_day_standards (
  tenant_id    text NOT NULL,
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  day          date NOT NULL,
  standard_id  uuid NOT NULL REFERENCES standards(id) ON DELETE CASCADE,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, day, standard_id)
);
