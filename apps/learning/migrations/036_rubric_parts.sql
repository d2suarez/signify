-- Sections-and-parts rubric (teacher story 01, grade assistant): a grade
-- keeps each part's score and the message to the student about it
-- (`parts`, shown to the student once grades are released), and the
-- teacher's own note per part (`part_notes`, never sent to students or
-- parents). The rubric itself lives in assignments.rubric as
-- { kind: "parts", criteria: [], sections: [...] }.

ALTER TABLE grades ADD COLUMN parts jsonb;
ALTER TABLE grades ADD COLUMN part_notes jsonb;
ALTER TABLE grade_history ADD COLUMN parts jsonb;
ALTER TABLE grade_history ADD COLUMN part_notes jsonb;
