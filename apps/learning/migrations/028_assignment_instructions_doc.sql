-- Rich instructions on assignments (teacher story 01, step A12): the same
-- document Updates keep (post-doc.ts: formatting, pictures, files, YouTube/
-- Vimeo), stored beside the plain text.
--
-- instructions_doc: the document, or NULL for an assignment written before
--   this (or imported/copied as plain text): pages then show `instructions`
--   as they always did. When it is set, `instructions` holds its words
--   (docText), so read-aloud, search, Common Cartridge and copies that only
--   know text keep working.

ALTER TABLE assignments ADD COLUMN instructions_doc jsonb;
