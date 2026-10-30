-- ===================================================================
-- Official names and display names
--
-- A person now has two names. The OFFICIAL one is the school's record (in
-- Richmond's case whatever FACTS holds): first, middle, last and suffix,
-- entered by a school admin or uploaded from a CSV the office exported. It
-- is what grade lists in last-name order are built from. Signify never
-- connects to FACTS; a person brings the file.
--
-- The DISPLAY name is what apps show. Until a school or the person sets it,
-- it follows the Google profile on every sign-in, exactly as before. Once
-- the school sets it ('school'), or the person does where their school
-- allows it ('self'), sign-in leaves it alone.
--
-- given_name / family_name stay as they were (what Google last said), so
-- nothing that already reads them changes meaning.
--
-- Every change to either name is kept in name_changes.
-- ===================================================================

ALTER TABLE users ADD COLUMN official_given_name  text;
ALTER TABLE users ADD COLUMN official_middle_name text;
ALTER TABLE users ADD COLUMN official_family_name text;
ALTER TABLE users ADD COLUMN official_suffix      text;
ALTER TABLE users ADD COLUMN official_name_source text
  CHECK (official_name_source IN ('admin', 'import'));
ALTER TABLE users ADD COLUMN official_name_at     timestamptz;
ALTER TABLE users ADD COLUMN display_name_source  text NOT NULL DEFAULT 'google'
  CHECK (display_name_source IN ('google', 'school', 'self'));

CREATE TABLE name_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('official', 'display')),
  -- {given, middle, family, suffix} for official; {name, source} for display.
  before      jsonb,
  after       jsonb,
  source      text NOT NULL CHECK (source IN ('admin', 'import', 'self', 'reset')),
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX name_changes_user_idx ON name_changes(user_id, created_at DESC);
CREATE INDEX name_changes_tenant_idx ON name_changes(tenant_id, created_at DESC);
