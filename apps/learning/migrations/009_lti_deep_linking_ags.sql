-- LTI 1.3 Deep Linking (a teacher places Learning lessons and assignments in
-- Schoology) and Assignment and Grade Services (released Learning grades go
-- to the Schoology line item). Schoology stays the record; Learning is never
-- blocked by it.

-- What a launch asked for. A deep-linking launch keeps the platform's
-- settings (where to send the answer, and its opaque `data` to echo back);
-- a resource-link launch keeps the item it opens (from our custom claim).
ALTER TABLE lti_launches
  ADD COLUMN message_type   text NOT NULL DEFAULT 'LtiResourceLinkRequest',
  ADD COLUMN deployment_id  text NOT NULL DEFAULT '',
  ADD COLUMN sub            text NOT NULL DEFAULT '',
  ADD COLUMN item           text NOT NULL DEFAULT '',
  ADD COLUMN dl_settings    jsonb,
  -- The signed LtiDeepLinkingResponse, ready for the framed page to post
  -- back; taken once.
  ADD COLUMN dl_response    text,
  ADD COLUMN dl_taken       boolean NOT NULL DEFAULT false;

-- The platform's service addresses for one of its courses, as the latest
-- launch from that course gave them (AGS line items, Names and Roles).
CREATE TABLE lti_context_services (
  tenant_id      text NOT NULL,
  platform_id    uuid NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  context_id     text NOT NULL,
  deployment_id  text NOT NULL DEFAULT '',
  lineitems_url  text NOT NULL DEFAULT '',
  ags_scopes     text[] NOT NULL DEFAULT '{}',
  nrps_url       text NOT NULL DEFAULT '',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, context_id)
);

-- A Learning lesson or assignment a teacher placed in a platform course.
-- An assignment's line item address arrives with the first launch of its
-- link (or is looked up by resource id).
CREATE TABLE lti_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  platform_id   uuid NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  context_id    text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('lesson', 'assignment')),
  item_id       uuid NOT NULL,
  lineitem_url  text NOT NULL DEFAULT '',
  placed_by     text NOT NULL,
  placed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform_id, context_id, kind, item_id)
);
CREATE INDEX lti_items_item ON lti_items (tenant_id, item_id);

-- Which platform user a Signify person is, learned from their own launches
-- (email matched to their sign-in) or the platform's class list. Ids only.
CREATE TABLE lti_users (
  tenant_id    text NOT NULL,
  platform_id  uuid NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  sub          text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, user_id)
);

-- One grade on its way to one platform line item. The latest wish wins: a
-- new save resets the row to pending. `email` is kept only until the
-- platform user is found, then cleared.
CREATE TABLE lti_scores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL,
  platform_id       uuid NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  context_id        text NOT NULL,
  assignment_id     uuid NOT NULL,
  student_id        text NOT NULL,
  -- pending | sent | failed | skipped
  status            text NOT NULL DEFAULT 'pending',
  score             numeric,
  score_max         numeric NOT NULL DEFAULT 0,
  comment           text NOT NULL DEFAULT '',
  email             text NOT NULL DEFAULT '',
  platform_user_id  text NOT NULL DEFAULT '',
  attempts          int NOT NULL DEFAULT 0,
  -- Bumped by every new wish, so a send finishing late can't mark a newer
  -- score as sent.
  rev               int NOT NULL DEFAULT 1,
  next_at           timestamptz NOT NULL DEFAULT now(),
  last_error        text NOT NULL DEFAULT '',
  sent_at           timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform_id, context_id, assignment_id, student_id)
);
CREATE INDEX lti_scores_due ON lti_scores (status, next_at);
CREATE INDEX lti_scores_assignment ON lti_scores (tenant_id, assignment_id);
