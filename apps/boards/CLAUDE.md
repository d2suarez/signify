# Classroom Whiteboard ("Signify Learning")

Real-time classroom whiteboard: Fabric.js canvas, Socket.IO rooms, per-student boards, PDF/document pages, assignments, polls, embeds. Express server, vanilla JS. Live at https://draw.signify.one (old Railway URL redirects). Directory and Railway project are still named `classroom-whiteboard`. Signs in through Signify ID. Very long history is in the `classroom-whiteboard-deployment` memory file; grep it rather than reading it whole.

## Run / test / deploy
- `npm start`; `npm test` (offsite and teaching tests).
- Safe local test: launch config `whiteboard-open` (port 3231, open mode, `DATA_DIR` under /private/tmp). The `whiteboard` launch entry uses PROD env; avoid it for tests. With real sign-in use `id-dev-wb` + `whiteboard-id`.
- Deploy: Railway project `classroom-whiteboard`, volume `/var/data`. `railway up --detach` from this folder.
- Admin tools now live in the Signify ID console (`/admin` redirects there). `/api/admin/*` accepts only the console's `app_admin` bearer token.

## Architecture
- Boards are standalone files `board-<id>.json` on the volume, with big images externalised to content-addressed `blob-<sha256>` files. Always read via `readBoardJSON` (rehydrates) and write via dehydrate; stored form holds only `blob:` refs.
- Writes are atomic (tmp then rename). Startup recovers corrupt boards from the newest history snapshot.
- Object-level sync: client ops `{add|mod|del|clear|full}` through `board:ops`. Reconnect pulls the server copy unless local changes are dirty and not loading.
- Rooms: join codes are separate from room ids. Teacher check on join: owner, co-teacher (`isRoomTeacher`) or `manage_boards`. Classes come from Signify ID (`idclasses.js`, teacher's own token).
- Feature switches per domain, room and student; enforced server-side as well as in the UI.

## Rules
- Content viewing is domain-scoped (`canViewBoard`), including for the super admin.
- Never put client-supplied data (thumbs, titles) into `innerHTML`. Reject `__proto__`/`constructor`/`prototype` keys (`isSafeKey`).
- The CSP needs both `unsafe-inline` and `unsafe-eval`; Fabric breaks without `unsafe-eval`. Embeds (`/embed/*`) must stay iframe-able.
- Text tool font is Arial. Bricolage Grotesque drifts the caret about 5% in Fabric; keep it for UI and static labels only.
- Returned (graded) assignment boards are read-only for students on purpose.
- Verify with the user's exact repro or a recording before theorising. Their "new board shows old content" report had three different causes.

## Traps
- History and loading: undo stacks must reset per board (`wb.resetHistory()`); `clear()` must bump `_loadSeq`; reconnect must not push an empty or still-loading canvas as truth.
- Seed `i-text` objects need `styles: []` and `version` or Fabric's enliven throws.
- `window.socket` is module-scoped; in tests use DOM observers. Fabric ignores synthetic pointer events: call `wb` methods directly via a temporary `window.__wb` hook and remove it before deploy (`grep __wb`).
- Preview tabs need `resize_window` after navigate. Enter boards directly via `/board.html?role=teacher|student&name=X&room=CODE`.
- PDF render must use `intent: 'print'` (display intent hangs in background tabs).
- Volume is tight (under about 700MB free); the disk watch warns hourly. Enlarge the volume if it recurs.
- Google Classroom import is shipped but unverified; it needs the user's Google Cloud setup (Classroom API, 3 scopes).
- Production reads over `railway ssh` can be blocked by the permission classifier even after chat approval.
- `signify-auth.js` is shared verbatim across the fleet; never fork it.
