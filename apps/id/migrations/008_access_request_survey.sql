-- ===================================================================
-- What someone says about themselves when asking for an account
--
-- A sign-in that matched no school already became a request (migration 007),
-- but all an administrator could see was a name and an email address. The
-- person is now asked a few questions straight afterwards: which apps, which
-- school, what they do, what they teach and to whom, and how they heard.
--
-- A student is asked only the first question. Student accounts come from a
-- school, and nothing more should be collected from a student who has
-- wandered in from somewhere else.
--
-- Everything here is cleared 90 days after the request is decided (see
-- src/maintenance.js), and the privacy policy says so.
-- ===================================================================

ALTER TABLE access_requests
  -- The app they were trying to open when they were turned away.
  ADD COLUMN came_from_app       text,
  ADD COLUMN respondent          text CHECK (respondent IN ('educator', 'student', 'other')),
  ADD COLUMN interested_apps     text[] NOT NULL DEFAULT '{}',
  ADD COLUMN interested_other    text NOT NULL DEFAULT '',
  ADD COLUMN school_name         text NOT NULL DEFAULT '',
  ADD COLUMN not_at_school       boolean NOT NULL DEFAULT false,
  ADD COLUMN job_title           text NOT NULL DEFAULT '',
  ADD COLUMN heard_from          text NOT NULL DEFAULT '',
  ADD COLUMN heard_from_other    text NOT NULL DEFAULT '',
  ADD COLUMN subjects            text[] NOT NULL DEFAULT '{}',
  ADD COLUMN subjects_other      text NOT NULL DEFAULT '',
  ADD COLUMN grade_levels        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN survey_submitted_at timestamptz;
