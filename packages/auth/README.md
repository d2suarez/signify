# @signify/auth

`signify-auth.js` is the Signify ID client that every app copies into its own folder. It is byte-identical to `apps/id/client/signify-auth.js` and to the copies in `apps/desk` and `apps/boards` (checked at the move, 2026-10-12). **No app uses this package yet; each still carries its own copy.**

## Desk's stale-token handling (not yet in the shared client)
Desk works around two gaps in the client with code in `apps/desk/server.js`, not in `signify-auth.js`:
1. A middleware after `signify.middleware` reads the renewed `sfy_id` out of the response's `Set-Cookie` and sets `req.signifyToken`, so later roster lookups in the same request do not use the expired token.
2. `endStaleSession` clears `sfy_id` / `sfy_rt` and answers 401 when `req.signifyExpired` is set (Signify ID no longer recognises the session).

When the apps switch to this package, fold both into the client (renewed token on `req`, and a stale-session hook), then delete the copies. That is a follow-up, with tests in all three apps.
