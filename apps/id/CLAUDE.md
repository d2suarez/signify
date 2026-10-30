# Signify ID

Central identity, roles and roster service for every Signify app. A real OAuth2/OIDC provider (auth code + PKCE, RS256, JWKS) with Postgres, live at https://id.signify.one. Google OAuth is the only sign-in. Apps are relying parties via `client/signify-auth.js`. Full history is in the `signify-id-identity-service` and `signify-id-idle-window` memory files.

## Run / test / deploy
- `npm test` (about 707 assertions, in-process PGlite; no server needed).
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
- Apps can also declare **features** (`/api/v1/declare-features`, stored in `apps.features`, migration 013): parts a school turns on or off per role on the console's Tools by role page (`core:manage_roles`). Default: the built-in `student` role gets only features marked `students: true`, every other role gets everything. Only differences are stored, in `tenants.settings.app_features[client_id][role_key]`. Apps read `GET /api/v1/tenants/:id/features` with client credentials. Teacher's Desk uses it for its tools. Do not give the Student role a permission to make an app open for it: the escalation guard then stops local admins who lack that permission from assigning Student.
- A school's rooms and places live in `tenants.settings.locations` (console page Places, permission `core:manage_places`, local admins by default). Apps read them with their client credentials at `GET /api/v1/tenants/:id/locations`, only for schools they are enabled for: room names, nothing personal.
- Parents: the school links a parent's account to a student on the console's **Parents** page (`src/guardians.js`, `core:manage_guardians`, local admins by default), and verifies it; every link, verify and removal is audited (`guardian.*`). Only verified links at the token's school count. Apps ask `GET /api/v1/my-children` with the parent's own token (children, relationship, each child's classes; no emails). The parent is added first on People with the role Parent or guardian, using the Google account they sign in with. Signify Learning's parent view reads it.
- **Names** (`src/names.js`, migration 014, console page Names, `core:manage_users`): an **official name** (`users.official_given|middle|family_name`, `official_suffix`) is the school's record (FACTS at Richmond), typed in on Manage → Names or uploaded from a CSV the office exported (match on email or a `Signify ID` column; `First/Middle/Last name` + `Suffix`, or one `Name` column written `Last, First Middle`; preview first, then apply re-analyses and writes in one transaction). Signify never connects to FACTS. The **display name** (`users.display_name`) is what apps show; `display_name_source` is `google` (sign-in keeps updating it, as before), `school` or `self`, and sign-in leaves the last two alone. `tenants.settings.names.self_display` lets people choose their own (Overview card, `PUT /api/admin/me/name`); a CSV nickname never overrides a self-chosen name. Every change is in `name_changes`. Claims: `name` = display name, `given_name`/`family_name`/`middle_name` = official if set else Google's, plus `official_name` (bool). `/api/v1/classes/:id/members` gives staff `official_name` ({given, middle, family, suffix} or null); classmates get display names only. `users.given_name/family_name` still hold what Google said.
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
