-- Quizzes. A quiz is a kind of assignment (kind = 'quiz'), so it sits in
-- units, the gradebook, the calendar, grade passback and standards alignment
-- like any other. Its questions and settings live in assignments.quiz
-- (shape in src/lib/quiz.ts, QTI 3.0-shaped so QTI import and export need no
-- migration), saved and versioned with the rest of the assignment.

ALTER TABLE assignments DROP CONSTRAINT assignments_kind_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_kind_check CHECK (kind IN ('online', 'offline', 'quiz'));
ALTER TABLE assignments ADD COLUMN quiz jsonb;

-- One student's go at a quiz. Answers autosave (version-checked, like
-- submissions). The time limit is the server's: deadline_at is fixed when
-- the attempt starts (with the student's extra time), and nothing saved after
-- it (plus a short grace for the network) is kept; an attempt left open past
-- it is handed in with what was saved.
CREATE TABLE quiz_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  assignment_id  uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id     text NOT NULL,
  number         integer NOT NULL,
  -- The assignment version the attempt started on.
  quiz_version   integer NOT NULL,
  -- Question order and choice order shown to this student (shuffles).
  layout         jsonb NOT NULL,
  responses      jsonb NOT NULL DEFAULT '{}',
  -- Per question: {score, by: 'auto' | teacher id}. A teacher's score is
  -- kept through a regrade; automatic ones are worked out again.
  scores         jsonb NOT NULL DEFAULT '{}',
  score          numeric(9,2),
  -- Questions still waiting for a teacher (essays, short answers with no key).
  pending        integer NOT NULL DEFAULT 0,
  version        integer NOT NULL DEFAULT 1,
  started_at     timestamptz NOT NULL DEFAULT now(),
  deadline_at    timestamptz,
  submitted_at   timestamptz,
  auto_submitted boolean NOT NULL DEFAULT false,
  UNIQUE (assignment_id, student_id, number)
);
CREATE INDEX quiz_attempts_assignment ON quiz_attempts (tenant_id, assignment_id, student_id);
-- At most one open attempt per student per quiz.
CREATE UNIQUE INDEX quiz_attempts_open ON quiz_attempts (assignment_id, student_id) WHERE submitted_at IS NULL;

-- Facts about how an attempt went, shown to the teacher like the writing
-- evidence: when the student left the quiz page and came back, pastes into
-- essay answers, and snapshots of essay answers. Never a score or a verdict.
CREATE TABLE quiz_events (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  attempt_id  uuid NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  item_id     text,
  kind        text NOT NULL CHECK (kind IN ('left', 'back', 'paste', 'snapshot')),
  at          timestamptz NOT NULL DEFAULT now(),
  body        text NOT NULL DEFAULT '',
  chars       integer NOT NULL DEFAULT 0
);
CREATE INDEX quiz_events_attempt ON quiz_events (tenant_id, attempt_id, at);

-- A student's quiz accommodations in one course (an IEP or 504 plan): more
-- time (the limit times time_factor) and extra attempts on every quiz.
CREATE TABLE quiz_accommodations (
  tenant_id      text NOT NULL,
  course_id      uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id     text NOT NULL,
  time_factor    numeric(4,2) NOT NULL DEFAULT 1 CHECK (time_factor >= 1 AND time_factor <= 4),
  extra_attempts integer NOT NULL DEFAULT 0 CHECK (extra_attempts >= 0 AND extra_attempts <= 10),
  updated_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, student_id)
);
CREATE INDEX quiz_accommodations_tenant ON quiz_accommodations (tenant_id, course_id);
