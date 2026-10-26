-- ===================================================================
-- Apps declare their features, and each school decides which roles get them
--
-- Permissions answer "may this person use the app at all, and how far does
-- their reach go". Some apps also have parts a school wants to switch on or
-- off by role without inventing a permission for each one: Teacher's Desk's
-- tools, for a start, where students get the desk but not the seating plan.
--
-- The app is the authority on what its features are, exactly as with
-- permissions, so it declares them on boot (`/api/v1/declare-features`) and
-- they are kept here. Each one says whether students get it when the school
-- has not said otherwise; every other role gets everything until the school
-- says otherwise. The school's own choices live in
-- tenants.settings.app_features, keyed by the app's client_id and then by
-- role key, and only differences from those defaults are stored.
-- ===================================================================

ALTER TABLE apps ADD COLUMN features jsonb NOT NULL DEFAULT '[]'::jsonb;
