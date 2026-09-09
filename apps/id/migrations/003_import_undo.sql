-- ===================================================================
-- Undo for a roster import
--
-- The reason local admins wanted "restore" was almost always "I imported the
-- wrong file". That is a bounded, reviewable change set, unlike applying an
-- arbitrary uploaded backup — so it gets its own reversal, and restore moves
-- out of their hands entirely.
-- ===================================================================

-- Everything needed to put the roster back as it was: which accounts the run
-- created, and the prior values of everything it changed.
ALTER TABLE roster_imports ADD COLUMN undo_data jsonb;
ALTER TABLE roster_imports ADD COLUMN undone_at timestamptz;
ALTER TABLE roster_imports ADD COLUMN undone_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX roster_imports_undoable_idx
  ON roster_imports(tenant_id, created_at DESC)
  WHERE undone_at IS NULL AND undo_data IS NOT NULL;
