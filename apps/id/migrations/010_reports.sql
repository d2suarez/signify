-- ===================================================================
-- Problem reports
--
-- "Something isn't working" and "something here is wrong", sent from inside
-- any Signify app by whoever noticed it. They land here rather than in each
-- app so there is one list to work through, one retention rule, and one place
-- the privacy policy has to describe.
--
-- A report belongs to the person who wrote it: erasing them erases what they
-- wrote. The app and school are kept as names as well as ids, so a report
-- still reads sensibly after an app is retired.
-- ===================================================================

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short and speakable, for "I reported it — R-7K3Q".
  ref          text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),

  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
  app_id       uuid REFERENCES apps(id) ON DELETE SET NULL,
  app_name     text NOT NULL,

  kind         text NOT NULL CHECK (kind IN ('bug', 'mistake', 'other')),
  message      text NOT NULL,
  -- Path only. Query strings carry join codes and share tokens, so they are
  -- stripped before this is written.
  page_url     text NOT NULL DEFAULT '',
  -- Browser, screen size, language, recent script errors, and any text the
  -- person had highlighted. Only when they left "include details" ticked.
  context      jsonb NOT NULL DEFAULT '{}',

  status       text NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'investigating', 'fixed', 'wont_fix', 'duplicate')),
  resolution   text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  closed_by    uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX reports_triage_idx ON reports(status, created_at DESC);
CREATE INDEX reports_tenant_idx ON reports(tenant_id, created_at DESC);
CREATE INDEX reports_user_idx ON reports(user_id, created_at DESC);
