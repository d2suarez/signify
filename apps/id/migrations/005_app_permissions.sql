-- ===================================================================
-- Apps declare their own permissions
--
-- Adding an app used to mean registering it here AND hand-editing
-- src/rbac.js to add its permission block, then redeploying this service.
-- Two repos, two deploys, and an easy step to forget.
--
-- Now an app ships its own manifest and declares it on boot. The escalation
-- worry that would normally rule this out — a client inventing
-- "core:manage_users" — is closed by the namespace lock: an app registered
-- with namespace 'atlas' can only ever declare 'atlas:*'. Declaring a
-- permission also grants it to nobody; an administrator still has to put it
-- into a role.
-- ===================================================================

CREATE TABLE app_permissions (
  key         text PRIMARY KEY,
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Marks a permission as administrative, so only a super admin may put it
  -- into a role. An app may set this on its own permissions.
  is_admin    boolean NOT NULL DEFAULT false,
  -- A permission dropped from a later manifest is retired, never deleted:
  -- roles may still reference it, and silently removing it from a role would
  -- change what somebody is allowed to do without anyone deciding to.
  deprecated  boolean NOT NULL DEFAULT false,
  declared_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX app_permissions_app_idx ON app_permissions(app_id) WHERE NOT deprecated;
