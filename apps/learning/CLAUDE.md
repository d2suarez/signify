# Signify Learning

The LMS. A lesson is a list of **blocks** that is at once the plan, the live presentation and the student view. Planning, decisions and roadmap: `signify-learning/PLAN.md` in the Google Drive planning folder (not in this repo). Read it before adding features.

Started 2026-10-28. **Not deployed.** Next.js 16 (App Router, React 19, TypeScript) behind a thin Express `server.js`; Postgres in production, PGlite (Postgres in WebAssembly) locally and in tests; socket.io for live lessons.

This is NOT the Next.js in your training data: params are Promises, etc. Read `node_modules/next/dist/docs/` before using an unfamiliar API.

## Run / test
- `export PATH=$HOME/.local/node/bin:$PATH`; install with `npm ci --no-workspaces`.
- `npm run build` then `npm run local` (port 3120, made-up teacher, refuses to start on Railway). Switch person with `/dev/as/teacher` or `/dev/as/student` (a cookie, so it switches every tab in that browser; an already-connected live socket keeps its ticket). Launch config `signify-learning` in the Drive folder's `.claude/launch.json`. Local data lives in `data/pglite` (gitignored); delete it to start fresh.
- `npm test` (tsx + node:test): blocks, courses, lessons (versions, conflicts, school isolation) on in-memory PGlite, plus real socket.io round trips for live lessons. 20 tests.
- Type-check: `./node_modules/.bin/tsc --noEmit`.

## Shape
- `server.js`: sign-in via `signify-auth.js` (verbatim fleet copy, never fork), dev people, passes the person to Next on `x-signify-user` and the token valid for this request on `x-signify-token` (both deleted from incoming requests first). Merges later Set-Cookie writes (same reason as the Help Desk). Attaches `live.js`.
- `live.js`: live lessons over socket.io at path `/live`. One session per course, in memory on `globalThis.__learningLive` (Next reads it in the same process to know which lesson is live). The teacher's screen is the truth; state is sent absolute and in full on every connect. Students see counts only when revealed, never names or who answered what.
- **Live tickets** (`src/lib/live-ticket.ts`): Next decides who may teach or follow a course and signs an HMAC ticket (12 h; secret made at boot in `LEARNING_LIVE_SECRET`). `live.js` checks the signature AND that the ticket's `sub` matches the Signify session on the socket. A teacher ticket names the one lesson it may present.
- `src/lib/db.ts`: `getDb()` singleton on globalThis; `tx()` runs on ONE connection (pool BEGIN/COMMIT as separate queries is no transaction). Migrations in `migrations/NNN_*.sql`, applied on first use.
- `src/lib/roster.ts`: classes and members from Signify ID `/api/v1/classes` with the person's own token; cached a minute; a failure is never cached and never shown as "no classes".
- `src/lib/courses.ts`: one course per ID class. Teachers' classes become courses on sight; students only see courses a teacher has opened. Role is re-derived from live ID classes every request.
- `src/lib/lessons.ts`: every save names `baseVersion`; a stale save is refused (409), never written over. Each change first copies the previous state into `lesson_versions` (newest 50 kept). Restore is a new save, so it can be undone.
- `src/lib/blocks.ts`: block types `text`, `poll`, `timer`; `normalizeBlocks` is the only way in (drops unknown types, caps sizes, fixes ids). `forStudent` strips poll answer keys.
- `src/lib/i18n.ts`: every UI string, English + Spanish (falls back to English).

## Rules
- Every table has `tenant_id`, from the signed-in person's claims, never from a request body; every query filters on it.
- People are never stored here: Signify ID is the authority, asked live.
- New block types: add to `blocks.ts` (type, `newBlock`, `normalizeBlocks`, `forStudent` if it holds anything secret), the editor's `BlockFields`, and `Stage` in `Presenter.tsx`; add tests.
- Design: Signify tokens in `src/app/globals.css` (Bricolage Grotesque + IBM Plex, self-hosted; four block colours each with one shape). Block kinds: content = teal arch, poll/question = yellow triangle, timer = red circle.

## Not built yet (see PLAN.md)
Courses' units, assignments, gradebook, FACTS export, LTI, UDL supports beyond text size, Desk tools as blocks, Boards block, Railway deploy, Redis for several processes.
