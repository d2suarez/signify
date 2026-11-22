-- Rich updates: a post may carry a formatted document (src/lib/post-doc.ts:
-- paragraphs, headings, lists, quotes, links, pictures and files uploaded
-- here, YouTube/Vimeo videos, and links to the class's own assignments,
-- lessons and resources). `body` stays the plain-text version (This week,
-- the parent view, announcements and older code read it).
--
-- One update can go to several classes, clubs and the whole school at once:
-- it is stored as one post per place (so each class keeps its own comments,
-- moderation and readers), tied together by `group_id`.
--
-- `file_ids` lists the uploaded files the document shows, so /files/<id>
-- can let the post's readers open them (files.ts canOpen).

ALTER TABLE posts ADD COLUMN doc jsonb;
ALTER TABLE posts ADD COLUMN group_id uuid;
ALTER TABLE posts ADD COLUMN file_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX posts_group ON posts (tenant_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX posts_files ON posts USING gin (file_ids);

-- A picture for a whole-school update belongs to no class.
ALTER TABLE course_files ALTER COLUMN course_id DROP NOT NULL;
