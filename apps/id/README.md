# Signify ID

Central identity, roles and roster for the Signify classroom apps.

One Google sign-in, one place to approve or block a person, one audit trail.
Apps become standard OpenID Connect clients, so adding the next one is a
registration plus a copied file — not another authentication system.

```
                    ┌──────────────────────────┐
   Google  ────────▶│        Signify ID        │
   sign-in          │  people · roles · roster │
                    │  audit · retention       │
                    └────────────┬─────────────┘
                     OIDC (code + PKCE, RS256)
          ┌──────────────┬───────┴───────┬──────────────┐
          ▼              ▼               ▼              ▼
     Whiteboard       Atlas       Times Tables      (next app)
```

## What it holds

| Concept | Meaning |
|---|---|
| **Tenant** | A school. People, roles, classes and audit are separated by tenant; nothing crosses between them. |
| **User** | A person, identified by an internal uuid — never by email address. |
| **Identity** | One external login (`google` + that account's immutable `sub`). Adding another provider later means another row type, not a migration. |
| **Membership** | A user's role *in one school*. The same person can be a teacher at one and a guardian at another. |
| **Role** | A named set of permissions. Five built in, plus custom roles per school. |
| **Permission** | `namespace:verb` at a scope of `own` / `class` / `tenant` / `global`. |
| **App** | A registered OAuth client with its own permission namespace. |

### Built-in roles

| Role | Reach |
|---|---|
| Student | No permissions at all. Access to their own work comes from ownership inside each app. |
| Parent or guardian | Inspect and request correction of their own children's records (FERPA). |
| Support staff | Sees the roster. Not student work, not grades. |
| Teacher | Teaches and grades **their own classes**. |
| Local admin | Administers one school: people, classes, roles, audit, exports, erasures. |
| Super admin | Everything, everywhere. Lives in its own table so no school-level admin can ever grant it. |

Custom roles are per-school and can only be created by someone who already
holds the permissions being granted, at no wider a scope. A teacher cannot
mint a "Teacher Plus" role that manages users.

## Running it locally

No Postgres needed — the dev server runs an in-process one and reseeds each
time.

```bash
cd signify-id && npm install && node test/dev-server.js
```

Then open http://localhost:3010 and sign in as `desmond@signify.one`.
Developer sign-in accepts any address without proof and refuses to start in
any hosted environment.

Run the test suite:

```bash
npm test
```

## Deploying

1. Create a Railway service from this directory and attach a Postgres database.
2. Set the environment variables (see `.env.example`):

   | Variable | Notes |
   |---|---|
   | `DATABASE_URL` | Railway provides this when Postgres is attached. |
   | `GOOGLE_CLIENT_ID` | One Web-application client for the whole fleet. |
   | `ISSUER` | Exactly `https://id.signify.one`. It goes into every token. |
   | `SUPER_ADMINS` | Comma-separated. **Set at least two.** |
   | `COOKIE_SECRET` | `openssl rand -hex 32`. Without it, every restart signs everyone out. |
   | `RETENTION_DAYS` | Platform default; a school may set its own. |

3. In Google Cloud, add `https://id.signify.one` as an authorised JavaScript
   origin on that client.
4. Deploy. Migrations and built-in roles run automatically at boot.
5. Sign in, then: create the school → add its email domains → record the
   school authorization on the Compliance page → register each app.

## Adding an app

1. **Applications → Register an app.** Give it a name, a permission namespace
   (`atlas`, `timestables`, …) and its redirect address
   (`https://your-app/auth/callback`). Copy the secret — it is shown once.
2. **Applications → Schools** and tick the schools allowed to use it.
3. Add the app's permissions to `src/rbac.js` under a new `CATALOG` block, and
   to whichever built-in roles should hold them. They reach every school's
   roles on the next deploy.
4. Copy `client/signify-auth.js` into the app and set:

   ```
   SIGNIFY_ISSUER=https://id.signify.one
   SIGNIFY_CLIENT_ID=…
   SIGNIFY_CLIENT_SECRET=…
   SIGNIFY_REDIRECT_URI=https://your-app/auth/callback
   SIGNIFY_COOKIE_SECRET=$(openssl rand -hex 32)
   ```

5. Wire it up:

   ```js
   const signify = require('./signify-auth');
   signify.mount(app);            // /auth/login, /auth/callback, /auth/logout, /auth/me
   app.use(signify.middleware);   // sets req.user

   app.get('/api/my-work', signify.requireUser, handler);
   app.post('/api/grade', signify.requirePerm('atlas:grade', 'class'), handler);
   ```

   `req.user` carries `id`, `email`, `name`, `role`, `perms`, `tenantId`,
   `isMinor` and `isSuper`. Store `req.user.id` as the owner of anything the
   app saves — never the email address.

## Importing a roster

**People → Import CSV.** Columns are matched by heading, however they are
spelled — `First Name`, `first_name` and `Given name` all work.

| Column | Notes |
|---|---|
| First name, Last name | Optional. Google's own name wins once they sign in. |
| **Email address** | The only required column. It identifies the person. |
| Role | Defaults to student. Matched on label or key. |
| School ID | Optional. A local admin's rows must match their own school, or the row is refused rather than silently retargeted. |
| Classes | `3B Maths; 4A Geography` — semicolons, commas or pipes. |
| Apps | Only apps the school has switched on. |
| Graduation year | Stable across years, unlike year group. |

Nothing is written until you have seen the preview: every row is shown as
add / update / skip, with the reason for each refusal. One bad line never
blocks the rest of the file, and re-importing the same file updates rather
than duplicating.

An import can never do what the person running it could not do by hand —
role assignment goes through the same guard as the console's role picker.

## Backups

**Backups → Download a backup** produces one school's roster and settings as a
signed JSON file. It carries no passwords, sessions, tokens or keys, but it
does carry every pupil's name and email, so taking one is logged as a
disclosure.

Restore is deliberately hard to misuse:

- Every backup is **HMAC-signed**. A hand-edited file is refused outright,
  which is what stops restore being an arbitrary-write primitive against the
  identity store.
- It must match **this service** and **this school**.
- It is **merge-only** — creates and updates, never deletes. An old backup
  cannot wipe out newer work.
- **An erasure always wins.** Somebody erased after the backup was taken is
  never resurrected by restoring it.
- Anything the operator could not do by hand is refused row by row, so a
  validly signed file still cannot grant an administrative role.
- A **snapshot of the current state is taken first** and kept for 30 days as
  an undo. That snapshot is the only backup stored server-side; downloaded
  ones leave with the person who downloaded them.

## Problem reports

Every app that carries the shared switcher (`client/signify-switcher.js`) gets
a **Report a problem** link at the foot of its panel. It opens a short form —
*something isn't working*, *something is wrong*, or *something else* — and
posts it to the app's own `/auth/report`, which `client/signify-auth.js`
forwards here with the person's token. Signify ID reads who sent it, their
school and the app off that token, never off the request body.

With **Include technical details** left ticked, a report also carries the page
address (query string stripped, because that is where join codes live), the
browser, screen size, language and time zone, any text the person had
highlighted, and the last ten script errors on the page.

They land on the console's **Problem reports** page: every school's for a
super admin, their own school's for anyone holding `core:triage_reports`
(local admins, by default). Closed reports are erased 180 days after closing,
any report at the retention limit, and all of a person's reports with their
account.

An app can open the same form from its own help menu:

```js
SignifyReport.open();            // let the person choose
SignifyReport.open('mistake');   // start on "something is wrong"
```

## Off-site database backups

Not the per-school backups above: this is the disaster copy. Once a day the
maintenance sweep exports every table — except sessions, sign-in codes,
refresh tokens and the **signing keys**, which a stolen backup must never
carry — encrypts it, and puts it in its own R2 bucket as
`id/backup-YYYY-MM-DD.json.gz.enc`. Backups older than 28 days are removed,
both by the service and by the bucket's lifecycle rule, so the privacy
policy's "deleted records leave backups within 30 days" holds even while the
service is down.

Every permanent erasure also leaves a **tombstone** in the bucket
(`id/erasures/<account id>`, nothing else), and a restore re-applies them, so
an erased person is never brought back by loading an older backup.

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID`, `R2_BUCKET` | The account and `signify-id-backups`, a bucket for this service alone |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | An R2 token with **Object Read & Write** on that one bucket |
| `BACKUP_ENCRYPTION_KEY` | `openssl rand -hex 32`. Keep a copy in the password manager — without it the backups cannot be opened. Nothing is sent until it is set. |

**Restoring** — into a new, empty database only; it refuses one with accounts
in it. Download the newest `.enc` file from the bucket, then:

```bash
read -rs BACKUP_ENCRYPTION_KEY && export BACKUP_ENCRYPTION_KEY
DATABASE_URL=<new database> R2_ACCOUNT_ID=… R2_BUCKET=signify-id-backups \
R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… npm run restore-db -- backup-YYYY-MM-DD.json.gz.enc
```

It runs the migrations, loads every table, re-applies the tombstones, checks
the row counts, and prints them. Point `DATABASE_URL` at the new database and
redeploy; everybody signs in again, because sessions and signing keys were
never in the backup and a fresh key is made on first start.

## Endpoints

| Path | For |
|---|---|
| `/.well-known/openid-configuration`, `/.well-known/jwks.json` | Discovery and public keys |
| `/authorize`, `/token`, `/userinfo`, `/revoke`, `/logout` | OIDC |
| `/signin` | The page people see |
| `/admin` | The console |
| `/api/v1/me`, `/api/v1/classes`, `/api/v1/classes/:id/members`, `/api/v1/shares-class` | Roster questions an app asks |
| `/api/v1/reports` | A problem report, forwarded from an app's `/auth/report` |
| `/api/admin/reports`, `/api/admin/reports/:id`, `/api/admin/reports/new` | Triage in the console, and the console's own reports |
| `/api/admin/roster/preview`, `/api/admin/roster/apply` | CSV import |
| `/api/admin/backups`, `/api/admin/restore/preview`, `/api/admin/restore/apply` | Backup and restore |
| `/healthz` | Liveness |

## Design decisions worth knowing

**Users are keyed on Google's `sub`, not on email.** Schools recycle addresses.
When a new person signs in on an address that already belongs to a different
subject, the sign-in is **refused and audited** rather than merged — an
administrator releases the address, which archives the previous record instead
of handing it over.

**Sessions are rows.** Blocking an account ends every live session in every
app immediately, rather than whenever a self-contained token happens to
expire. Access tokens last ten minutes and are re-checked against the session
on every `/userinfo` and every refresh.

**Using an app counts as using the session.** Every session runs two clocks:
an absolute cap, and an idle window that a shared classroom tablet depends on.
Only this service's own pages used to slide the idle one, which meant a
teacher working all morning in Teacher's Desk — and never opening `id` itself
— was timed out behind their own back: the service API refused their roster
questions for idleness while the refresh grant, which checked neither clock,
went on issuing them fresh ID tokens. Signed in over there, over here not.
`sessions.slide()` is now the one rule, and the service API, `/userinfo` and
the refresh grant all ask it — so activity in any app keeps the session alive,
and a session that has genuinely gone idle ends everywhere at once instead of
half-working.

**Claims are filtered per app.** An app receives `core:` permissions plus its
own namespace and nothing else, so a central directory does not quietly become
a cross-app profile of a child.

**Refresh tokens rotate, and re-use is treated as theft** — presenting a
rotated token revokes the entire session. With one exception, learned the hard
way: a browser opening a page fires half a dozen requests at once, and when
the ID token has expired every one of them renews it. Those arrive holding the
*same* token, milliseconds apart, and treating the second as a stolen token
destroyed a teacher's session mid-lesson — twice in one afternoon, in the
audit log, before anybody understood why the class lists kept vanishing.

So an exchange is now single-flight: every request holding a given token
awaits the same one, and the answer is shared for two seconds afterwards, so
whichever `Set-Cookie` the browser happens to keep is a live one. Across
instances the row is claimed under `SELECT … FOR UPDATE`, and a token
presented within that same two-second window is refused for that one exchange
rather than treated as theft — never revoking a session over a rotation that
happened moments ago. Past the window it is theft again, and the session goes.
`client/signify-auth.js` coalesces its renewals too: the request that is never
sent is the one that cannot go wrong.

**Minor status is asserted by the school**, from a tenant-level setting, and is
never asked of a child. It drives shorter idle timeouts and stricter handling.

## Privacy policy

The published policy lives at `/privacy-policy`. It is generated from
`src/policy.js` (prose and scope) and `src/data-inventory.js` (what is
collected) — never hand-maintained alongside the schema.

`npm test` fails if any database column is not classified in the inventory, so
a new field cannot ship without somebody saying what it holds and who sees it.
See [docs/BUILDING-COMPLIANTLY.md](docs/BUILDING-COMPLIANTLY.md).

See [docs/COMPLIANCE.md](docs/COMPLIANCE.md) for the COPPA and FERPA posture,
and [docs/BLIND-SPOTS.md](docs/BLIND-SPOTS.md) for what is still open.
