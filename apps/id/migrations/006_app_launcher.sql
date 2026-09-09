-- ===================================================================
-- The app switcher
--
-- Signify ID already knows which apps a person may open — it decides that at
-- every sign-in. What it did not know was where an app lives or what it looks
-- like, so it could not hand back a list anyone could render.
-- ===================================================================

ALTER TABLE apps ADD COLUMN launch_url text;

-- Shown under the tile. Falls back to the app's full name.
ALTER TABLE apps ADD COLUMN short_name text;

-- The tile's monogram and colour. No icon files: a letterform renders
-- identically everywhere, needs no asset pipeline, and stays crisp at any
-- size on the one surface where every app has to look like a set.
ALTER TABLE apps ADD COLUMN tile_initials text;
ALTER TABLE apps ADD COLUMN tile_color text
  CHECK (tile_color IS NULL OR tile_color IN ('blue', 'red', 'yellow', 'green', 'ink'));

-- Order in the grid. Lower first, then alphabetical.
ALTER TABLE apps ADD COLUMN sort_order integer NOT NULL DEFAULT 100;

-- An app with no launch address simply does not appear in the switcher.
CREATE INDEX apps_launchable_idx ON apps(sort_order) WHERE launch_url IS NOT NULL AND status = 'active';
