-- "Present this day" (teacher story 01, step B3): a planner day's lessons
-- and picked materials become one lesson (the slides), presented live with
-- the one presenter. This remembers which lesson is a day's presentation, so
-- pressing it again opens the same one (with its poll answers and edits)
-- until the teacher asks to make it again. The lesson itself stays
-- unscheduled; the planner shows it on its day.

CREATE TABLE plan_days (
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  day         date NOT NULL,
  lesson_id   uuid REFERENCES lessons(id) ON DELETE SET NULL,
  made_by     text NOT NULL,
  made_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, day)
);
