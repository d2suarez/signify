-- ===================================================================
-- Independent accounts: people who are not at any school
--
-- Every role, token and app switch in Signify ID hangs off a membership in a
-- tenant, so "no school" is a tenant of its own kind rather than a missing
-- one. That keeps /authorize, the token claims and every app working
-- unchanged.
--
-- What makes it not a school is enforced in code, not here:
--   - a member's grants are capped at 'own', so nobody in it can list, search
--     or manage anyone else in it — they are strangers to each other;
--   - no email domain can be claimed for it, so nobody joins automatically;
--   - no classes and no roster imports;
--   - only a super admin adds people to it.
--
-- Exactly one may exist, enforced by the partial unique index.
-- ===================================================================

ALTER TABLE tenants ADD COLUMN kind text NOT NULL DEFAULT 'school'
  CHECK (kind IN ('school', 'independent'));

CREATE UNIQUE INDEX tenants_one_independent ON tenants (kind) WHERE kind = 'independent';

INSERT INTO tenants (slug, name, kind, minors_default)
VALUES ('independent', 'Independent', 'independent', false)
ON CONFLICT (slug) DO NOTHING;
