-- Group assignments (teacher story 01, steps A10 and F4; Drive copies per
-- group wait for Google Drive). An assignment may use one of its class's
-- saved group sets (033).
--   group_hand_in: 'each' = every member hands in, 'one' = one member hands
--     in for the whole group.
--   group_submitter: with 'one', who that member is: chosen by the group
--     ('group': any member takes it on) or set by the teacher ('teacher').
-- group_work: an online assignment's ONE shared text per group, with its
--   own version (two members' saves never overwrite each other), who hands
--   it in, and when it was handed in ('one' mode). Each member's hand-in is
--   still their own row in submissions (body = the group's text at that
--   moment), so late marks, the gradebook and the writing record keep
--   working per student.

ALTER TABLE assignments ADD COLUMN group_set_id uuid REFERENCES group_sets(id);
ALTER TABLE assignments ADD COLUMN group_hand_in text NOT NULL DEFAULT 'each' CHECK (group_hand_in IN ('each', 'one'));
ALTER TABLE assignments ADD COLUMN group_submitter text NOT NULL DEFAULT 'group' CHECK (group_submitter IN ('group', 'teacher'));

CREATE TABLE group_work (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  group_id      text NOT NULL,
  body          text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 0,
  submitter     text,
  submitter_by  text CHECK (submitter_by IN ('group', 'teacher')),
  submitted_at  timestamptz,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, group_id)
);
CREATE INDEX group_work_assignment ON group_work (tenant_id, assignment_id);
