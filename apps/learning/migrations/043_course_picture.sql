-- A class's picture (Desmond's class-page feedback, 2026-11-23): the
-- teacher uploads one picture per class (a section), shown to the left of
-- the class name in the class header on every page inside the class. It is
-- one of the class's own files (course_files, files.ts), a picture by its
-- bytes; anyone in the class may open it (files.ts canOpen). NULL = none:
-- the header shows the class's first letter on a coloured tile.

ALTER TABLE courses ADD COLUMN picture_file_id uuid;
