-- Attendance (teacher story 01, step D6; Desmond 2026-11-22: "Learning gets
-- its own attendance system, which the school can then connect to FACTS or
-- another SIS"). One row per student per class per school day: present,
-- absent, tardy or excused, with an optional note. It is a school record:
-- school admins see every class's day and export it (CSV) for their SIS.
-- Students are by Signify id; student_name is the display name Signify ID
-- gave the teacher when they took attendance (like group_sets, migration
-- 033), so the school's record and export can name people without asking
-- ID for every class. Nothing else about a person is kept.

CREATE TABLE attendance (
  tenant_id    text NOT NULL,
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  day          date NOT NULL,
  student_id   text NOT NULL,
  student_name text NOT NULL DEFAULT '',
  status       text NOT NULL CHECK (status IN ('present', 'absent', 'tardy', 'excused')),
  note         text NOT NULL DEFAULT '',
  marked_by    text NOT NULL,
  marked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, day, student_id)
);
CREATE INDEX attendance_school_day ON attendance (tenant_id, day);
