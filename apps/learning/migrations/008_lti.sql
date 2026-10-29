-- LTI 1.3: Signify Learning as a tool that Schoology (or another LMS) launches.
--
-- A school admin registers each platform. A launch is a signed id_token from
-- that platform; nothing in it is trusted about who may do what here. It only
-- says which Schoology course the person came from and what email they have,
-- and that is checked against the person's own Signify ID sign-in.

CREATE TABLE lti_platforms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  name           text NOT NULL,
  issuer         text NOT NULL,
  client_id      text NOT NULL,
  -- Empty = any deployment of this client.
  deployment_ids text[] NOT NULL DEFAULT '{}',
  auth_url       text NOT NULL,
  token_url      text NOT NULL DEFAULT '',
  jwks_url       text NOT NULL,
  -- Origins allowed to frame a launch (frame-ancestors), e.g. the school's
  -- own Schoology address. Only the launch pages are ever framed.
  frame_origins  text[] NOT NULL DEFAULT '{}',
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- One issuer + client is one platform, in one school: a launch names only
  -- these two, so they must say which school it is.
  UNIQUE (issuer, client_id)
);
CREATE INDEX lti_platforms_tenant ON lti_platforms (tenant_id);

-- Our own signing keys (for Deep Linking and grade services later), one per
-- school, made the first time a school registers a platform. The public half
-- is published at /.well-known/jwks.json.
CREATE TABLE lti_keys (
  kid          text PRIMARY KEY,
  tenant_id    text NOT NULL,
  private_pem  text NOT NULL,
  public_jwk   jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lti_keys_tenant ON lti_keys (tenant_id);

-- Login initiation hands the platform a state and a nonce; the launch must
-- bring both back, once, within ten minutes.
CREATE TABLE lti_states (
  state        text PRIMARY KEY,
  tenant_id    text NOT NULL,
  platform_id  uuid NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  nonce        text NOT NULL,
  expires_at   timestamptz NOT NULL
);

-- Every nonce a launch has used, so a replayed id_token is refused.
CREATE TABLE lti_nonces (
  tenant_id    text NOT NULL,
  platform_id  uuid NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  nonce        text NOT NULL,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (platform_id, nonce)
);

-- A checked launch, waiting for the person to open it with their own Signify
-- sign-in (in a new tab: Signify's session cookie isn't sent inside a frame).
-- The email is only compared with the signed-in person's; no person is kept.
CREATE TABLE lti_launches (
  id             text PRIMARY KEY,
  tenant_id      text NOT NULL,
  platform_id    uuid NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  email          text NOT NULL DEFAULT '',
  context_id     text NOT NULL,
  context_title  text NOT NULL DEFAULT '',
  resource_link_id text NOT NULL DEFAULT '',
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Which Learning course a platform's course (LTI context) opens, as a
-- teacher of that course confirmed it.
CREATE TABLE lti_contexts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  platform_id  uuid NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  context_id   text NOT NULL,
  title        text NOT NULL DEFAULT '',
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  linked_by    text NOT NULL,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform_id, context_id)
);
