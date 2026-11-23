-- Standards on the course, inherited by its classes (Desmond, 2026-11-23:
-- "The standards are a mess"). Rules: src/lib/course-standards.ts.
--
-- A course (catalog_courses, the one that lasts from year to year) holds
-- sets of standards: a whole set, one part of it (a heading and everything
-- under it) and/or only some grades. Every class (section) of the course
-- has those standards as rows of `standards` marked from_course, kept in
-- step whenever the course's sets change or a class joins the course. A
-- teacher can still add a standard to one class (from_course = false).
--
-- Nothing that exists moves: every existing course standard keeps its id
-- and stays a class standard (from_course = false), so alignments and
-- grades.levels are untouched.

CREATE TABLE course_standard_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  catalog_id    uuid NOT NULL REFERENCES catalog_courses(id) ON DELETE CASCADE,
  framework_id  uuid NOT NULL REFERENCES standard_frameworks(id) ON DELETE CASCADE,
  -- One part of the set: this heading and everything under it. Null = all of it.
  root_item_id  uuid REFERENCES standard_items(id) ON DELETE CASCADE,
  -- Only standards for these grades (CASE levels 'KG', '01' ...). Empty = every grade.
  grades        text[] NOT NULL DEFAULT '{}',
  position      integer NOT NULL DEFAULT 0,
  added_by      text NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_standard_sets_catalog ON course_standard_sets (tenant_id, catalog_id, position);

-- true = the class has this standard because its course does.
ALTER TABLE standards ADD COLUMN from_course boolean NOT NULL DEFAULT false;
CREATE INDEX standards_course_item ON standards (course_id, item_id);

-- May teachers choose their courses' sets? (A school admin always may.)
ALTER TABLE school_standards_settings ADD COLUMN teacher_course_sets boolean NOT NULL DEFAULT true;

-- A lesson presented live, by day (the presenter's End button), so the
-- coverage tracker can count what was taught even when it wasn't planned.
CREATE TABLE lesson_presentations (
  tenant_id     text NOT NULL,
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id     uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  day           date NOT NULL,
  presented_by  text NOT NULL,
  presented_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lesson_id, day)
);
CREATE INDEX lesson_presentations_course ON lesson_presentations (tenant_id, course_id, day);
