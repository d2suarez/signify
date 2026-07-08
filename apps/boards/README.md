# Signify Learning

A real-time whiteboard for teachers and students. The teacher creates a room, students join with the room code, and the teacher sees every student's board live.

It runs in two modes:

- **Open mode** (no configuration) — anyone who can reach the server joins by typing a name. Good for local use on a classroom network.
- **Google sign-in mode** — set `GOOGLE_CLIENT_ID` and everyone must sign in with Google. Boards are keyed to verified accounts, so students can't impersonate each other. Access is managed from the **admin portal**.

## Admin portal

At **`/admin.html`** (link appears on the landing page for admins). The super admin is set by `SUPER_ADMINS` (default `desmond@signify.one`).

- **Users** — new sign-ins from unapproved domains wait here as *pending*; approve or block them, assign roles, or pre-add someone before their first sign-in. Blocking disconnects the user immediately.
- **Roles** (super admin only) — create custom roles and choose which permissions each role grants: *teach classes*, *manage users*, *view & delete boards*, *view live sessions*, *manage approved domains*. The built-in Teacher and Local admin roles can be re-permissioned; Student is the locked default. Deleting a custom role turns its users back into Students.
- **Domains** — approve email domains (e.g. your school's) so accounts on them are admitted automatically as students.
- **Live sessions** — everyone connected right now, with room, name, and role.
- **Boards** — every room with its saved boards; view any board full-size, delete a single board, or delete a whole room.

**Scoping:** anyone whose role grants *manage users* (e.g. local admins) can only see and manage accounts on **their own email domain** or accounts **they added themselves** — and never other admins or the super admin. They can only hand out roles that carry no admin permissions (Student, Teacher). Only the super admin manages roles, and domain management requires the *manage domains* permission. Everything is enforced server-side; role and access changes apply on the user's next connection (immediately when blocking).

## Running locally

```bash
cd classroom-whiteboard
node server.js
```

Open **http://localhost:3000** (Node.js lives at `~/.local/node/bin` on this machine if it's not on your PATH).

For same-network use, students open `http://YOUR-IP:3000` (find your IP in System Settings → Wi-Fi → Details).

## Live deployment

The app is deployed on Railway (project `classroom-whiteboard`, d2suarez's workspace):

**https://draw.signify.one** (custom domain) — also reachable at the Railway URL `https://classroom-whiteboard-production.up.railway.app`

Boards persist on a Railway volume mounted at `/var/data`. To redeploy after code changes:

```bash
cd classroom-whiteboard
PATH="$HOME/.local/node/bin:$PATH" railway up --detach
```

Manage it (env vars, logs, billing) at https://railway.com/project/da83590d-9a5a-44a1-94be-d54dcff77ec8

### Custom domain setup (draw.signify.one)

The domain is registered in Railway. To finish it, add these DNS records at the host for **signify.one**:

| Type  | Name                   | Value |
|-------|------------------------|-------|
| CNAME | `draw`                 | `8f4eg6qv.up.railway.app` |
| TXT   | `_railway-verify.draw` | `railway-verify=4d56fd348c9b8abbaa35a5fb33de1c56f59c0fe2fe7f3a07a0a046266b6a25da` |

Then, in the [Google OAuth client](https://console.cloud.google.com/apis/credentials), add `https://draw.signify.one` to **Authorized JavaScript origins** so sign-in works on the new domain. Check status with `railway domain status cb99e8e1-d4f7-459b-b021-3c24076dce3b`.

## Putting it online elsewhere

The app is a single Node server (WebSockets included), so it works on any Node host. The included `render.yaml` sets up **Render**, and the included `Dockerfile` works on any other host (Fly.io, Cloud Run).

### 1. Put the code on GitHub

```bash
cd classroom-whiteboard
git init && git add -A && git commit -m "Classroom whiteboard"
# create an empty repo on github.com, then:
git remote add origin https://github.com/YOUR-USER/classroom-whiteboard.git
git push -u origin main
```

### 2. Create a Google OAuth client

1. Go to https://console.cloud.google.com/ (sign in with your school Google account) and create a project, e.g. "Classroom Whiteboard".
2. **APIs & Services → OAuth consent screen**: choose **Internal** if your school uses Google Workspace — that alone limits sign-in to your school's accounts. Fill in the app name and contact email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
4. Under **Authorized JavaScript origins** add your app's URL (e.g. `https://classroom-whiteboard.onrender.com`) and `http://localhost:3000` for testing.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

### 3. Deploy on Render

1. Sign up at https://render.com and choose **New → Blueprint**, pointing it at your GitHub repo — it reads `render.yaml`.
2. Set the environment variables it asks for:
   - `GOOGLE_CLIENT_ID` — the client ID from step 2
   - `ALLOWED_DOMAINS` — e.g. `myschool.edu` (comma-separate several)
   - `TEACHER_EMAILS` — e.g. `dsuarez@myschool.edu` (comma-separate several)
3. Deploy. Your app will be at `https://<name>.onrender.com` — add that exact URL to the OAuth client's JavaScript origins if you haven't.

Notes:
- The blueprint uses the **Starter** plan with a 1 GB persistent disk so saved boards survive restarts and deploys (~$7/month + ~$0.25 for the disk). On the **free** plan, remove the `disk` and `DATA_DIR` entries from `render.yaml`; the app works but boards are lost whenever Render restarts the service, and it sleeps after idle periods.
- Google sign-in requires HTTPS, which Render provides automatically.
- Without `TEACHER_EMAILS`, any signed-in account may open a class as teacher — fine for trying it out, but set it for real use.

## Environment variables

| Variable | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID; setting it turns Google sign-in on |
| `ALLOWED_DOMAINS` | Comma-separated email domains allowed to sign in (empty = any Google account) |
| `TEACHER_EMAILS` | Comma-separated emails allowed to act as teacher (empty = anyone chooses) |
| `SESSION_SECRET` | Random string; keeps sign-ins valid across server restarts |
| `DATA_DIR` | Where board JSON files are stored (default `./data`) |
| `PORT` | Listen port (default 3000; hosts set this automatically) |

## Classrooms & enrollment (sign-in mode)

Rooms are persistent classrooms with a name, an owner (teacher), and a roster:

- The landing page shows **My classrooms** — rooms you teach and rooms you're enrolled in — so nobody retypes codes. Teachers create named classrooms right there; joining by code still works and auto-enrolls the student.
- On the board, teachers open **👥 Students** to manage the roster: live-search approved students at their school (same email domain, plus anyone they added), bulk-paste a list of emails, or remove someone. Enrolling an email that has never signed in creates the account (outside approved domains it waits for admin approval). Enrolled students appear on the teacher dashboard even before they first join.
- Admins with the *manage boards* permission can create classrooms (optionally assigning the teacher), rename them, change owners, and edit any roster from the portal's Boards tab.
- Admins with *manage users* can **bulk add users** in the portal's Users tab — paste a list, pick a role.

## Boards & documents

Everyone can have **multiple boards** per class, plus **personal boards** that belong to no class:

- The **🗂 board button** in the top bar opens your boards drawer: switch, create, rename, duplicate, delete, and **copy or move** any board to another class you teach/attend or to *My boards*. The landing page lists your personal boards; they auto-save like everything else.
- The teacher dashboard always shows each student's most recently used board; the close-up view has tabs to flip through all of a student's boards in that class.
- **📄 documents**: upload a PDF, Word, PowerPoint, or other office file (converted server-side by LibreOffice — PDFs render entirely in the browser). Pages appear as locked backgrounds you draw on top of; your drawings stay movable. Scroll through pages naturally or jump with the **◀ 1/3 ▶** buttons (PageUp/PageDown work too). Up to 40 pages per document.
- **Navigation**: scrolling pans the board (documents scroll like documents); **Ctrl/⌘+scroll or pinch** zooms.

## How to use it

**Teacher**
1. Sign in (or just enter a name in open mode), pick *I'm the Teacher*, and open a classroom from *My classrooms* — or generate (🎲) / type a room code. Everything is auto-saved.
2. Give students the room code, or enroll them via 👥 Students.
3. The right panel shows a live thumbnail of every student's board. Click a thumbnail for a full-size live view.
4. **📺 Share my board** — students' screens switch to a live, view-only copy of your board. Click again to stop.
5. **📤 Push to class** — sends your current board to every student as a template (replaces their board; they can undo). From a student's close-up view you can push to just that student.

**Everyone**
- Tools (left bar): select/move, hand (with a **Move board / Move objects** switch — pan the canvas or manipulate objects), pen, highlighter, straight line, curved line (drag the line, move the mouse to bend it, click to place), arrow, rectangle, ellipse, triangle, text, eraser, image upload, and a movable/rotatable ruler.
- Every object can be moved, resized, and rotated via its selection handles. Double-click a **curve** (or use the *Edit curve* button) to reshape it with draggable endpoint/control handles; double-click an **image** (or *Crop*) to crop it with a draggable frame — Enter/Apply confirms, Esc cancels.
- **Rich text**: select or edit a text object and a floating toolbar appears with bold, italic, underline, size, and color — applied to the whole text or just the highlighted range.
- **Coordinate graph** (📈): insert a labeled Cartesian plane with a chosen X/Y range and axis titles — draw supply/demand or any lines on top.
- **Charts** (📊): upload a CSV, pick bar / line / pie, choose the label and value columns, and a clean chart drops onto the board.
- **Documents**: arrow keys (or PageUp/PageDown) page through an uploaded document when nothing is selected.
- **Feature switches**: teachers open **Features** on the board to turn Drawing, Text, Photos, Documents, Charts, New boards, or Download on/off for the whole room or a single student (e.g. pause a student's photo uploads). Admins set school-wide defaults per domain in the portal's Users tab. Most specific wins: student overrides room, room overrides school; changes apply live with a notice on the student's screen.
- **Live polls** (teacher **Poll** button): ask a multiple-choice or short-answer question; students answer on a full-screen card. Multiple-choice results update live as bars and can be dropped onto the board as a bar or pie chart; short-answer results appear as a tinted response wall that can also be placed on the board. Poll text is capped and rendered as plain text (never HTML).
- Colors, custom color picker, line thickness, and a "Fill" toggle for shapes.
- Zoom with the mouse wheel or the +/− buttons; *Fit* shows everything; click the percentage to reset to 100%.
- **⬇ Download** — *Full board* exports everything as a PNG; *Current view* exports exactly what's on screen (your zoomed-in view).
- Boards auto-save on every change. Rejoining the same room restores your board.
- Shortcuts: V select, H pan, P pen, T text, E eraser, Delete removes selection, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo.

## Where data lives

Boards are saved as JSON in `DATA_DIR` (default `classroom-whiteboard/data/`), one file per room. Delete a file to remove that class's boards.
