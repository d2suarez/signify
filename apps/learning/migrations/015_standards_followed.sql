-- Which standards a school follows (Virginia SOL, later the NAD's), so the
-- library and pickers put those first. Rules: src/lib/standards-library.ts.

-- Where a library set applies: a US state's postal code ('VA'), 'NAD' for
-- the North American Division's Adventist standards, null for multi-state
-- sets (Common Core, NGSS) and for school and teacher sets.
ALTER TABLE standard_frameworks ADD COLUMN jurisdiction text;
UPDATE standard_frameworks SET jurisdiction = 'VA' WHERE tenant_id = '_library' AND key IN ('va-sol-math', 'va-sol-english');

-- The seed builder now drops Markdown bold marks ('**Usage**'), which some
-- CASE files carry in plain-text statements; loaded sets get the same.
UPDATE standard_items SET statement = btrim(replace(statement, '**', '')) WHERE tenant_id = '_library' AND statement LIKE '%**%';
UPDATE standards s SET description = left(i.statement, 2000)
  FROM standard_items i WHERE i.id = s.item_id AND i.tenant_id = '_library' AND s.description LIKE '%**%';

-- The states (and 'NAD') a school picked, to list their sets on /school/standards.
ALTER TABLE school_standards_settings ADD COLUMN jurisdictions text[] NOT NULL DEFAULT '{}';

-- Library sets (by key, every version) the school follows. Following a
-- 'school' set also turns it on (school_standard_sets); turning it off
-- stops following it. No rows = the library as it always was.
CREATE TABLE school_followed_sets (
  tenant_id     text NOT NULL,
  framework_key text NOT NULL,
  followed_by   text NOT NULL,
  followed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, framework_key)
);
