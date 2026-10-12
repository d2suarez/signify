-- ===================================================================
-- Signify ID — initial schema
--
-- Design notes that matter for correctness and for FERPA/COPPA:
--   * A person is identified by users.id (uuid), NEVER by email. School
--     districts recycle addresses; keying on email hands a new student the
--     previous holder's records. identities.subject (Google's `sub`) is the
--     immutable anchor.
--   * Role is a property of a MEMBERSHIP (user x tenant), not of a user. The
--     same person can teach at one school and be a guardian at another.
--   * Sessions are rows, not self-contained tokens, so an administrator
--     blocking an account actually ends that account's access.
-- ===================================================================

-- gen_random_uuid() is core Postgres from v13 onward; no extension needed.

-- ---------- tenants (schools / organisations) ----------

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'archived')),
  timezone        text NOT NULL DEFAULT 'America/New_York',
  -- School year boundary drives roster rollover and retention sweeps.
  year_start_month smallint NOT NULL DEFAULT 8 CHECK (year_start_month BETWEEN 1 AND 12),
  -- The tenant asserts whether its pupils are under 13 rather than us asking
  -- children for a birthdate. Collecting less is the point.
  minors_default  boolean NOT NULL DEFAULT true,
  -- Days of inactivity after which student records are purged. NULL = follow
  -- the platform default. COPPA (2025 amendments) requires a stated limit.
  retention_days  integer,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- A district can own several domains; a domain belongs to exactly one tenant.
CREATE TABLE tenant_domains (
  domain      text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Role key granted automatically to a verified sign-in on this domain.
  -- NULL means "create the membership but leave it pending approval".
  auto_role   text,
  -- Google Workspace `hd` claim must match for auto-join to fire. A personal
  -- gmail account that merely looks like the domain will not qualify.
  require_hd  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_domains_tenant_idx ON tenant_domains(tenant_id);

-- ---------- people ----------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lower-cased at write time. Unique only among live accounts, so a deleted
  -- account never blocks a genuinely new person at the same address.
  email         text NOT NULL,
  display_name  text NOT NULL,
  given_name    text,
  family_name   text,
  picture_url   text,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'pending', 'suspended', 'blocked')),
  -- Set from the tenant assertion, not from anything the child typed.
  is_minor      boolean NOT NULL DEFAULT true,
  minor_source  text NOT NULL DEFAULT 'tenant_default'
                  CHECK (minor_source IN ('tenant_default', 'grade_level', 'admin_set', 'staff_role')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  -- Soft delete first so an accidental removal is recoverable, then a hard
  -- purge on the retention sweep.
  deleted_at    timestamptz,
  purge_after   timestamptz
);
CREATE UNIQUE INDEX users_email_live_idx ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX users_purge_idx ON users(purge_after) WHERE purge_after IS NOT NULL;

-- One row per external login. Adding Clever/Microsoft/Apple later means
-- inserting a provider here, not touching anything above.
CREATE TABLE identities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  subject        text NOT NULL,
  email_at_link  text,
  hosted_domain  text,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  UNIQUE (provider, subject)
);
CREATE INDEX identities_user_idx ON identities(user_id);

-- ---------- roles and permissions ----------

-- tenant_id NULL marks the platform-wide built-ins every school inherits.
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  builtin     boolean NOT NULL DEFAULT false,
  -- Marks a role as administrative, which gates who is allowed to assign it.
  is_admin    boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_global_key_idx ON roles(key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX roles_tenant_key_idx ON roles(tenant_id, key) WHERE tenant_id IS NOT NULL;

-- Permission strings are namespaced `app:verb`. Scope keeps the catalogue
-- small: one `atlas:grade` permission at four different reaches rather than
-- four separate permissions.
CREATE TABLE role_permissions (
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission  text NOT NULL,
  scope       text NOT NULL DEFAULT 'own'
                CHECK (scope IN ('own', 'class', 'tenant', 'global')),
  PRIMARY KEY (role_id, permission)
);

-- ---------- membership: the join that carries the role ----------

CREATE TABLE memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role_id      uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('active', 'pending', 'suspended', 'blocked')),
  suspend_until timestamptz,
  grade_level  text,
  school_year  text,
  added_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);
CREATE INDEX memberships_tenant_idx ON memberships(tenant_id, status);
CREATE INDEX memberships_role_idx ON memberships(role_id);

-- Platform operators. Deliberately a separate table from any tenant role so
-- that "super admin" can never be granted by a school-level administrator.
CREATE TABLE platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- classes (shared roster across every app) ----------

CREATE TABLE classes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  subject          text,
  grade_level      text,
  school_year      text NOT NULL,
  google_course_id text,
  join_code        text UNIQUE,
  archived         boolean NOT NULL DEFAULT false,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classes_tenant_idx ON classes(tenant_id, archived);

CREATE TABLE class_members (
  class_id   uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'student'
               CHECK (role IN ('teacher', 'student', 'aide', 'observer')),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX class_members_user_idx ON class_members(user_id);

-- ---------- guardians (FERPA parental access, COPPA consent) ----------

CREATE TABLE guardian_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  relationship text NOT NULL DEFAULT 'parent',
  -- A guardian link is an access-granting claim, so it must be established by
  -- the school rather than asserted by whoever signed in.
  verified_at  timestamptz,
  verified_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guardian_id, student_id)
);
CREATE INDEX guardian_links_student_idx ON guardian_links(student_id);

-- ---------- consent and policy acceptance ----------

-- The COPPA school-consent exception only holds if the school actually
-- authorised the collection and was told what is collected. This table is
-- that evidence.
CREATE TABLE consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
  subject_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL
                   CHECK (kind IN ('school_authorization', 'parental_consent', 'policy_acceptance')),
  policy_version text NOT NULL,
  signer_name    text,
  signer_email   text,
  signer_title   text,
  method         text,
  document       jsonb NOT NULL DEFAULT '{}'::jsonb,
  signed_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  ip             inet
);
CREATE INDEX consents_tenant_idx ON consents(tenant_id, kind);

-- ---------- registered applications (OAuth clients) ----------

CREATE TABLE apps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          text NOT NULL UNIQUE,
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  -- scrypt hash; the plaintext secret is shown exactly once at creation.
  client_secret_hash text,
  redirect_uris      text[] NOT NULL DEFAULT '{}',
  post_logout_uris   text[] NOT NULL DEFAULT '{}',
  -- Permission namespace this app may ever see, e.g. 'atlas'. Claims are
  -- filtered to it so centralising identity does not let one app read another
  -- app's picture of a child.
  namespace          text NOT NULL,
  scopes             text[] NOT NULL DEFAULT '{openid,profile,email,roles}',
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disabled')),
  -- Minutes; short by default so revoking access takes effect quickly.
  access_token_ttl   integer NOT NULL DEFAULT 10,
  session_ttl_hours  integer NOT NULL DEFAULT 12,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Which schools are permitted to use which app.
CREATE TABLE app_tenants (
  app_id     uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, tenant_id)
);

-- ---------- sessions and tokens ----------

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 of the opaque cookie value; the raw value never touches the disk.
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Absolute cap, independent of activity.
  expires_at    timestamptz NOT NULL,
  -- Idle cap, refreshed on use. Shared classroom devices make this the more
  -- important of the two.
  idle_expires_at timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE auth_codes (
  code_hash      text PRIMARY KEY,
  app_id         uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id     uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scope          text NOT NULL,
  nonce          text,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  -- Set when this token was exchanged. Re-use of a rotated token means the
  -- token was stolen, and the whole session is killed.
  rotated_to  uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL
);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(session_id);

-- ---------- signing keys ----------

CREATE TABLE signing_keys (
  kid         text PRIMARY KEY,
  alg         text NOT NULL DEFAULT 'RS256',
  public_jwk  jsonb NOT NULL,
  private_pem text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Retired keys stay published in JWKS until every token signed with them
  -- has expired.
  retired_at  timestamptz
);

-- ---------- audit ----------

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email   text,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE SET NULL,
  app_id        uuid REFERENCES apps(id) ON DELETE SET NULL,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            inet,
  user_agent    text,
  -- FERPA 34 CFR 99.32 requires a record of disclosures of education records.
  -- Flagged rows are exactly that record and are exempt from log trimming.
  is_disclosure boolean NOT NULL DEFAULT false
);
CREATE INDEX audit_ts_idx ON audit_log(ts DESC);
CREATE INDEX audit_tenant_idx ON audit_log(tenant_id, ts DESC);
CREATE INDEX audit_target_idx ON audit_log(target_type, target_id);
CREATE INDEX audit_disclosure_idx ON audit_log(is_disclosure, ts DESC) WHERE is_disclosure;
