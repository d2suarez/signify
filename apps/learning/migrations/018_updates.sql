-- Updates: posts to a class or club (a `courses` row) or to the whole school
-- (course_id null), comments on them, and who has read what.
--
-- Teachers post in their classes and clubs; students post there too unless
-- the class's teachers turn it off; staff post to the whole school when the
-- school's Signify ID "Tools by role" allows (feature `post_school_updates`).
-- Parents read their children's class posts and school posts, never
-- comments. Moderation hides (reversible) or deletes (kept, shown to no one).
--
-- People are named by Signify id. `author_name` is the author's own display
-- name when they posted, so a post reads "from" someone everywhere it is
-- shown, including to people Learning can't ask Signify ID about.

CREATE TABLE posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  course_id      uuid REFERENCES courses(id) ON DELETE CASCADE,
  title          text NOT NULL DEFAULT '',
  body           text NOT NULL,
  author_id      text NOT NULL,
  author_name    text NOT NULL DEFAULT '',
  -- 'staff' (teacher, admin, office) or 'student', as they posted.
  author_kind    text NOT NULL DEFAULT 'staff' CHECK (author_kind IN ('staff', 'student')),
  status         text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'deleted')),
  moderated_by   text,
  moderated_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The post or its newest comment: what "unread" compares against.
  activity_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_course ON posts (tenant_id, course_id, status, created_at DESC);
CREATE INDEX posts_school ON posts (tenant_id, created_at DESC) WHERE course_id IS NULL;

CREATE TABLE post_comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  body           text NOT NULL,
  author_id      text NOT NULL,
  author_name    text NOT NULL DEFAULT '',
  author_kind    text NOT NULL DEFAULT 'staff' CHECK (author_kind IN ('staff', 'student')),
  status         text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'deleted')),
  moderated_by   text,
  moderated_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_comments_post ON post_comments (tenant_id, post_id, created_at);

-- When each person last opened a post's thread.
CREATE TABLE post_reads (
  tenant_id  text NOT NULL,
  user_id    text NOT NULL,
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_reads_user ON post_reads (tenant_id, user_id);

-- A class's teachers can stop students posting, and separately commenting.
ALTER TABLE courses ADD COLUMN student_posts boolean NOT NULL DEFAULT true;
ALTER TABLE courses ADD COLUMN student_comments boolean NOT NULL DEFAULT true;

-- Every announcement (migration 005) becomes a teacher's post with the same
-- id, date and words; taken-down ones become deleted posts (kept, unseen).
INSERT INTO posts (id, tenant_id, course_id, title, body, author_id, author_kind, status, created_at, activity_at)
  SELECT id, tenant_id, course_id, title, body, created_by, 'staff',
         CASE WHEN archived THEN 'deleted' ELSE 'visible' END, created_at, created_at
    FROM announcements;
-- Kept under a new name for the record, untouched; nothing reads it now.
ALTER TABLE announcements RENAME TO announcements_pre_018;
