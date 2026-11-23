-- The grading review screen, part 2 (teacher story 01, grade assistant).
--
-- integrity_concerns: the teacher's own record of a possible shared-work
-- or outside-source concern on an assignment, marked High / Medium /
-- Note with written evidence. Never a deduction and never a grade: no
-- grade, gradebook, student, parent or preview path reads it.
--
-- grade_suggestions: a suggested score / message / note for one part of
-- a sections-and-parts rubric (part_id) or the whole grade (part_id
-- null), stored APART from grades with what made it (source, version,
-- detail). Only the teacher's save of the grade after using it turns it
-- into a grade (through the normal grade path); its status then says
-- whether it was accepted as suggested or changed. Today only non-AI
-- helpers fill it ("same as another student's"); an AI fills it later.

CREATE TABLE integrity_concerns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  level         text NOT NULL CHECK (level IN ('high', 'medium', 'note')),
  student_ids   jsonb NOT NULL,
  section_id    text,
  evidence      text NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integrity_concerns_assignment ON integrity_concerns (tenant_id, assignment_id);

CREATE TABLE grade_suggestions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  assignment_id  uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id     text NOT NULL,
  part_id        text,
  score          numeric,
  message        text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  source         text NOT NULL,
  source_version text NOT NULL DEFAULT '1',
  source_detail  jsonb,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'changed', 'skipped')),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_by     text,
  decided_at     timestamptz
);
CREATE INDEX grade_suggestions_assignment ON grade_suggestions (tenant_id, assignment_id, student_id);
-- At most one open suggestion per part (or for the whole grade) per student.
CREATE UNIQUE INDEX grade_suggestions_one_open ON grade_suggestions (assignment_id, student_id, coalesce(part_id, '')) WHERE status = 'open';
