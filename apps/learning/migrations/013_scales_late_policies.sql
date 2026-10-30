-- School grade scales and late-work policies.
--
-- A school's settings are kept whole, one row per kind ('scales' = letter
-- scales per grade band, src/lib/grade-scale.ts; 'late' = late policies,
-- src/lib/late-policy.ts). No row = the defaults in those files. Every save
-- names the version it started from and copies the previous value into the
-- history first.
CREATE TABLE school_settings (
  tenant_id   text NOT NULL,
  key         text NOT NULL CHECK (key IN ('scales', 'late')),
  value       jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE school_setting_versions (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  key         text NOT NULL,
  version     integer NOT NULL,
  value       jsonb NOT NULL,
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX school_setting_versions_key ON school_setting_versions (tenant_id, key, id DESC);

-- The class's grade levels as Signify ID last gave them (["9", "10"]), and
-- the band the teacher picked (null = worked out from the grade levels).
ALTER TABLE courses ADD COLUMN grade_levels jsonb;
ALTER TABLE courses ADD COLUMN grade_band text;
-- The teacher's own late policy, when the school lets teachers set one
-- (null = the school's).
ALTER TABLE courses ADD COLUMN late_policy jsonb;

-- A teacher's change to one grade's late penalty: {"waive": true},
-- {"percent": n} or {"days": n}. Kept in the grade history too.
ALTER TABLE grades ADD COLUMN late_override jsonb;
ALTER TABLE grade_history ADD COLUMN late_override jsonb;
