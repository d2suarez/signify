-- Editing updates: only a post's author changes its words, and every earlier
-- version is kept here first, so an edit can't quietly erase what was said
-- (a moderator or school admin can still see the history in the database).
-- An update sent to several places is edited in all of them at once.

ALTER TABLE posts ADD COLUMN edited_at timestamptz;

CREATE TABLE post_edits (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL,
  doc         jsonb,
  file_ids    uuid[] NOT NULL DEFAULT '{}',
  edited_by   text NOT NULL,
  edited_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_edits_post ON post_edits (tenant_id, post_id, edited_at);
