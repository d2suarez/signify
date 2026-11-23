-- Slides stay open to students after class (teacher story 01, step E1).
-- When a teacher ends a live presentation, the lesson becomes visible to
-- the class ('list') unless the teacher chose what students see by hand,
-- or turned it off at the end. student_view_by_hand records that choice.
-- Lessons students can already see count as chosen.

ALTER TABLE lessons ADD COLUMN student_view_by_hand boolean NOT NULL DEFAULT false;
UPDATE lessons SET student_view_by_hand = true WHERE student_view <> 'hidden';
