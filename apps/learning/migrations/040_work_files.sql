-- Student file hand-in (teacher story 01, A7). An online assignment says
-- what students hand in: 'text' (the writing box, as before), 'files'
-- (photos, PDFs, Word/PowerPoint/Excel) or 'both'.
--
-- work_files: a student's (or, in a group's "one hands in" mode, a group's)
-- files on one assignment, in their order. `owner` is 's:<student id>' or
-- 'g:<group id>'. The bytes are sealed in the file store like teacher
-- files (files.ts), under work/<tenant>/<id>. Removing a file only marks
-- it: a hand-in may still point at it.
--
-- submissions.files: the list handed in (ids, names, kinds, sizes in
-- order), set at every hand-in; work_file_hand_ins keeps every hand-in's
-- list, so taking work back and handing in again never loses what was
-- handed in before.

ALTER TABLE assignments ADD COLUMN hand_in text NOT NULL DEFAULT 'text' CHECK (hand_in IN ('text', 'files', 'both'));

CREATE TABLE work_files (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  owner         text NOT NULL,
  position      integer NOT NULL DEFAULT 0,
  name          text NOT NULL,
  content_type  text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'pdf', 'audio', 'video', 'doc')),
  size          integer NOT NULL,
  sha256        text NOT NULL,
  storage_key   text NOT NULL,
  uploaded_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);
CREATE INDEX work_files_owner ON work_files (tenant_id, assignment_id, owner);

ALTER TABLE submissions ADD COLUMN files jsonb;

CREATE TABLE work_file_hand_ins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  files         jsonb NOT NULL,
  handed_in_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_file_hand_ins_sub ON work_file_hand_ins (submission_id);
