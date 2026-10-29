# Signify platform monorepo

One private repo (`github.com/d2suarez/signify`) for the Signify apps and the code they will share. Created 2026-10-12 by moving three repos in **with full history**. It was a move, not a rewrite: the apps behave exactly as before. Plan and context: `signify-learning/PLAN.md` (planning folder, not in this repo).

## Layout
```
apps/id/         Signify ID: identity, roles, rosters (OIDC + Postgres). id.signify.one   (was signify-id)
apps/desk/       Teacher's Desk: classroom tool board. desk.signify.one                  (was teachers-desk)
apps/boards/     Signify Boards: real-time whiteboard. draw.signify.one                   (was classroom-whiteboard)
apps/helpdesk/   Signify Help Desk: tickets + project planning (Next.js + SQLite). help.signify.one (not yet deployed)
apps/learning/   Signify Learning: the LMS (Next.js + Postgres/PGlite + socket.io). Local only, not deployed
packages/auth/   signify-auth.js, the Signify ID client. NOT yet used by the apps
packages/design/ Signify design tokens (CSS). NOT yet used by anything
```
Each app keeps its own `CLAUDE.md` (run, test, traps, rules): **read it before changing that app.**

Not in this repo, on purpose: classroom-atlas, bible-app (Lectern), times-tables, oust (own repos for now). **patterson-nominations must never join this repo**: it is a church project, kept fully separate.

## Install, run, test
Node lives at `~/.local/node/bin` (no system Node). `export PATH=$HOME/.local/node/bin:$PATH`.
- Install each app on its own: `cd apps/<app> && npm ci --no-workspaces`. (Apps deploy self-contained and have their own lockfiles; there is no root lockfile.)
- Test one app: `cd apps/<app> && npm test`. Expected: id 556 passed; desk 302 checks + 22 backup checks; boards 17 + 10; learning 20.
- Run: see each app's CLAUDE.md (`npm run dev` for desk, `node test/dev-server.js` for id, launch configs for boards, `npm run build && npm run local` for learning).
- `npm test` at the root runs every workspace's tests (needs each app installed first).

## Deploy (Railway)
Each app is its own Railway project, deployed from its own folder. **Run `railway up` from inside `apps/<app>`**; Railway refuses paths outside the linked folder, and an app uploads only its own folder, so **apps must stay self-contained** (do not import from `../../packages/*` until a build step exists).
| App | Railway project | Command (from the app folder) |
|---|---|---|
| desk | `teachers-desk` | `railway up --detach` |
| boards | `classroom-whiteboard` | `railway up --detach` |
| id | `signify-id` | `railway up --detach` (check `railway config plan` first; it is not app-sleeping) |
Use `--project/--environment/--service` if the folder is not linked. Never touch volumes, variables or domains in a routine deploy. After deploying, check the live site, `/healthz`, and sign-in through Signify ID. `railway up` can fail transiently with upload status 500; retry in ~5 minutes.
**Sabbath:** no deploys from Friday sunset to Saturday sunset, and none in school hours (deploy evenings and weekends).

## Rules across apps
- `signify-auth.js` is one file copied into id (`client/`), desk, boards and helpdesk. It was identical in all three at the move (and equals `packages/auth`). Never fork it in one app; fix it in all, then in `packages/auth`.
- The old repos (`signify-id`, `teachers-desk`, `classroom-whiteboard`) are left as they were. Do not delete them; Desmond archives them read-only after a week of normal use. New work goes here.

## Follow-ups (deferred)
- Switch apps to `packages/auth` (and fold Desk's stale-token fix from `apps/desk/server.js` into it): see `packages/auth/README.md`.
- Switch apps to `packages/design`.
- Extract Desk widgets into `packages/tools`.
- Rename Boards' UI and domain to Signify Boards (boards.signify.one).
- Move working copies out of Google Drive (done for this repo: it lives at `~/code/signify`).
