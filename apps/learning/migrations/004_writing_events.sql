-- Writing-process evidence: how a student's online work came to be. Timed
-- snapshots of the text (taken with autosave, at most one every 15 s, and
-- one at hand-in) and paste events (when, how much, what). Shown to the
-- teacher as a replay on the grading screen: evidence to talk about with the
-- student, never a verdict or a score. Shape and limits: src/lib/writing.ts.

CREATE TABLE writing_events (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL,
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('snapshot', 'paste')),
  at             timestamptz NOT NULL DEFAULT now(),
  -- snapshot: the whole text then; paste: what was pasted (capped).
  body           text NOT NULL DEFAULT '',
  -- snapshot: length of the text; paste: characters pasted (uncapped count).
  chars          integer NOT NULL DEFAULT 0
);
CREATE INDEX writing_events_submission ON writing_events (tenant_id, submission_id, at);
