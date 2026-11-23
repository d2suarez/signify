-- Lock an assignment (Desmond, 2026-11-23: "a way for the teacher to lock
-- assignments to not accept any more submissions. This can be a future
-- date or right now"). closes_at = the moment it stops accepting work
-- (now, or a chosen school-time moment); NULL = open. Not part of the
-- assignment's versions: locking never conflicts with an editor that's open.
-- From then on no hand-ins, take-backs, saves, file hand-ins or new quiz
-- attempts (assignments.ts isClosed, checked in every write); open quiz
-- attempts are handed in with what was saved. Grading is untouched.

ALTER TABLE assignments ADD COLUMN closes_at timestamptz;
