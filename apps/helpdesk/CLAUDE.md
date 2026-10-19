# Signify Help Desk

Help desk + project planning for the school, at https://help.signify.one (not deployed yet as of 2026-10-18). Next.js 16 (App Router) + Prisma/SQLite, behind a thin Express server (`server.js`) that does sign-in through Signify ID. Brought back 2026-10-18 from the retired `helpdesk/` app (copied without its git history: that history holds a Google OAuth client secret).

This is NOT the Next.js in your training data. Read `node_modules/next/dist/docs/` before using an unfamiliar API.

## Run / test / deploy
- `npm run build` then `npm run local` (port 3110, `HELPDESK_DEV_USER=admin`, refuses to start on Railway). Switch who you are with `/dev/as/admin|agent|staff|student`. Launch config `signify-helpdesk`. Turbopack `next dev` has panicked under the preview sandbox before; build + `local` is the reliable path.
- Type-check: `./node_modules/.bin/tsc --noEmit` (`npx tsc` resolves to the wrong package from inside the monorepo).
- No automated test suite yet.
- Deploy: own Railway project, volume at `/data`, `DATABASE_URL=file:/data/helpdesk.db`, `UPLOAD_DIR=/data/uploads`. `npm start` runs `prisma db push` then `node server.js`. Variables in `.env.example`.

## Sign-in (Signify ID)
- `server.js` mounts `signify-auth.js` (verbatim fleet copy; never fork it), then passes `req.user` to Next as base64url JSON on the `x-signify-user` header. Any incoming copy of that header is deleted first. `src/lib/auth.ts` reads it.
- `server.js` also merges later `Set-Cookie` writes instead of replacing them: Next's own cookie (language toggle) would otherwise overwrite a just-renewed refresh token, and a spent refresh token ends the session fleet-wide.
- Roles come from Signify ID permissions declared on boot: `helpdesk:admin` → ADMIN, `helpdesk:agent` → TECH, Signify role `student` → STUDENT, else STAFF. Nothing is granted until an ID admin adds those permissions to a role.
- Local `User` rows are keyed on `signifyId` (the Signify uuid), refreshed each visit. A row with this address but a different `signifyId` is released (address renamed), never merged. A row with no `signifyId` (a project placeholder added by email) is claimed by the first sign-in with that address.
- `HELPDESK_TENANT_ID` (optional) limits the app to one school.

## Projects
- `src/lib/projects.ts` (access rules), `src/lib/project-actions.ts` (server actions), `src/app/projects/*`, `src/components/projects/*`.
- Anyone signed in can start one. Members are LEAD / EDITOR ("Helper") / VIEWER ("Watching"); the owner is always a lead. Visibility MEMBERS or SCHOOL (anyone in the same tenant can look). Help desk ADMINs see and manage every project, on purpose: projects mix staff and students.
- Adding people: search covers only people who have opened the help desk (same tenant). Anyone else is added by full school address (same domain as the adder unless ADMIN), which creates a placeholder row.
- Tickets can be linked to a project from the agent ticket page.

## Desk ticket box
- `src/app/api/desk/me` and `/api/desk/tickets`, called by `apps/desk/public/js/widgets/helpdesk.js` from desk.signify.one with `credentials: 'include'`. Same site, so the help desk's own cookie goes along. CORS for `/api/desk` is in `server.js`, limited to `DESK_ORIGINS`.
- First use: the widget opens `/desk-connect` in a popup; signing in there sets the cookie, and the page posts `signify-helpdesk-connected` to the opener and closes.

## Design
Signify tokens in `src/app/globals.css`: Bricolage Grotesque, IBM Plex Sans/Mono (self-hosted in `public/vendor`), p1–p4 block colours with shapes, warm neutrals, paper shadows, dark mode by `prefers-color-scheme`. Tailwind's slate/blue/red/amber/green scales are remapped onto those tokens, so existing utility classes inherit the look. No emoji; categories carry shapes (Technology blue square, Maintenance red circle, Other teal arch).

## Email
Gmail-API sending was removed with the Google OAuth client. Mail is SMTP-only and Railway Hobby blocks SMTP, so in production notifications go by push (VAPID) only.
