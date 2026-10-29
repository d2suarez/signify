-- Drop lowest and rubrics.
--
-- A category may leave out its n lowest grades (by percent) from the course
-- grade; at least one always counts (src/lib/grade-math.ts).
ALTER TABLE grade_categories ADD COLUMN drop_lowest integer NOT NULL DEFAULT 0 CHECK (drop_lowest BETWEEN 0 AND 10);

-- An assignment's rubric: criteria, each with levels worth points (shape and
-- limits in src/lib/rubric.ts). Kept in assignment versions like the rest of
-- the assignment. Null = no rubric.
ALTER TABLE assignments ADD COLUMN rubric jsonb;

-- Which level the teacher chose for each criterion ({criterionId: levelId}),
-- alongside the score it adds up to. Kept in the grade history too.
ALTER TABLE grades ADD COLUMN rubric jsonb;
ALTER TABLE grade_history ADD COLUMN rubric jsonb;
