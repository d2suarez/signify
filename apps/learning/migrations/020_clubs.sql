-- Clubs and organizations: a Signify ID class (the roster: its teachers are
-- the sponsors, its students the members) that a sponsor marks as a club in
-- Learning. Like a class with no academics: updates, plans, resources and
-- events; no assignments, grades, standards, FACTS file or grading settings.
-- Switching back to a class hides nothing that was there before.
ALTER TABLE courses ADD COLUMN kind text NOT NULL DEFAULT 'class' CHECK (kind IN ('class', 'club'));

-- A club's meetings and other dates, newest-first on the club page and on
-- its calendar. Archived, never deleted.
CREATE TABLE club_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       text NOT NULL,
  -- The day and, when given, the start time ('15:30'), both the school's wall clock.
  on_day      date NOT NULL,
  start_time  text NOT NULL DEFAULT '',
  place       text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  archived    boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX club_events_course ON club_events (tenant_id, course_id, archived, on_day);
