# Signify ID

Central identity, roles and roster service for every Signify app. A real OAuth2/OIDC provider (auth code + PKCE, RS256, JWKS) with Postgres, live at https://id.signify.one. Google OAuth is the only sign-in. Apps are relying parties via `client/signify-auth.js`. Full history is in the `signify-id-identity-service` and `signify-id-idle-window` memory files.

## Run / test / deploy
- `npm test` (about 556 assertions, in-process PGlite; no server needed).
- `node test/dev-server.js` (port 3010, throwaway DB, seeded demo school, `ALLOW_DEV_LOGIN=1`). `node test/dev-app.js` runs a demo app on :3011.
- Deploy: Railway project `signify-id`, not app-sleeping (every sign-in goes through it). Config is in `.railway/railway.ts`; `railway config plan` first.
- Production DB access: `railway ssh --service signify-id`, query through `/app/src/db.js`. `railway run` cannot reach the DB. Avoid `$$` and `$1` in remote commands (the shell expands them); inline literals instead. `audit_log` time column is `ts`.
- Register or update an app: `railway ssh --service signify-id "node src/register-app.js ..."`.

## Design decisions to keep
- Users are keyed on Google `sub`, never email. A different account on a taken address is refused and audited; an admin "releases" it.
- Sessions are DB rows (blocking someone ends sessions everywhere). Idle window is set per role at sign-in and stored as `sessions.idle_minutes` (staff 480, student 45, absolute cap 12h). One number, read everywhere.
- Role belongs to a membership. Tokens carry only `core:` plus the app's own namespace, so no cross-app profile of a child.
- Super admin is a separate table; restore is super-admin-only and deliberately not a permission.
- Everyone is 13+. COPPA does not apply; FERPA is followed voluntarily, never claimed as "compliant". Times Tables Trainer (3rd graders) must NOT be connected without a deliberate decision.
- Privacy policy "what we collect" is generated from `src/data-inventory.js`; tests fail if a personal column is unclassified or missing from a disclosure line. Policy purposes must stand alone as bullets (no pronouns; say "email address", never bare "address"). No parental-approval wording, no named school.
- Self-hosted fonts only in `public/vendor/` (no CDN: it would send pupil IPs to a third party).
- Apps declare their own permissions via `/api/v1/declare`, namespace-locked.
- A school's rooms and places live in `tenants.settings.locations` (console page Places, permission `core:manage_places`, local admins by default). Apps read them with their client credentials at `GET /api/v1/tenants/:id/locations`, only for schools they are enabled for: room names, nothing personal.
- People with no school live in the one `tenants.kind = 'independent'` tenant (migration 012). Their grants are capped at `own` in `identity.accessFor`, so members are strangers to each other. No domains, classes, roster imports, admin or substitute roles; only super admins add them. Tokens carry `tenant_kind` so apps can hide "share with my school".

## Traps
- Backup signing: `canonical()` must call `toJSON()`; test signing across a JSON round trip.
- `seed.ensureBuiltins()` runs at boot; edited built-in roles are protected by `roles.customised`.
- Any new code path that decides whether a session is alive must use `sessions.slide`, not its own check.
- A new disclosure category must render on the published page (it is generated from `CATEGORY_TITLES`).
- Queries for the admin console: select `r.*`, and test with the real query's row shape.
- CSP for Google Identity Services needs `https://accounts.google.com` in `style-src` too.
- `client/signify-auth.js` is copied into teachers-desk, classroom-atlas and classroom-whiteboard. Update all copies together and compare with `md5`.
- After migrations or deploys, verify on production (columns present, policy version, signed-out API returns 401).
