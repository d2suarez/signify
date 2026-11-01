-- ===================================================================
-- What a school belongs to: tenants.settings.affiliations
--
-- A list of keys (src/affiliations.js), today only 'nad' = the school is part
-- of the North American Division of Seventh-day Adventists. Only a platform
-- admin sets it (console: Schools), and every token carries it as
-- tenant_affiliations; Signify Learning shows the NAD's standards only to
-- schools that have it.
--
-- Richmond Academy, the one school in production, is an NAD school
-- (Desmond, 2026-10-31). Marked here so it holds from the deploy; a fresh
-- database has no such school and this changes nothing. Recorded in the
-- audit log like a change made on the console.
-- ===================================================================

WITH marked AS (
  UPDATE tenants
     SET settings = jsonb_set(settings, '{affiliations}', '["nad"]'::jsonb), updated_at = now()
   WHERE kind = 'school' AND lower(name) = 'richmond academy'
     AND NOT (settings ? 'affiliations')
  RETURNING id
)
INSERT INTO audit_log (actor_email, tenant_id, action, target_type, target_id, detail)
SELECT 'migration 016', id, 'tenant.affiliations_updated', 'tenant', id::text, '{"affiliations":["nad"]}'::jsonb
  FROM marked;
