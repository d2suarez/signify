-- The principal's weekly plans (teacher story 01, step B4) list each
-- teacher by name. Learning names people by Signify id; like an update's
-- author_name (018), this keeps the teacher's OWN display name as Signify
-- ID gave it to them when they last opened Learning, beside the sections
-- they teach. Nothing else is stored; a teacher not seen since shows as
-- "A teacher".

ALTER TABLE section_teachers ADD COLUMN name text NOT NULL DEFAULT '';
