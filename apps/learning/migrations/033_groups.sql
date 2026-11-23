-- Groups (teacher story 01, steps A8 and D8). A class's group sets: made
-- by hand or at random, saved under a name and reused. Each set's groups
-- are one jsonb list [{id, name, members: [{id, name}]}], members by
-- Signify id. A member's name is the display name Signify ID gave the
-- class's teacher when the set was last saved (students can't ask ID for
-- their classmates, and a group is no use if you can't see who is in it);
-- it is refreshed on every save and nothing else about a person is kept.
-- students_see: students see their own group (and only that) on the class
-- page; a lesson's group slide shows every group while it is live.

CREATE TABLE group_sets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name         text NOT NULL,
  groups       jsonb NOT NULL DEFAULT '[]'::jsonb,
  students_see boolean NOT NULL DEFAULT true,
  archived     boolean NOT NULL DEFAULT false,
  version      integer NOT NULL DEFAULT 1,
  created_by   text NOT NULL,
  updated_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_sets_course ON group_sets (tenant_id, course_id);
