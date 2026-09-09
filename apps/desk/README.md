# Teacher's Desk

A board of classroom tools, signed in with [Signify ID](https://id.signify.one).

Timers, stopwatches, alarms, notes, a private behaviour tally, a student
randomiser, a group maker and seating plans — as widgets a teacher arranges
however they like. Every card opens larger, and larger still onto the
projector.

```
 ┌──────────────────────────────────────────────────────┐
 │  Teacher's Desk                    + Add a tool  ▣   │
 ├──────────────┬──────────────┬────────────────────────┤
 │  Timer       │  Randomiser  │  Notes                 │
 │   5:00       │   Ava B.     │  Do now…               │
 ├──────────────┼──────────────┼────────────────────────┤
 │  Stopwatch   │  Groups      │  Alarms                │
 └──────────────┴──────────────┴────────────────────────┘
      drag by the top edge · resize by the corner
```

## The tools

| Tool | What it is for |
|---|---|
| **Timer** | Counts down, rings, then keeps counting **past** zero in red — the number a teacher actually wants at 00:00 is how far over they are. Tap the digits to type a time (`7`, `1:30`, `45s`, `1h30m`). Survives a reload, a closed lid and a background tab, because it stores an end time rather than a number it decrements. |
| **Stopwatch** | Counts up, with laps you can put a name against. |
| **Alarms** | Times of day — assembly, pack away, the bus — on the days of the week you choose. |
| **Notes** | A note to write in, or a checklist to tick off. Switching between the two keeps what you wrote. |
| **Behaviour tracker** | A running tally per pupil, and a short log behind it. Private to the teacher who wrote it, and it clears itself. See below. |
| **Student randomiser** | Picks a pupil, with *everyone before anyone twice* on by default. |
| **Student groups** | Four groups, or groups of four. Honours keep-apart pairs, and an arrangement that worked can be kept and put back next week. |
| **Seating plan** | Arrange the furniture, then sit the class in it. A plan per class, switched from the same card. See below. |
| **Clock** | Hands or digits, any timezone, in your colours. The face with hands is there because a class learning to tell the time needs one on the wall, and most rooms no longer have one. |
| **Emoji picker** | Rolls one and puts it straight on the clipboard, for pasting onto a piece of marked work. |
| **Soundboard** | Pads you tap for a chime, a little fanfare or a rude noise. Ships with a CC0 pack; upload your own for anything missing. |
| **Weather & recess** | What it is doing now, and what it will be doing at the times you actually take them outside. Search by town or ZIP. |
| **Random number** | A number in any range, dice you can see, or a coin that flips — one widget, because they are the same gesture with different faces on it. |
| **Countdown to a day** | Sleeps until the trip or the holidays — several days on one card, the nearest one in big figures. Counts by calendar date, so "3 days" means three more mornings. |
| **Big message** | One line, as large as the screen allows, for the instruction you would otherwise say twice. |
| **Calm down** | A shape to breathe along with. Honours `prefers-reduced-motion`. |
| **Scoreboard** | Points for teams, houses or tables — groups rather than named children, on purpose. |
| **Classroom jobs** | Who has which job, rotating by position so everyone moves along one each time. |
| **Noise meter** | How loud the room is. Nothing is ever recorded; the mic is off until you switch it on. |
| **QR code** | Put a link on the board for thirty devices to point at, or save it as a PNG. |
| **Classroom Atlas** | The teaching map, embedded live on the desk when you open the card. |
| **Whiteboard** | Opens the shared drawing board in its own tab — it refuses to be framed, and rightly. |
| **Google Calendar** | Your calendars — yours, the school's, whatever you subscribe to — each in its own colour, with no OAuth at all. |
| **Picture** | A picture of your own on the board. Uploaded here, served from here, shared between your own cards. |
| **YouTube video** | The clip that goes with the lesson. Nothing is sent to YouTube until you press play. |

**Sound** in the top bar mutes everything at once — timers, alarms, the
randomiser — for when a test is on or the class next door can hear you. It is
kept per device rather than per teacher, because that is what it means: the
laptop on the desk and the machine driving the projector are in different
rooms with different speakers. The button stays visibly *Muted* while it is
on, so a timer running out in silence reads as a choice somebody made rather
than a broken app.

Add as many as you like — two timers and three notes is a perfectly ordinary
desk. Below about 820px the board stacks into one column and rearranging is
switched off, deliberately: the alternative is a teacher on an iPad quietly
flattening the layout they set up on their laptop.

## Making it yours

**Appearance** in the account menu sets the colour of the whole site — eight
accents, light/dark/follow-the-machine, and something behind the board: a
plain colour, dots, a grid, or a picture you upload with a slider to fade it
back so the cards stay readable.

It is stored on the teacher's board rather than in the browser, so it follows
them to whichever machine they sign in on — including the one driving the
projector, which is the one that matters.

Under the hood the whole palette hangs off a single `--accent` custom
property; the eight choices are one hue each rather than a table of shades,
and `--blue` is kept as an alias so every rule written before theming existed
still works.

## Sounds, and files a teacher uploads

The bundled soundboard pack is **CC0, all from one author** — Kenney's
*Interface Sounds* and *Music Jingles*, converted from Ogg to AAC because Ogg
is not safe to rely on in Safari and a silent soundboard on an iPad is not a
soundboard. `public/sfx/LICENCE.txt` records the provenance and why a single
source was chosen over scraping the "free sound effects" sites, which mix
licences per file.

The pads are **labelled by the teacher**, not by the app. The pack's jingles
have no inherent meaning — the same four notes are "well done" in one room and
"time's up" in another — so the picker lets you audition and name them
yourself rather than pretending to know which is which.

Uploads (sounds, and pictures for the background) go to `server/assets.js`,
which is deliberately narrow because an upload endpoint on a school app is the
sort of thing that gets found:

- **The type is decided by sniffing the bytes**, never from the filename or
  the Content-Type the browser claims. An HTML file called `innocent.png` with
  `Content-Type: image/png` is refused, and there is a test that proves it.
- Files are served back with the sniffed type, `nosniff`, and an
  `attachment` disposition, so nothing uploaded can ever execute as a page on
  this origin. (Browsers ignore that disposition for `<img>` and `<audio>`
  subresources, which is why a background picture still works — verified
  rather than assumed.)
- Stored under a generated id; the teacher's filename survives only as a
  label and never touches the filesystem.
- Per-teacher count and byte quotas, so one person cannot fill the disk.

## Weather

Open-Meteo, **proxied through this server**, for the same reason the fonts are
self-hosted: thirty classroom machines calling a third party directly would
report every teacher's IP to somebody who is not on the subprocessor list.
Coordinates are rounded to about a kilometre before they leave, which is ample
for "will it rain at break" and does not pin a school. Answers are cached, so
a staffroom of desks is a few requests an hour rather than one per refresh.
No API key is needed, which is why Open-Meteo was chosen.

The widget is built around **the times you go outside** rather than around the
day: add recess, lunch, PE, and it tells you what it will be doing then. The
verdicts are jokes with a fact attached — the joke gets read, the temperature
and chance of rain underneath it decide whether anyone needs a coat. They are
rule-based rather than generated, so they cannot surprise anybody in front of
a class.

## The ones with an outside dependency

**Weather** searches by town, city or postcode. Open-Meteo's name search knows
some postcodes and not others — `90210` finds Beverly Hills, `23173` finds
nothing — so a real postcode lookup backs it up for US ZIPs (including ZIP+4)
and Canadian codes. Both are proxied; browsers never call out.

**Classroom Atlas and Whiteboard are separate widgets**, because they behave
differently and one card pretending otherwise was misleading. The atlas
embeds: `maps.signify.one` sets no frame restriction, and being a sibling on
the same site the teacher's session comes with it. The whiteboard does not:
`draw.signify.one` sends `frame-ancestors 'self'` and `X-Frame-Options:
SAMEORIGIN`, which is clickjacking protection on an authenticated drawing
surface and is correct. Weakening it for a nicer-looking card would trade a
real protection for a convenience, so that widget is an honest launcher and
says why.

The atlas only loads its iframe at full size. A map in a card the size of a
postcard is not a map anybody can use, and loading one into every small card
on a board would waste a classroom's bandwidth.

**Google Calendar** uses Google's own `/calendar/embed`, which shows the
calendars of whoever is signed into Google in that browser — no OAuth, no
scopes, no token this app ever holds.

It takes **as many calendars as you like**: your own, the school's, the sports
fixtures. Each gets a colour. Google pairs a `color` parameter with the `src`
immediately before it, so they are appended alternately rather than grouped —
`src, color, src, color` — which is the whole trick. With more than one on
show, the embed's own list can be turned on so calendars can be ticked off for
a moment without removing them here.

A calendar's address is in Google Calendar under Settings → that calendar →
Integrate calendar → Calendar ID. Only calendars the signed-in account can
already see will appear; adding one here does not grant access to it. The catch, stated plainly because it
will bite: the embed reads Google's cookies from inside a cross-site iframe,
and browsers are removing third-party cookies. When that finishes, the embed
will say "not available" rather than showing a calendar, and only a real OAuth
flow would fix it. The widget says so itself rather than looking broken.

**YouTube** plays through `youtube-nocookie.com`, and the iframe is not put on
the page until somebody presses play — so a desk sitting open on a projector
all afternoon has told YouTube nothing. Whatever gets pasted in is parsed down
to an eleven-character video id before it goes anywhere near the embed: a
watch link, a share link, an embed, a Short or the bare id all work, and
nothing else becomes a frame on this origin. A `t=` in the link is kept as the
start time.

**The title comes from YouTube, not from the teacher.** Pasting a link is the
whole job; the card asks oEmbed what the video is called and puts that on the
poster. That lookup is proxied through this server for the same reason the
weather is — a lookup fired from thirty classroom machines would tell YouTube
every teacher's IP and what they were about to show, which is exactly what the
deferred iframe exists to avoid. No API key, no quota, no Cloud project to
keep alive, and the answer is cached for a week because a title does not
change.

The name field is now an override rather than a chore: leave it empty and the
card uses YouTube's title, which shows greyed out in the box so it is obvious
what clearing it will do. A video whose title cannot be fetched — private,
deleted, or oEmbed simply unreachable — still plays; it just has no name, and
says nothing about it.

The card also says out loud that `rel=0` no longer removes the suggestions at
the end of a video — it only keeps them to the same channel. That is YouTube's
decision, not this app's, and a teacher planning to walk away from the board
should hear it from the card rather than from the class.

**Pictures** a teacher uploads go through the same store as soundboard pads
(`server/assets.js`): the type is decided by sniffing the file's own first
bytes, never its name, and everything is served back from this origin with
`nosniff` and an attachment disposition, so nothing uploaded can ever run as a
page here. A picture uploaded on one card is offered on every other, and
deleting one asks first, because another card may be showing it.

### No GIF search

There was one, briefly, built against Tenor. Google **shut the Tenor API down
on 30 June 2026** — it stopped taking new clients that January and now returns
errors — so it was removed rather than left as a dead card on the board.

If it comes back, the live options are Giphy (per-request `rating=g`, so the
safety filter can live in the code and be tested) or Klipy (filtering
configured in their dashboard instead). The thing worth keeping from the first
attempt: the filter belongs on the server, applied to every request, not as
anything the browser can reach past.

### QR codes

Error correction is fixed at **level M** — roughly 15% of the code can be
damaged and still read. It is what most generators default to and the right
trade for a whiteboard: robust enough for a dim projector or a hand across a
corner, without the density that makes a long link hard to scan from the back.
It was a picker; it is not a decision worth putting in front of a teacher.

**Download PNG** rasterises the code onto a canvas from the modules directly,
rather than converting the on-screen SVG. That SVG takes its colours from CSS
variables, which do not survive into an `<img>` — that route silently produces
a blank square. The file is black on white at 16px per module, so it survives
being pasted into a worksheet and printed, and is named after the label.

## Typing into a widget

A handler that rebuilds its own container destroys the field being typed into
and makes a new one, so the caret lands back on the page and the next
keystroke goes nowhere — the "only one character at a time" bug. Nine
handlers did this.

Two fixes, in order of preference:

1. **Do not redraw the form at all.** The countdown and the classroom jobs now
   redraw only the display — the big number, the rota — and leave the fields
   alone. Rebuilding a form on every keystroke was wasteful as well as broken.
2. **`Desk.keepFocus(root, redraw)`** for the cases where a rebuild genuinely
   has to happen: a checkbox that reveals other controls, a time field that
   changes what is shown. It puts the caret back, in the same position, by
   index among the controls inside `root` — a rebuild recreates the same
   structure in the same order.

## The noise meter, and the microphone

Nothing is recorded. The audio never leaves the `AudioContext` — there is no
`MediaRecorder`, no buffer kept, no upload path, and the only thing that
survives a frame is one number. The microphone is off until the teacher turns
it on, every session, and turning it off releases the track so the browser's
recording indicator actually goes out. Half-off would be worse than useless:
people need to see it stop.

## Typing a time on the timer

Tap the digits on any timer and type. Presets cover the four lengths used
every day; typing covers the fifth one needed right now, without hunting for a
"+3 min" button that does not exist.

**The colon types itself.** Digits punctuate as they land, the way a microwave
keypad does — `2`, `3`, `0` reads back `2:30` without anybody reaching for the
punctuation, and `1`,`3`,`0`,`0`,`0` walks through `1:30` and `13:00` to
`1:30:00`. Backspace reflows the same way.

| Typed | Means |
|---|---|
| `7`, `45` | 7 and 45 **minutes** — one or two digits are what a teacher means by them |
| `230`, `1500` | 2:30 and 15:00 — three or more put the last two digits in the seconds column |
| `13000` | 1:30:00 |
| `2.5` | 2m 30s — a decimal is always minutes |
| `1:30`, `1:02:30` | as written |
| `45s`, `20 min`, `1h30m` | units, in any combination |

The jump at 99 → 100 (99 minutes, then one minute) comes with the microwave
convention and is what everyone already expects from one.

It is deliberately strict about leftovers: `5pm` is a time of day, not a
length, so it is refused with a message rather than quietly read as five
minutes. Enter commits, Escape cancels, and the running clock never
overwrites what is under the cursor.

The live formatting (`Desk.groupDigits`) and the commit (`Desk.parseDuration`)
are separately tested to agree on every input, because a field that punctuates
one way and commits another would set the timer to something other than what
the teacher was looking at.

## Seating plans

Three shapes of furniture — a **row** of desks with seats along one side, a
**table** with seats along both, and a **round table** — from one to ten
seats each, turned to face whichever way the pupils do. Drag a desk by its
surface to move it. An empty room offers three starting points (rows of
pairs, tables of four, a horseshoe) sized for the class actually on the list.

Sitting the class down works three ways, and they all agree with each other:
drag a name from the list onto a chair, tap a name and then tap a chair, or
press **Seat at random**. Dragging one pupil onto another swaps them.

**Seat at random tries not to leave anybody sitting on their own, and then
tries not to leave a table empty.** In that order.

Filling chairs in order strands whoever falls on the boundary — thirteen
pupils across five threes becomes 3,3,3,3,1, and that last child sits alone
for the lesson. The spare places are worked out first, so the same class comes
out 3,3,3,2,2 instead. It is solved exactly rather than greedily: handing out
pairs and hoping the remainder lands well gives 2,1,0 for three pupils across
desks of 2, 3 and 4, when 0,3,0 strands nobody.

The second rule stops the class being packed into the first few tables when it
did not need to be. Six pupils across three threes has nobody alone either
way, but 3,3,0 leaves a table standing empty in a room the teacher laid out on
purpose; 2,2,2 uses it. The two rules do pull apart, and where they do the
first wins: four pupils across three threes could fill every table as 2,1,1,
but only by sitting two children on their own, so one table goes unused
instead. A spare table is better than a child by themselves.

Both are carried as one number — a lone pupil costs a whole table's worth, an
empty table costs one — so the ordering is arithmetic rather than a tie-break
that happens to work. The test checks the result against a brute-force search
of every possible arrangement, at every class size, in seven different rooms:
a change that quietly started trading a lone child for a fuller room would
fail rather than look plausible. Where the room makes both impossible — an odd
class across two-seat desks — it does as well as the arithmetic allows, and
seats everyone rather than refusing.

**The spare seats move around too.** Both the desks and the chairs within each
desk are shuffled, so the empty places are somewhere different every time
rather than always piling up at the end of the list.

Some things worth knowing about how it behaves:

- **The plan belongs to the class, not the widget.** One card holds a plan per
  class and the picker switches between them, so five classes need one card.
- **The card is read-only; editing happens in the big view.** A seating chart's
  job during a lesson is to be looked at, and dragging a child across the room
  while taking the register is not a feature.
- **Every drag has a tap equivalent**, because interactive whiteboards and
  tablets make drag-and-drop miserable.
- **Chairs show first names**, with a surname initial only for the pupils who
  share one — "Elliot S…" truncated in forty pixels loses exactly the part
  that told two Elliots apart. Smaller than that and it falls back to initials,
  which is what the thumbnail on the card shows.
- **"My view" / "Class's view"** mirrors the room, inside each desk as well as
  across the floor — from the back of the class the left-hand chair of a pair
  is the right-hand one.
- Everything is stored in grid cells rather than pixels, so the same plan is a
  thumbnail on the card and wall-sized on the projector.

### The room itself

**The front can be on any of the four walls.** Not every classroom faces the
way a plan was first drawn. Moving it re-labels the wall, re-orients the
starter layouts, and changes which way the class's view mirrors — a class
facing a side wall has their left and right swapped vertically, not
horizontally. Existing desks are deliberately *not* rearranged underneath the
teacher; instead an offer to turn them to face the new front appears, and is
declined by ignoring it.

**Anything else in the room** is one of three plain shapes — a box, a round,
or a strip — that the teacher labels themselves: the teacher's own desk, a
bookcase, the door, a rug, the sink. Drag to move, drag the corner to resize,
a quarter turn swaps a rectangle's sides so a door can go on a side wall.
Plain shapes rather than a catalogue of furniture clip-art, because every
classroom has something the catalogue would not have had.

### Saved rooms

**Set the room up once, use it for every class.** *Save this room* keeps the
furniture — the desks, which way they face, the objects and their labels, and
which wall the front is on — and nothing else. **No pupil is ever part of a
template**, which is both what makes it reusable across classes and what lets
it be kept indefinitely without holding anything about a child. Applying one
to a class replaces that class's furniture and leaves every other class
untouched; desks are given fresh ids on the way in, so two classes using the
same room never share a seat.

## Where the class lists come from

Two sources, in one shape:

- **Classes from Signify ID.** Asked for on the teacher's own token, so the
  roster rules are enforced there rather than trusted here. The desk keeps no
  copy — removing a pupil there removes them here.
- **Lists the teacher types in.** For the club, the set, the supply day, and
  the class that has not been imported yet. A tool nobody can use on day one
  is not a tool.

Pupils keep a stable id across an edit, so correcting a spelling does not
detach a child from their behaviour notes or a saved grouping.

### When the sign-in ends underneath you

A class list that disappears reads as school data having gone missing, so this
path is worth spelling out.

Two things have to agree about whether somebody is signed in: this app, which
checks that its ID token is signed and unexpired, and Signify ID, which checks
a live session row. They can disagree — and when they did, the desk believed
the teacher was here while every roster question came back `401 invalid_token`
and the pickers emptied. Signing out and back in fixed it, which is a fine
diagnosis and a poor feature.

Four things now stop it:

1. **A renewed token is carried forward within the request.** When signify-auth
   renews an expired ID token it puts the new one in a `Set-Cookie` on the
   *response*; `req.headers.cookie` still holds the old one for the rest of
   that request, so a roster lookup would ask with a token that had just
   expired. `server.js` reads the renewed value back off the response header.
2. **Using an app counts as using the session.** The real fault was in Signify
   ID: sessions have an idle clock, only the identity service's own pages slid
   it, and the refresh grant did not even check it. A teacher who worked in
   this desk all morning and never opened `id.signify.one` was timed out
   behind their own back — refused by the API, while the refresh grant went on
   issuing them fresh tokens. Both the service API and the refresh grant now
   slide that window, and both check it, so there is one rule.
3. **Parallel renewals are one renewal.** This page fires half a dozen
   requests at once; with an expired ID token, every one of them renewed it,
   each presenting the same refresh token. Signify ID rotated it for the first
   and read the rest as a stolen token — and revoked the whole session. That
   is what was actually killing sessions mid-lesson, and it is fixed on both
   sides: `signify-auth.js` shares one renewal between concurrent requests,
   and the identity service no longer treats a two-second-old rotation as
   theft.
4. **A 401 ends the sign-in here too.** If Signify ID ever stops recognising a
   session for any other reason, the desk clears its own cookies and reloads
   into the sign-in rather than sitting there half-working. A refusal is never
   cached, and a 503 is not treated as an ended session — an identity service
   having a moment must not sign a classroom out.

A refused lookup is also reported as refused: the response carries `signifyOk`,
so the pickers say "could not load your classes" rather than "you have none".
The two are entirely different things to put in front of a teacher.

## Behaviour notes

These are records about named children, so:

- **Only the teacher who wrote a note can read it back.** There is no endpoint
  that returns somebody else's — not for another teacher, not for a local
  admin, not for a super admin. A school that needs a child's record uses
  `core:export_student_data` in Signify ID, which is audited; a quiet back
  door here would not be.
- **Everything expires.** `BEHAVIOUR_RETENTION_DAYS` defaults to 90 and the
  window is printed on the widget, not buried in a policy page. A running
  tally for this half term is what a teacher uses; a permanent file on an
  eight-year-old is not.
- **Positive chips come first, and there are more of them.** The tool should
  not make it easier to record what went wrong than what went right.
- **Anything recorded can be taken back.** An **Undo** sits on the confirmation
  for a few seconds after each tap, opening a pupil lists what is already
  against them with an × on each, and the log in the big view removes from
  there too. A tally you can add to but not correct is one a teacher stops
  trusting the first time they tap the wrong name — which they will, because
  this gets used one-handed with a class in front of them. Removing a *typed*
  note asks first; removing a tapped chip does not.
- The tally is what is on screen; the log is one tap behind it, so the board
  never becomes a wall of a child's worst moments.

Recording behaviour is its own permission (`desk:behaviour`), separate from
using the desk (`desk:use`). A classroom aide or a student teacher can have
the timers without it, and the widget simply does not appear for them.

## Running it locally

```bash
cd teachers-desk && npm install && npm run dev
```

`npm run dev` sets `DESK_DEV_USER=1`, which signs every request in as a
made-up teacher so the board can be worked on without the identity service.
It refuses to start in a hosted environment.

Then open http://localhost:8770. There is also a `teachers-desk` entry in the
workspace `.claude/launch.json`.

```bash
npm test
```

116 checks, no server and no database: the store runs against a throwaway
directory, and the grid packing is loaded into a stub of just enough browser.

## Deploying

1. In Signify ID, **Applications → Register an app**: namespace `desk`,
   redirect `https://desk.signify.one/auth/callback`. Copy the secret — it is
   shown once. Then **Applications → Schools** and tick the school.
2. Create the Railway service from this directory, attach a volume at
   `/var/data`, and set:

   | Variable | Notes |
   |---|---|
   | `SIGNIFY_ISSUER` | `https://id.signify.one` |
   | `SIGNIFY_CLIENT_ID`, `SIGNIFY_CLIENT_SECRET` | From step 1. |
   | `SIGNIFY_REDIRECT_URI` | `https://desk.signify.one/auth/callback` |
   | `SIGNIFY_COOKIE_SECRET` | `openssl rand -hex 32`. |
   | `DATA_DIR` | `/var/data` |
   | `CANONICAL_HOST` | `desk.signify.one` |
   | `BEHAVIOUR_RETENTION_DAYS` | Optional; 90 by default. |

   `.railway/railway.ts` describes all of this as code — `railway config apply`
   reconciles the project, so anything missing from that file is taken *off*
   the service.

3. Deploy. The app declares `desk:use` and `desk:behaviour` to Signify ID on
   boot; an administrator then adds them to whichever roles should hold them.
   Until they do, teachers see "Your role does not include the desk" rather
   than a broken board.

## Adding a tool

This is the whole extension point, and it does not touch the server — widget
state is stored opaquely, so a new tool can keep whatever it likes.

1. Write `public/js/widgets/yours.js`:

   ```js
   Desk.widget({
     type: 'dice',                    // never rename this: it is in saved boards
     name: 'Dice',
     blurb: 'Roll one, or six.',
     icon: 'randomiser',              // a key from Desk.iconNames
     size: { w: 3, h: 4 },            // grid cells, when first added
     min:  { w: 2, h: 3 },
     permission: 'behaviour',         // optional: hide unless the role has it
     init(state) { if (!state.sides) state.sides = 6; },
     mount(ctx) {
       ctx.root.append(Desk.el('div', { text: `d${ctx.state.sides}` }));
       return { destroy() {}, frame() {}, tick() {} };
     },
   });
   ```

2. Add one `<script>` line to `public/index.html`.

`ctx` carries `{ root, state, save, item, expanded, me }`. Mutate `state`
freely and call `save()`; the write is debounced and versioned. `expanded` is
true when the widget is drawing into the big view — the same state object, so
whatever is running keeps running. `frame()` runs on every animation frame
(smooth displays); `tick()` runs twice a second **and while the tab is in the
background**, which is where anything that must happen on time belongs.

## Shape of it

```
server.js              routes, and nothing else
server/store.js        one JSON document, atomic writes, debounced
server/auth.js         the Signify ID adapter + the two permissions
server/board.js        the board document, with a revision guard
server/roster.js       Signify classes and typed lists, in one shape
server/behaviour.js    behaviour notes and their retention sweep
server/groups.js       kept groupings
server/templates.js    saved rooms — furniture, never a pupil
server/assets.js       teacher uploads; sniffs bytes, trusts nothing
server/weather.js      Open-Meteo proxy, rounded and cached
public/vendor/         self-hosted fonts, and a vendored MIT QR encoder
signify-auth.js        copied verbatim from signify-id/client
public/js/board.js     the grid: drag, resize, collide, compact
public/js/registry.js  Desk.widget() — the extension point
public/js/widgets/     one file per tool
```

No build step and no framework. A classroom tool board is a grid and seven
widgets; a bundler would be the largest thing in the repository.

## Decisions worth knowing

**A revision guard, not last-write-wins.** A save carrying a stale revision is
refused and the browser reloads. Teachers open this on a laptop and a
projector-side tab, and silently losing the layout from one of them is the
kind of bug nobody reports and everybody resents.

**Sound is synthesised, not sampled.** No audio files to ship, no request to
another host, nothing to go missing. Browsers stay silent until the page has
been clicked, so the audio context is created on the first gesture.

**Fonts are self-hosted.** A font CDN would report pupils' IP addresses to a
third party and contradict the subprocessor list at `id.signify.one`.

**No emoji in the interface.** They render differently on every board in every
classroom and half of them are unreadable from the back, so every icon is
drawn. The emoji *picker* is the exception that proves it: there the emoji are
the content the teacher wants, not the furniture around it.

**Present mode swaps the timer's ring for a bar.** A ring is right on a card.
Filling a projector, the digits have to be enormous and a circle around them
either swamps them or hides behind them.
