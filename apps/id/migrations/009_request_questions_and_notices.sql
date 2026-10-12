-- ===================================================================
-- Four more questions, and telling super admins a request has arrived
--
-- The questions are the ones that decide whether an account can be set up
-- at all: Signify.one Apps sign people in with Google, so a school on
-- Microsoft accounts cannot use them however good the fit. The others say
-- who would use them, roughly how many students, and when.
--
-- requests_seen_at is per super admin: the console compares it with each
-- pending request to say "new since you last looked", and opening the
-- Requests page moves it forward. One admin looking does not clear another's.
-- ===================================================================

ALTER TABLE access_requests
  ADD COLUMN google_accounts text NOT NULL DEFAULT '',
  ADD COLUMN usage_scope     text NOT NULL DEFAULT '',
  ADD COLUMN student_count   text NOT NULL DEFAULT '',
  ADD COLUMN start_when      text NOT NULL DEFAULT '';

ALTER TABLE platform_admins
  ADD COLUMN requests_seen_at timestamptz;
