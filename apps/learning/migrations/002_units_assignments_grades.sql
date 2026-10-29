-- Units, assignments, submissions and grades.
--
-- Same rules as 001: every row carries tenant_id; people are named only by
-- their Signify id. Students are never stored: who is in a course comes from
-- Signify ID, and a grade is only ever written for someone ID says is a
-- student in that class right now.

-- A unit groups a course's lessons and assignments, in the teacher's order.
CREATE TABLE units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX units_course ON units (tenant_id, course_id, position);

-- Deleting a unit never deletes what was in it: its lessons and assignments
-- fall back to "no unit".
ALTER TABLE lessons ADD COLUMN unit_id uuid REFERENCES units(id) ON DELETE SET NULL;

-- How the course grade is worked out: by total points, or by category
-- weights (Tests 40%, Quizzes 25%, ...).
ALTER TABLE courses ADD COLUMN weighted boolean NOT NULL DEFAULT false;

CREATE TABLE grade_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- A percentage; weights need not add up to 100 (they are scaled).
  weight      numeric(6,2) NOT NULL DEFAULT 0,
  position    integer NOT NULL DEFAULT 0
);
CREATE INDEX grade_categories_course ON grade_categories (tenant_id, course_id);

CREATE TABLE assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  course_id       uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  unit_id         uuid REFERENCES units(id) ON DELETE SET NULL,
  category_id     uuid REFERENCES grade_categories(id) ON DELETE SET NULL,
  title           text NOT NULL,
  instructions    text NOT NULL DEFAULT '',
  -- 'online': students write and hand it in here. 'offline': done on paper
  -- or in class; only graded here.
  kind            text NOT NULL DEFAULT 'online' CHECK (kind IN ('online', 'offline')),
  points          numeric(7,2) NOT NULL DEFAULT 10,
  -- due_on is the school day it is due (which quarter it counts in);
  -- due_at is the exact moment (late or not). The browser sends both, so
  -- the day is the teacher's day, not the server's.
  due_on          date,
  due_at          timestamptz,
  published       boolean NOT NULL DEFAULT false,
  grades_released boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1,
  archived        boolean NOT NULL DEFAULT false,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignments_course ON assignments (tenant_id, course_id, archived);

-- Earlier versions of each assignment, like lesson_versions.
CREATE TABLE assignment_versions (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  snapshot      jsonb NOT NULL,
  saved_by      text NOT NULL,
  saved_at      timestamptz NOT NULL,
  UNIQUE (assignment_id, version)
);

-- A student's work on an assignment: one row per student, saved as they
-- type (version-checked like lessons), handed in when submitted_at is set.
CREATE TABLE submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    text NOT NULL,
  body          text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 1,
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_id)
);
CREATE INDEX submissions_tenant ON submissions (tenant_id, assignment_id);

CREATE TABLE grades (
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    text NOT NULL,
  score         numeric(8,2),
  -- missing counts as zero; exempt leaves the assignment out; late is a mark
  -- only (no penalty yet).
  flag          text CHECK (flag IN ('missing', 'late', 'exempt')),
  comment       text NOT NULL DEFAULT '',
  graded_by     text NOT NULL,
  graded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, student_id)
);
CREATE INDEX grades_tenant ON grades (tenant_id, assignment_id);

-- Every change to a grade, oldest first. Grades are the record of a
-- student's year; none is ever changed without a trace.
CREATE TABLE grade_history (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    text NOT NULL,
  score         numeric(8,2),
  flag          text,
  comment       text NOT NULL DEFAULT '',
  changed_by    text NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grade_history_student ON grade_history (tenant_id, assignment_id, student_id);

-- The school's quarters (or semesters), set by its admins.
CREATE TABLE grading_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  CHECK (ends_on >= starts_on)
);
CREATE INDEX grading_periods_tenant ON grading_periods (tenant_id, starts_on);
