-- Nested grading periods (Desmond, 2026-11-23: "1st semester can contain
-- 1st and 2nd quarter"). The school's admins nest periods: a year holds
-- semesters, a semester quarters (periods.ts, up to 4 levels). Every
-- existing period stays exactly as it was, at the top level, until an
-- admin moves it inside another. A parent's grade comes from its own date
-- range, so nothing about a quarter's grade or FACTS file changes.
-- Deleting a period moves what it holds up a level first (grades.ts);
-- ON DELETE SET NULL is only the safety net.

ALTER TABLE grading_periods ADD COLUMN parent_id uuid REFERENCES grading_periods(id) ON DELETE SET NULL;
CREATE INDEX grading_periods_parent ON grading_periods (tenant_id, parent_id);
