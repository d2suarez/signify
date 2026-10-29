-- LTI 1.3 platform mode: outside tools run inside Learning lessons and as
-- assignments. Learning signs the launches; tools send back Deep Linking
-- answers (signed with their own keys) and scores (with a token they got by
-- a JWT assertion signed with their key).
--
-- What a tool learns about a person is the school's choice per tool: by
-- default teachers' name and email, and for students an opaque id only.

CREATE TABLE lti_tools (
  -- Also the tool's deployment id.
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  name           text NOT NULL,
  -- Says which tool (and so which school) a token request comes from.
  client_id      text NOT NULL UNIQUE,
  login_url      text NOT NULL,
  launch_url     text NOT NULL,
  -- Where a teacher picks content; '' = the tool doesn't do Deep Linking.
  deep_link_url  text NOT NULL DEFAULT '',
  jwks_url       text NOT NULL,
  redirect_uris  text[] NOT NULL DEFAULT '{}',
  teacher_data   text NOT NULL DEFAULT 'name_email' CHECK (teacher_data IN ('none', 'name', 'name_email')),
  student_data   text NOT NULL DEFAULT 'none' CHECK (student_data IN ('none', 'name', 'name_email')),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lti_tools_tenant ON lti_tools (tenant_id);

-- The opaque id (`sub`) a tool knows a person by: random, one per tool, so
-- two tools can't match people up. Ids only.
CREATE TABLE lti_tool_users (
  tenant_id  text NOT NULL,
  tool_id    uuid NOT NULL REFERENCES lti_tools(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  sub        text NOT NULL,
  PRIMARY KEY (tool_id, user_id),
  UNIQUE (tool_id, sub)
);

-- A placed tool: a block in a lesson or an assignment. The id is the LTI
-- resource link id (and, for an assignment, its line item).
CREATE TABLE lti_tool_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  tool_id        uuid NOT NULL REFERENCES lti_tools(id) ON DELETE CASCADE,
  course_id      uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id      uuid,
  assignment_id  uuid,
  title          text NOT NULL DEFAULT '',
  -- The tool's chosen launch address ('' = the tool's launch URL).
  url            text NOT NULL DEFAULT '',
  custom         jsonb NOT NULL DEFAULT '{}',
  -- The tool's line item wishes from Deep Linking (resourceId, tag, label).
  line_item      jsonb,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lti_tool_links_course ON lti_tool_links (tenant_id, course_id);
CREATE INDEX lti_tool_links_assignment ON lti_tool_links (tenant_id, assignment_id);

-- A teacher choosing content in a tool (Deep Linking). `id` is the `data`
-- the tool must echo; the answer is taken once.
CREATE TABLE lti_tool_picks (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  tool_id     uuid NOT NULL REFERENCES lti_tools(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id   uuid,
  -- lesson | assignment
  place       text NOT NULL CHECK (place IN ('lesson', 'assignment')),
  -- waiting | done | cancelled
  state       text NOT NULL DEFAULT 'waiting',
  items       jsonb NOT NULL DEFAULT '[]',
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A launch on its way: made when the person presses the tool, spent by the
-- tool's authentication request (minutes). Holds the claims to sign, with
-- only the personal data the school's setting allows; deleted when spent.
CREATE TABLE lti_tool_logins (
  id           text PRIMARY KEY,
  login_hint   text NOT NULL,
  tenant_id    text NOT NULL,
  tool_id      uuid NOT NULL REFERENCES lti_tools(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  claims       jsonb NOT NULL,
  expires_at   timestamptz NOT NULL
);

-- Every nonce (Deep Linking answers) and jti (token requests) a tool has
-- used, so nothing it signed can be replayed.
CREATE TABLE lti_tool_nonces (
  tool_id     uuid NOT NULL REFERENCES lti_tools(id) ON DELETE CASCADE,
  value       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (tool_id, value)
);

-- Access tokens handed to tools (only their hash is kept).
CREATE TABLE lti_tool_tokens (
  hash        text PRIMARY KEY,
  tenant_id   text NOT NULL,
  tool_id     uuid NOT NULL REFERENCES lti_tools(id) ON DELETE CASCADE,
  scopes      text[] NOT NULL,
  expires_at  timestamptz NOT NULL
);

-- The latest score a tool sent for one student on one placed assignment.
-- It is written to the gradebook by setGrade (history, roster check) the
-- next time Signify ID can say who is in the class: a teacher opening the
-- assignment or gradebook, or the student opening it.
CREATE TABLE lti_tool_scores (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  tool_id        uuid NOT NULL REFERENCES lti_tools(id) ON DELETE CASCADE,
  link_id        uuid NOT NULL REFERENCES lti_tool_links(id) ON DELETE CASCADE,
  assignment_id  uuid NOT NULL,
  student_id     text NOT NULL,
  score_given    numeric,
  score_maximum  numeric,
  activity       text NOT NULL DEFAULT '',
  grading        text NOT NULL DEFAULT '',
  comment        text NOT NULL DEFAULT '',
  tool_time      timestamptz NOT NULL,
  -- waiting (to be written) | written | recorded (nothing to write) | refused (not in the class)
  status         text NOT NULL DEFAULT 'waiting',
  received_at    timestamptz NOT NULL DEFAULT now(),
  written_at     timestamptz,
  UNIQUE (link_id, student_id)
);
CREATE INDEX lti_tool_scores_waiting ON lti_tool_scores (tenant_id, assignment_id, status);
