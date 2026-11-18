-- Files teachers upload to a course: class resources and lesson "file"
-- blocks point at them by id. The bytes are NOT here: they are encrypted
-- (AES-256-GCM, a key derived from BACKUP_ENCRYPTION_KEY, bound to the
-- object's name) and kept in the R2 bucket under files/<tenant>/<id>, or in
-- data/files locally. `content_type` is what the bytes were checked to be
-- (src/lib/files.ts sniffFile), never what the browser said. Never deleted:
-- a copied lesson in another section may still point here.

CREATE TABLE course_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name          text NOT NULL,
  content_type  text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'pdf', 'audio', 'video', 'doc')),
  size          integer NOT NULL,
  sha256        text NOT NULL,
  storage_key   text NOT NULL,
  uploaded_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_files_course ON course_files (tenant_id, course_id);
