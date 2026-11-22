-- Desk tools in the left rail, under To do. Each person's own list per
-- context ('home' or a class's course id), the students' defaults a class's
-- teacher chose (inside the school's policy, which lives in school_settings
-- under the key 'widgets', versioned like the grading settings), and a
-- seating chart per class. People are never stored: a chart holds Signify
-- ids only, and names come from Signify ID, live.

CREATE TABLE widget_layouts (
  tenant_id   text NOT NULL,
  user_id     text NOT NULL,
  context     text NOT NULL,
  widgets     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, context)
);

ALTER TABLE courses ADD COLUMN student_widgets jsonb;

CREATE TABLE seating_charts (
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  layout      jsonb NOT NULL,
  version     int NOT NULL DEFAULT 1,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, course_id)
);

-- The school's Desk tools setting sits beside its scales and late policies.
ALTER TABLE school_settings DROP CONSTRAINT school_settings_key_check;
ALTER TABLE school_settings ADD CONSTRAINT school_settings_key_check CHECK (key IN ('scales', 'late', 'widgets'));
