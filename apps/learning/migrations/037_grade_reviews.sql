-- The grading review screen (teacher story 01, grade assistant): a grade
-- counts as reviewed only once the teacher marks it ("Mark reviewed,
-- next"). Teacher-only: never part of a Grade, so students and parents
-- never see it.

CREATE TABLE grade_reviews (
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    text NOT NULL,
  reviewed_by   text NOT NULL,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, student_id)
);
CREATE INDEX grade_reviews_tenant ON grade_reviews (tenant_id, assignment_id);
