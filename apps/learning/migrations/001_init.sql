-- Signify Learning: first schema.
--
-- Every row carries tenant_id, the school it belongs to, taken from the
-- signed-in person's Signify ID claims and never from a request body. One
-- database holds many schools; every query filters on it.
--
-- People are not stored here. Who someone is, which school they belong to and
-- which classes they are in all come from Signify ID, asked live. Rows here
-- name people only by their Signify id (a uuid), as authors and editors.

CREATE TABLE courses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  -- The Signify ID class this course teaches. One course per class.
  id_class_id  text NOT NULL,
  name         text NOT NULL,
  subject      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id_class_id)
);

CREATE TABLE lessons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title         text NOT NULL,
  planned_for   date,
  duration_min  integer NOT NULL DEFAULT 50,
  -- The lesson's blocks, in order. Shape and limits: src/lib/blocks.ts.
  blocks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Bumped on every save. A save names the version it was based on and is
  -- refused if someone else saved in between (two tabs, two devices).
  version       integer NOT NULL DEFAULT 1,
  archived      boolean NOT NULL DEFAULT false,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lessons_course ON lessons (tenant_id, course_id, archived);

-- Earlier versions of each lesson, so no save can lose work for good.
-- Written before every save that changes the lesson; the newest 50 are kept.
CREATE TABLE lesson_versions (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  lesson_id   uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  title       text NOT NULL,
  blocks      jsonb NOT NULL,
  saved_by    text NOT NULL,
  saved_at    timestamptz NOT NULL,
  UNIQUE (lesson_id, version)
);
