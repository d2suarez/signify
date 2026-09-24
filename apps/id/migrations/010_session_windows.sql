-- ===================================================================
-- How long a sign-in survives being left alone
--
-- One idle window for everybody meant choosing between a teacher signed out
-- mid-morning and a shared classroom tablet left open for the next child.
-- The window is now decided once, at sign-in, from the role the person holds,
-- and written on the session itself.
--
-- Storing it here rather than working it out again on each use is the point:
-- touch() and slide() previously each decided the window from the account,
-- and a disagreement between two such paths is exactly what left teachers
-- "signed in" to an app the service had already given up on.
--
-- revoked_reason: revoke() has always taken a reason and dropped it, so
-- nothing recorded why a sign-in ended. It does now.
-- ===================================================================

ALTER TABLE sessions
  ADD COLUMN idle_minutes   integer NOT NULL DEFAULT 45,
  ADD COLUMN revoked_reason text;
