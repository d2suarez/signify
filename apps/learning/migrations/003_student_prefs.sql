-- Reading supports (UDL): each person's own choices for read-aloud, font,
-- text size, line spacing and contrast. Keyed by Signify id within the school;
-- nothing else about the person is kept. The shape lives in src/lib/prefs.ts
-- (normalizePrefs is the only way in), so adding a choice needs no migration.

CREATE TABLE student_prefs (
  tenant_id   text NOT NULL,
  user_id     text NOT NULL,
  prefs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
