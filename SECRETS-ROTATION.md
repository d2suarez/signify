# Secret rotation after the Railway breach (21 Oct 2026)

Railway says someone may have read the environment variables (the saved
settings holding passwords and keys) of its customers' apps. Its advice:
change every secret stored there. This list was made by reading which
settings each app's code uses. Values were not read.

**A changed value only takes effect when the app is redeployed, and Railway
has deploys paused.** So: make new keys now where you can, save them in
Railway when its dashboard works again, and redeploy once builds are back.

Make a new random secret with:

```bash
openssl rand -base64 48
```

## 1. Outside services: these were real passwords. Do these first.

| Secret | App | Where to make a new one |
|---|---|---|
| `SMTP_*`, `IMAP_*`, `TWILIO_*` | Help Desk | **Nothing to rotate.** The mailbox password was revoked months ago and Twilio was never set up. If old values are still in Railway, delete them. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Desk, Boards, Maps, ID | Probably never added (off-site backup setup still pending). If any are in Railway: Cloudflare → R2 → Manage API tokens, make a new one, delete the old one |
| `CARTO_KEY` | Maps | carto.com/basemaps/apikey: get a new free key. Low risk: the worst case is someone using up the map-tile allowance |
| `DATABASE_URL` (Postgres password) | Signify ID | Railway's guide (blog.railway.com, "Rotate PostgreSQL Database Credentials"): Postgres service → Database → Config → **Regenerate** password, then redeploy ID. Never edit the password variables by hand. First, under Settings → Networking, turn **Public Access off** if it is on |

## 2. Sign-in between Signify apps

Each app has its own secret for signing in through Signify ID
(`SIGNIFY_CLIENT_SECRET`). Change it in ID and in the app **at the same
time**. If they don't match, sign-in breaks for that app.

For each of Desk, Boards, Maps, Help Desk:

```bash
railway ssh --service signify-id "node src/register-app.js <app> --rotate"
```

Then paste the printed secret into that app's `SIGNIFY_CLIENT_SECRET`.

The Google sign-in itself uses no secret, only the public client ID.
Nothing to change there.

## 3. Secrets the apps made up themselves. Just replace them.

| Secret | Apps | What happens when it changes |
|---|---|---|
| `SIGNIFY_COOKIE_SECRET` / `COOKIE_SECRET` | ID, Desk, Boards, Maps, Help Desk | Everyone is signed out once. Do it after school. |
| `VAPID_PRIVATE_KEY` + `VAPID_PUBLIC_KEY` | Help Desk | Make them as a new pair. Phones have to allow notifications again. |
| `ADMIN_KEY` | Times Tables | The new key is needed for the admin page. |
| `BACKUP_ENCRYPTION_KEY` | ID, Desk, Boards, Maps | No backups have been sent yet (no R2 keys), so the old key can simply be replaced. |

## 4. Redeploy and check

Once Railway builds are back: redeploy ID first, then Desk (this also takes
live the pending passage-grader update, 87a054d), Boards, Maps and Help
Desk. Sign in to each one to check it works. Also look over each app's
recent logs in Railway for anything unusual since 20 Oct.

Not affected: Bible (Lectern) and Oust keep no secrets in Railway. The
api.bible key is in Lectern's page code, not in Railway.
