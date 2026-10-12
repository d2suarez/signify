-- ===================================================================
-- Asking for an account, and the end of the minor flag
--
-- Someone signing in on a domain no school claims used to hit a dead end:
-- "ask your administrator", with no way for the administrator to know they
-- had tried. Now the attempt itself becomes a request an admin can act on.
--
-- Separately: the per-school "pupils here are under 13" switch is gone. Every
-- account is for someone 13 or over, stated once on the page where accounts
-- are made rather than configured per school — a setting that could be
-- toggled was a setting that could contradict the privacy policy.
-- ===================================================================

CREATE TABLE access_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- How many times they have tried. A second attempt is not a second request,
  -- but it does say they are still waiting.
  attempts     integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'declined')),
  -- Filled in when somebody decides.
  decided_at   timestamptz,
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
  role_id      uuid REFERENCES roles(id) ON DELETE SET NULL,
  note         text NOT NULL DEFAULT ''
);

-- One open request per person; a repeat attempt bumps the existing one.
CREATE UNIQUE INDEX access_requests_open_idx ON access_requests(user_id) WHERE status = 'pending';
CREATE INDEX access_requests_status_idx ON access_requests(status, requested_at DESC);

-- ---------- the minor flag retires ----------
-- Kept as columns so nothing that reads them breaks, but no longer set from
-- anywhere and no longer shown. Every account is 13+.
UPDATE users SET is_minor = false, minor_source = 'admin_set' WHERE is_minor;
UPDATE tenants SET minors_default = false WHERE minors_default;
