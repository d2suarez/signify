-- ===================================================================
-- Substitute teachers
--
-- A substitute keeps one account all year. On the days a school schedules
-- them to cover, they appear to every app as a teacher of the covered
-- classes; on any other day they cannot sign in at all.
--
-- Cover is by whole days in the school's own time zone. Nothing runs at
-- midnight to switch it on or off: class_access below works out, each time it
-- is read, who is in which class today. The apps ask Signify ID who teaches a
-- class rather than remembering, so they follow it without being told.
-- ===================================================================

CREATE TABLE coverages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  substitute_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who they are covering for, when the school said. Informational: which
  -- classes are covered is coverage_classes, not this.
  covering_for  uuid REFERENCES users(id) ON DELETE SET NULL,
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  note          text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Ended early (or cancelled before it began) by an administrator. A row is
  -- never deleted, so what access a substitute had, and when, stays on record.
  ended_at      timestamptz,
  ended_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (ends_on >= starts_on)
);
CREATE INDEX coverages_substitute_idx ON coverages(substitute_id, starts_on, ends_on);
CREATE INDEX coverages_tenant_idx ON coverages(tenant_id, ends_on);

CREATE TABLE coverage_classes (
  coverage_id uuid NOT NULL REFERENCES coverages(id) ON DELETE CASCADE,
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (coverage_id, class_id)
);
CREATE INDEX coverage_classes_class_idx ON coverage_classes(class_id);

-- Everyone's place in every class right now: their own places, plus any class
-- they are covering today. What the apps are told reads this, never
-- class_members directly, so cover appears and disappears on exactly the
-- scheduled days. A real place wins over cover for the same class.
CREATE VIEW class_access AS
SELECT DISTINCT ON (class_id, user_id) class_id, user_id, role, coverage_id
  FROM (
    SELECT cm.class_id, cm.user_id, cm.role, NULL::uuid AS coverage_id, 0 AS pref
      FROM class_members cm
    UNION ALL
    SELECT cc.class_id, cv.substitute_id, 'teacher', cv.id, 1
      FROM coverages cv
      JOIN coverage_classes cc ON cc.coverage_id = cv.id
      JOIN tenants t ON t.id = cv.tenant_id
     WHERE cv.ended_at IS NULL
       AND (now() AT TIME ZONE t.timezone)::date BETWEEN cv.starts_on AND cv.ends_on
  ) x
 ORDER BY class_id, user_id, pref;
