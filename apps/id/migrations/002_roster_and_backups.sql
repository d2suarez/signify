-- ===================================================================
-- Roster import, multi-year classes, per-person app access, backups
-- ===================================================================

-- ---------- a class can span several year groups ----------
-- A single grade_level was wrong: mixed-age classes, split years and
-- small-school combined classes are the norm, not the exception.

ALTER TABLE classes ADD COLUMN grade_levels text[] NOT NULL DEFAULT '{}';

UPDATE classes
   SET grade_levels = ARRAY[grade_level]
 WHERE grade_level IS NOT NULL AND btrim(grade_level) <> '';

ALTER TABLE classes DROP COLUMN grade_level;

CREATE INDEX classes_grade_levels_idx ON classes USING gin (grade_levels);

-- ---------- graduation year ----------
-- The stable way to describe a cohort. Year group changes every August and
-- has to be rewritten across the whole roster; graduation year never does,
-- so the year group can be derived from it instead of maintained by hand.

ALTER TABLE memberships ADD COLUMN graduation_year integer
  CHECK (graduation_year IS NULL OR (graduation_year BETWEEN 1900 AND 2200));

-- ---------- per-person app access ----------
-- Layered on top of app_tenants rather than replacing it: a school turns an
-- app on, and this table is the exception list for individual people. No row
-- means "whatever the school allows", so existing accounts are unaffected.

CREATE TABLE user_app_access (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id     uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  allowed    boolean NOT NULL DEFAULT true,
  set_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app_id)
);
CREATE INDEX user_app_access_tenant_idx ON user_app_access(tenant_id);

-- ---------- backup ledger ----------
-- A manual backup is downloaded and NOT kept here: a second copy of every
-- child's record sitting on the same disk is a liability, not a safeguard.
-- What is kept for those is the evidence that one was taken, by whom, and of
-- what, so the FERPA disclosure record stays complete after the file leaves.
--
-- The exception is the snapshot taken automatically just before a restore.
-- Restore is the one operation here that can destroy good data, so it gets a
-- real undo — held for 30 days and then purged by the maintenance sweep.

CREATE TABLE backups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('manual', 'pre_restore')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- sha256 of the payload, so a file handed back at restore time can be
  -- recognised as one this system actually produced.
  checksum    text NOT NULL,
  row_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,
  note        text NOT NULL DEFAULT '',
  -- Populated for 'pre_restore' only; always NULL for 'manual'.
  payload     jsonb,
  expires_at  timestamptz
);
CREATE INDEX backups_expiry_idx ON backups(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX backups_tenant_idx ON backups(tenant_id, created_at DESC);

-- ---------- roster imports ----------
-- One row per import run, so a bad CSV can be traced back to who ran it.

CREATE TABLE roster_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  filename    text NOT NULL DEFAULT '',
  row_count   integer NOT NULL DEFAULT 0,
  created_n   integer NOT NULL DEFAULT 0,
  updated_n   integer NOT NULL DEFAULT 0,
  skipped_n   integer NOT NULL DEFAULT 0,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX roster_imports_tenant_idx ON roster_imports(tenant_id, created_at DESC);
