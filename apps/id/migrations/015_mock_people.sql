-- ===================================================================
-- Mock people
--
-- A mock person is a made-up student or parent the school keeps so that
-- staff can see an app the way that student or parent would, without anyone
-- signing in as them. A mock has no Google login and can never get one:
-- sign-in refuses the account outright, and a session is never made for it.
-- Its address is on practice.invalid, which is reserved and never resolves.
--
-- Staff look at what a mock sees through /api/v1/preview/..., with their
-- own sign-in. Real people are never previewed (an open question for the
-- school), so the flag is what that API checks first.
-- ===================================================================

ALTER TABLE users ADD COLUMN is_mock boolean NOT NULL DEFAULT false;

-- Every existing practice.invalid account was made by the practice class as
-- a made-up student, so it is a mock.
UPDATE users SET is_mock = true WHERE email LIKE '%@practice.invalid';

-- A mock can never be claimed by a sign-in.
ALTER TABLE users ADD CONSTRAINT users_mock_has_no_real_email
  CHECK (NOT is_mock OR email LIKE '%@practice.invalid');
