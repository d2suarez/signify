-- ===================================================================
-- Erasure tombstones
--
-- The privacy policy promises that an erased person is never brought back,
-- "even if an older backup is later loaded". A whole-database backup taken
-- yesterday still holds somebody erased this morning; restoring it would
-- resurrect them.
--
-- So each permanent erasure also leaves a tombstone — the account's id and
-- nothing else — which is copied to the backup bucket beside the backups
-- themselves. A restore reads them back and erases those accounts again.
--
-- This table is the outbox: a row waits here until its tombstone is safely in
-- the bucket, so a failed upload is retried rather than forgotten. Rows go
-- once sent and older than the backups they protect against.
-- ===================================================================

CREATE TABLE erasure_tombstones (
  user_id    uuid PRIMARY KEY,
  erased_at  timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

CREATE INDEX erasure_tombstones_unsent_idx ON erasure_tombstones(erased_at) WHERE sent_at IS NULL;
