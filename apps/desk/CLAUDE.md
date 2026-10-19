# Teacher's Desk

Classroom tools board (timers, seating, randomiser, notes, passage grader, ~26 widgets). Express + vanilla JS, UI rendered into `#app`. Live at https://desk.signify.one. Relying party of Signify ID (client_id `teachers-desk`, namespace `desk`). The user uses it in class daily. Fuller history is in the `teachers-desk` memory file; read it before deep changes.

## Run / test / deploy
- `npm run dev` (port 8770, `DESK_DEV_USER=1`; refuses to start on a hosted environment). Guest-mode check: launch config `teachers-desk-guest` (port 8771).
- `npm test` (about 164 checks, no server or DB needed).
- Deploy: Railway project `teachers-desk`, volume `/var/data`. Run `railway up --detach` from this folder. Healthcheck and sleepApplication must be set via the Railway GraphQL API, not `railway.json`.
- `signify-auth.js` is copied verbatim into every fleet app. Never fork it; work around gaps locally.

## Adding a widget
`Desk.widget({...})` in `public/js/registry.js`, one file in `public/js/widgets/`, one `<script>` line in `index.html`. No server change. Declare `category` (`time|class|board|calm|other`). Widgets are locked for guests unless `guest: true`; only opt in if the widget holds nothing about pupils and makes no API call.
To announce it under "Add a tool" for 45 days: `added: 'YYYY-MM-DD'` + `news: '...'` on the definition, and a ~720px card screenshot at `public/img/new/<type>.png` (README, "Announcing a tool").

## Help desk widget
`public/js/widgets/helpdesk.js` talks straight to the Signify Help Desk (`HELPDESK_URL`, default https://help.signify.one; http://localhost:3110 locally) with `credentials: 'include'`. The desk server is not involved; the origin is in `/api/config` (`helpDeskUrl`) and in CSP `connect-src`. See `apps/helpdesk/CLAUDE.md`.

## Rules that came from the user
- Cards never follow their content. Size is chosen once at add; content fits itself to the card.
- Floating/"bare" mode was removed on request. Do not reintroduce it, per-widget shapes, or anything reacting to plain hover.
- Fonts match Signify ID: Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono. A design handoff will say Archivo; flag the conflict instead of switching.
- Visitor data stays strictly separate from a signed-in desk: never merged automatically, tools only added below existing ones, visitors told their data is temporary.
- Teacher-private data (behaviour notes) must not reach paper or guests.

## Traps
- **Silence is not an empty class.** A refused roster lookup returns `[]`. Never prune saved seats/lists against it (`rosterKnown` guard). This wiped four classes once.
- **A widget can mount twice** (card, then expanded view). Any `load()` with more than one `await` needs `loadSeq` and locals, or it races itself (this caused the second seating wipe).
- `Object.assign(el.style, {'--x': 1})` silently drops custom properties; use `Desk.el` / `setProperty`.
- `aspect-ratio` loses to a flex-assigned height; use `flex: none` or px sizing from a ResizeObserver.
- `requestAnimationFrame` stops in background tabs; anything that must finish needs a timer too.
- Board save is debounced 700ms; wait about 1.5s before reloading a preview or it looks like data loss.
- Registering in Signify ID: pass `--client-id teachers-desk` explicitly or a second app is created.
- "Logged in but no data": check Railway logs for `refused (401)` and `lost seats` / `save refused` first.
