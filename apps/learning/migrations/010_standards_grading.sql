-- Standards-based grading, a per-course option.
--
-- A points course (the default) never reads anything added here: its grade
-- is worked out exactly as before (src/lib/grade-math.ts).

-- 'points' (by points or category weights, as before) or 'standards'.
ALTER TABLE courses ADD COLUMN grading text NOT NULL DEFAULT 'points' CHECK (grading IN ('points', 'standards'));
-- The proficiency scale's labels, how a standard's period summary is worked
-- out, and the conversion to a percent for FACTS (shape and defaults in
-- src/lib/standards-math.ts; null = the defaults).
ALTER TABLE courses ADD COLUMN standards_settings jsonb;

-- A course's standards. Archived, never deleted, once scores may point at
-- them. external_id is for CASE tagging later (a CASE item's identifier).
CREATE TABLE standards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  code         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  external_id  text,
  position     integer NOT NULL DEFAULT 0,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX standards_course ON standards (tenant_id, course_id, archived, position);

-- Which standards an assignment measures (a list of standard ids; a rubric
-- row can also name one, inside assignments.rubric). Kept in assignment
-- versions like the rest of the assignment.
ALTER TABLE assignments ADD COLUMN standards jsonb;

-- The level reached on each standard ({standardId: level}), next to the
-- score. Kept in the grade history too.
ALTER TABLE grades ADD COLUMN levels jsonb;
ALTER TABLE grade_history ADD COLUMN levels jsonb;
