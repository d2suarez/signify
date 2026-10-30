-- The standards library, CASE-shaped: frameworks (CFDocument) hold items
-- (CFItem, a tree by parent_id) and associations (CFAssociation other than
-- isChildOf). Shape, rules and loading: src/lib/standards-library.ts.
--
-- Published sets (Common Core, NGSS, ...) are loaded from the seed files in
-- standards/ with tenant_id '_library' and are read by every school. A
-- school's own frameworks (owner 'school') and a teacher's (owner
-- 'teacher', owner_id = their Signify id) carry the school's tenant_id.

CREATE TABLE standard_frameworks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text NOT NULL,
  owner_kind          text NOT NULL CHECK (owner_kind IN ('library', 'school', 'teacher')),
  -- A teacher framework's Signify id; null otherwise.
  owner_id            text,
  -- A teacher framework made for one course (the course's own standards,
  -- including those moved here from before the library): its teachers edit it.
  course_id           uuid REFERENCES courses(id) ON DELETE SET NULL,
  -- Library sets: the seed's key ('ccss-math'); with version, one row each.
  key                 text,
  identifier          text NOT NULL,
  uri                 text,
  title               text NOT NULL,
  creator             text NOT NULL DEFAULT '',
  publisher           text NOT NULL DEFAULT '',
  subjects            text[] NOT NULL DEFAULT '{}',
  language            text NOT NULL DEFAULT 'en',
  version             text NOT NULL DEFAULT '',
  adoption_status     text,
  official_source_url text,
  -- Where the machine-readable data came from, and what it is.
  data_url            text,
  data_source         text,
  license_title       text,
  license_uri         text,
  license_text        text,
  -- Shown wherever the framework's text is shown (the CCSS copyright line).
  notice              text,
  -- 'open': every school sees it. 'school': a school admin turns it on,
  -- accepting its terms (school_standard_sets).
  distribution        text NOT NULL DEFAULT 'open' CHECK (distribution IN ('open', 'school')),
  copied_from         uuid REFERENCES standard_frameworks(id) ON DELETE SET NULL,
  archived            boolean NOT NULL DEFAULT false,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX standard_frameworks_key ON standard_frameworks (tenant_id, key, version) WHERE key IS NOT NULL;
CREATE INDEX standard_frameworks_tenant ON standard_frameworks (tenant_id, owner_kind, archived);

CREATE TABLE standard_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  framework_id  uuid NOT NULL REFERENCES standard_frameworks(id) ON DELETE CASCADE,
  identifier    text NOT NULL,
  uri           text,
  -- humanCodingScheme ('3.OA.A.1'); '' for headings without one.
  code          text NOT NULL DEFAULT '',
  -- fullStatement, in the source's own language.
  statement     text NOT NULL,
  abbreviated   text,
  item_type     text,
  -- CASE education levels: 'PK', 'KG', '01' .. '12'.
  grades        text[] NOT NULL DEFAULT '{}',
  parent_id     uuid REFERENCES standard_items(id) ON DELETE SET NULL,
  depth         integer NOT NULL DEFAULT 0,
  -- Tree order within the framework (parents before children).
  position      integer NOT NULL DEFAULT 0,
  list_enum     text,
  notes         text,
  archived      boolean NOT NULL DEFAULT false,
  UNIQUE (framework_id, identifier)
);
CREATE INDEX standard_items_framework ON standard_items (framework_id, position);
CREATE INDEX standard_items_code ON standard_items (tenant_id, lower(code));

CREATE TABLE standard_associations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  framework_id     uuid NOT NULL REFERENCES standard_frameworks(id) ON DELETE CASCADE,
  origin_id        uuid NOT NULL REFERENCES standard_items(id) ON DELETE CASCADE,
  association_type text NOT NULL,
  dest_identifier  text NOT NULL,
  dest_uri         text
);
CREATE INDEX standard_associations_origin ON standard_associations (origin_id);

-- Library sets with distribution 'school' that a school turned on.
CREATE TABLE school_standard_sets (
  tenant_id     text NOT NULL,
  framework_key text NOT NULL,
  enabled_by    text NOT NULL,
  enabled_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, framework_key)
);

-- The school's standards-based grading defaults (scale labels, summary,
-- conversion; shape in standards-math.ts) and what teachers may change.
CREATE TABLE school_standards_settings (
  tenant_id          text PRIMARY KEY,
  settings           jsonb,
  -- Teachers may make their own frameworks (and type standards into a course).
  teacher_frameworks boolean NOT NULL DEFAULT true,
  -- Courses may have their own scale/conversion instead of the school's.
  course_settings    boolean NOT NULL DEFAULT true,
  updated_by         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A course standard now points at an item (library, school or teacher).
-- code and description stay on the row as the course's copy, so the
-- gradebook, levels and alignments keep working unchanged.
ALTER TABLE standards ALTER COLUMN description TYPE text;
ALTER TABLE standards ADD COLUMN item_id uuid REFERENCES standard_items(id) ON DELETE SET NULL;
CREATE INDEX standards_item ON standards (tenant_id, item_id);

-- Which course standards a lesson addresses (ids). Filing, like its unit:
-- not part of the lesson's versioned content.
ALTER TABLE lessons ADD COLUMN standards jsonb;

-- Every existing course standard becomes an item of its course's own
-- framework. The course standard keeps its id, so assignments, rubric rows,
-- quiz questions and grades.levels still point at it.
INSERT INTO standard_frameworks (tenant_id, owner_kind, course_id, identifier, title, created_by)
SELECT DISTINCT c.tenant_id, 'teacher', c.id, gen_random_uuid()::text, c.name, 'migration-014'
  FROM courses c JOIN standards s ON s.course_id = c.id AND s.tenant_id = c.tenant_id;

-- external_id was a CASE id typed by hand: it is kept as the item's uri.
INSERT INTO standard_items (tenant_id, framework_id, identifier, uri, code, statement, position, archived)
SELECT s.tenant_id, f.id, s.id::text, nullif(s.external_id, ''), s.code, s.description,
       row_number() OVER (PARTITION BY s.course_id ORDER BY s.position, s.created_at), s.archived
  FROM standards s JOIN standard_frameworks f ON f.course_id = s.course_id AND f.tenant_id = s.tenant_id AND f.created_by = 'migration-014';

UPDATE standards s SET item_id = i.id
  FROM standard_items i JOIN standard_frameworks f ON f.id = i.framework_id AND f.created_by = 'migration-014'
 WHERE f.course_id = s.course_id AND f.tenant_id = s.tenant_id
   AND i.identifier = s.id::text;
