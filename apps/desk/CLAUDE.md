# Teacher's Desk

Classroom tools board (timers, seating, randomiser, notes, passage grader, ~26 widgets). Express + vanilla JS, UI rendered into `#app`. Live at https://desk.signify.one. Relying party of Signify ID (client_id `teachers-desk`, namespace `desk`). The user uses it in class daily. Fuller history is in the `teachers-desk` memory file; read it before deep changes.

## Run / test / deploy
- `npm run dev` (port 8770, `DESK_DEV_USER=1`; refuses to start on a hosted environment). Guest-mode check: launch config `teachers-desk-guest` (port 8771).
- `npm test` (about 164 checks, no server or DB needed).
- Deploy: Railway project `teachers-desk`, volume `/var/data`. Run `railway up --detach` from this folder. Healthcheck and sleepApplication must be set via the Railway GraphQL API, not `railway.json`.
- `signify-auth.js` is copied verbatim into every fleet app. Never fork it; work around gaps locally.

## Adding a widget
`Desk.widget({...})` in `public/js/registry.js`, one file in `public/js/widgets/`, one `<script>` line in `index.html`. No server change. Declare `category` (`time|class|board|calm|other`). Widgets are locked for guests unless `guest: true`; only opt in if the widget holds nothing about pupils and makes no API call.
**Students:** a widget is off for students unless it has `students: true`. Never add that to a new widget without asking Desmond first. `test/run.js` ("students get exactly these tools by default") lists them on purpose. Schools change it per role in Signify ID, Tools by role (`server/tools.js` reads the widget files at boot and declares them; `server/policy.js` fetches the school's choice into `req.deskTools`; routes behind a tool use `auth.requireTool`). Students open the desk without `desk:use` (the Student role holds no permissions); turning every tool off for students closes it to them. Try it as a student with `DESK_DEV_ROLE=student` (launch config `signify-desk-student`, port 8774).
To announce it under "Add a tool" for 45 days: `added: 'YYYY-MM-DD'` + `news: '...'` on the definition, and a ~720px card screenshot at `public/img/new/<type>.png` (README, "Announcing a tool").

## Schoology (LTI 1.3)
`server/lti.js`, `public/lti/`, `public/js/lti-boot.js`, `test/lti.js`; README "Schoology (LTI 1.3)" has the registration values. A student launched from Schoology gets their own blank desk under `lti_<hash>` (no name, no email, no raw Schoology id: a test reads desk.json to check). Tools = no-account (`guest: true`) tools ∩ the school's Student column (`LTI_TENANT_ID`) ∩ the teacher's per-course ticks. The LTI header (`x-desk-lti`) overrides any Signify cookie; `API_ALLOWED` in lti.js whitelists the routes an LTI desk may call. Opens in a new window: never make the desk itself frameable. Off until `LTI_CLIENT_ID` is set. Try it with launch config `desk-lti-dev` (mock Schoology on 8798).

## Framed by Signify Learning (/embed)
`public/embed.html` + `public/js/embed.js`, route `/embed` in `server.js` (frame-ancestors = `EMBED_FRAME_ORIGINS`, default `https://learn.signify.one`, plus localhost:3120/3121/3127 when not on Railway; no X-Frame-Options there only). Learning's left rail frames `/embed?tools=clock,timer&class=<Signify class id>&from=<origin>`: the person's REAL cards, one per type (the first on their desk, else a new card set down BELOW everything, never moving one), stacked, via `Desk.board.init({ only, classKey, parentOrigin })` (`board.shown`). No move/resize/colour/remove there; each card has the desk mark (opens `/` in a new window) and Open larger. Saves are the normal rev-checked board save, so the frame is just another tab (409 = reload). It posts `{desk:1,height}` and `{desk:1,stage}` only to `from` when that is an allowed origin. Not signed in: a note with a Sign in link in a new window (ID can't be framed). `render()` reuses a card's node while it is open larger (a resize then used to draw a second copy).

## Seating plans for Signify Learning (/api/learning)
`server/learning.js`, routes `GET/PUT /api/learning/seating/:classId` in `server.js`, tests `test/learning.js` (own file: it stubs global fetch, which run.js's concurrent async checks would race). Learning's lesson slide shows the teacher's OWN seating plan for a Signify class and moves seats back here (Desmond 2026-11-22: one chart per class, shared both ways). Only Learning's SERVER calls it, with the teacher's Signify ID token: `learning.bearer` (mounted on `/api/learning` before the tool policy) verifies it like signify-auth but with audience `LEARNING_CLIENT_IDS` (default `signify-learning`), sets `req.user` with `vouchedBy` and empty perms, and `req.signifyToken` so roster.js asks ID as that person. Routes then require `vouchedBy` (a browser cookie is 401), not a student, `deskTools.has('seating')`, the class in `roster.classesFor` as teacher/aide/admin (ID down = 502, never "not yours"), and the class's members (silence = 502). GET serves the first seating card with desks for `signify:<id>`, drawn by the widget itself (`_drawPlan`: room size, flipped, seats in cells; `server/tools.js` keeps each widget's raw definition in `RAW` and gives the sandbox a real `clamp`), seats naming only pupils still in the class, plus `pupils` with the chairs' `_shortNames`. PUT `{widgetId, rev, pupil, seat|null}` = tap-then-seat (swap seat to seat, else the displaced pupil is unseated) through `board.saveBoard` (rev-checked, so lost-seat history applies and an open desk tab 409s and reloads); stale rev = 409 with the current chart. Never copy the geometry into Learning: it draws what this returns.

## Help desk widget
`public/js/widgets/helpdesk.js` talks straight to the Signify Help Desk (`HELPDESK_URL`, default https://help.signify.one; http://localhost:3110 locally) with `credentials: 'include'`. The desk server is not involved; the origin is in `/api/config` (`helpDeskUrl`) and in CSP `connect-src`. See `apps/helpdesk/CLAUDE.md`.

## Bible widget
`public/js/widgets/bible.js` + `server/bible.js` + `public/js/bible-books.js` (shared book table/parser). Signed-in only, students too (`requireTool('bible')`); keys `ESV_API_KEY` and `API_BIBLE_KEY` on the Railway service, free KJV/WEB without them. README "Bible".

## Rules that came from the user
- Cards never follow their content. Size is chosen once at add; content fits itself to the card.
- Floating/"bare" mode was removed on request. Do not reintroduce it, per-widget shapes, or anything reacting to plain hover.
- Fonts match Signify ID: Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono. A design handoff will say Archivo; flag the conflict instead of switching.
- Visitor data stays strictly separate from a signed-in desk: never merged automatically, tools only added below existing ones, visitors told their data is temporary.
- Teacher-private data (behaviour notes) must not reach paper or guests.

## Traps
- **Silence is not an empty class.** A refused roster lookup returns `[]`. Never prune saved seats/lists against it (`rosterKnown` guard). This wiped four classes once.
- **A widget can mount twice** (card, then expanded view). Any `load()` with more than one `await` needs `loadSeq` and locals, or it races itself (this caused the second seating wipe).
- Colour: every widget must look right in all four theme colours a teacher can pick, in light and dark. Follow DESIGN.md (tokens not literal colours, --alt1..3 for hues inside a card) and run test/colour-audit.browser.js before calling a widget done.
- `Object.assign(el.style, {'--x': 1})` silently drops custom properties; use `Desk.el` / `setProperty`.
- `aspect-ratio` loses to a flex-assigned height; use `flex: none` or px sizing from a ResizeObserver.
- `requestAnimationFrame` stops in background tabs; anything that must finish needs a timer too.
- Board save is debounced 700ms; wait about 1.5s before reloading a preview or it looks like data loss.
- Registering in Signify ID: pass `--client-id teachers-desk` explicitly or a second app is created.
- "Logged in but no data": check Railway logs for `refused (401)` and `lost seats` / `save refused` first.
