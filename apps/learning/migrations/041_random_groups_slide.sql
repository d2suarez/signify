-- The group randomizer as a slide (teacher story 01, D4). A "Random groups"
-- slide deals the class into groups while the lesson is live. What it makes
-- is an ordinary group set of the class (design rule 4: the same groups the
-- presenter shows, the Groups tab lists and group assignments use), linked
-- back to the slide that made it: lesson_id + block_id. Shuffling again
-- saves the same set again (a new version), so the slide always shows the
-- latest deal and reading the lesson later shows a student their own group.
-- A set made by hand has neither.

ALTER TABLE group_sets ADD COLUMN lesson_id uuid;
ALTER TABLE group_sets ADD COLUMN block_id text;
CREATE INDEX group_sets_slide ON group_sets (tenant_id, lesson_id) WHERE lesson_id IS NOT NULL;
