// ===================================================================
// Teacher's Desk — what this holds about pupils
//
// The question a head teacher actually asks is not "is this compliant?" but
// "what does it keep about my students, and for how long?" — so that is what
// this answers, on a page anybody can read without signing in.
//
// It is written next to the code it describes, and a test asserts that every
// collection in server/store.js appears here. Adding a new store without
// saying what is in it fails the build; a privacy note that quietly drifts
// away from the software is worse than none.
// ===================================================================

const store = require('./store');
const assets = require('./assets');
const behaviour = require('./behaviour');

const mb = (bytes) => `${Math.round(bytes / 1048576)}MB`;

/** Every collection in the store, in the order a reader would want them. */
function sections() {
  return [
    {
      key: 'users',
      title: 'Who you are',
      holds: 'Your name, email address, profile picture and school, as Signify ID gives them to this app when you sign in. Nothing about a pupil.',
      pupils: 'Nothing.',
      kept: 'While you use the desk. An account left untouched is swept up by Signify ID, not here.',
    },
    {
      key: 'boards',
      title: 'Your desk',
      holds: 'Which tools are on your desk, where they sit, and each tool’s own settings — the timer’s presets, a note’s text, a countdown’s date.',
      pupils: 'Only what a tool needs. A seating plan records which chair a pupil sits in **by their id, never by their name**; the name is fetched fresh from the class list each time and is never written down here.',
      kept: 'Until you change it. See below.',
    },
    {
      key: 'boardHistory',
      title: 'Earlier versions of your desk',
      holds: 'Up to 30 previous copies of your desk, so work that disappears can be got back. One is kept whenever a save would remove seated pupils, and one every half hour.',
      pupils: 'The same as the desk itself: ids in a seating plan, no names.',
      kept: 'Thirty versions. The oldest drops off as new ones are kept.',
    },
    {
      key: 'rosters',
      title: 'Class lists you type yourself',
      holds: 'The list’s name and the pupils’ names exactly as you typed them, each with an id this app generates.',
      pupils: 'Their name, and only their name. No email address, no date of birth, no photograph, no year group. The editor suggests a first name and an initial — “Ava B.” — which is enough for every tool here.',
      kept: 'Until you delete the list. Deleting it removes the names immediately.',
      note: 'Classes that come from Signify ID are **not** stored here. They are asked for when needed and cached for one minute, so removing a pupil there removes them here.',
    },
    {
      key: 'behaviour',
      title: 'Behaviour notes',
      holds: 'A running tally and a short log: which pupil, which class, positive or concern, the reason you chose, any note you typed, and when.',
      pupils: 'Their name and id, the class, and what you recorded. This is the most sensitive thing here and is treated as such.',
      kept: `${behaviour.RETENTION_DAYS} days, then erased automatically. The window is printed on the widget itself.`,
      note: 'Only the teacher who wrote a note can read it back. There is no endpoint that returns somebody else’s — not for another teacher, not for a local administrator, not for a platform administrator. A school that needs a child’s record uses the audited export in Signify ID.',
    },
    {
      key: 'reasons',
      title: 'Your behaviour chips',
      holds: 'The labels you chose for the buttons on the behaviour tracker.',
      pupils: 'Nothing.',
      kept: 'Until you change them.',
    },
    {
      key: 'groupings',
      title: 'Groupings you kept',
      holds: 'A group arrangement you asked to keep, so you can put it back next week: the class, the group names, and who was in each.',
      pupils: 'Their id and the name as it stood when you kept it.',
      kept: 'Until you delete it.',
    },
    {
      key: 'templates',
      title: 'Saved rooms',
      holds: 'The furniture of a classroom — desks, their shapes and where they stand — so one layout can be reused across classes.',
      pupils: '**Nothing, by design.** A saved room never contains a pupil. That separation is exactly what lets these be kept indefinitely.',
      kept: 'Until you delete it. Exempt from the behaviour sweep, because there is nothing about a child in them.',
    },
    {
      key: 'assets',
      title: 'Files you upload',
      holds: `Sounds for the soundboard and pictures for the board: the file, its type as read from its own first bytes, its size, and the label you gave it. Up to ${assets.MAX_PER_TEACHER} files and ${mb(assets.MAX_BYTES_PER_TEACHER)} each teacher.`,
      pupils: 'Only what you upload. If you put a photograph of a class on the board, that photograph is here — so think before you do.',
      kept: 'Until you delete it. Files are served back only to the person who uploaded them.',
    },
  ];
}

const escape = (t) => String(t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// **bold** only. The notes above are written by hand in this file, so the
// smallest possible amount of markup is all that is needed, and anything a
// section says is escaped before it gets near the page.
const rich = (t) => escape(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/**
 * The page, rendered on the server.
 *
 * No sign-in and no JavaScript: an administrator asking what this software
 * keeps about their pupils should be able to read the answer from a link,
 * on any device, without an account.
 */
function page({ host = 'desk.signify.one', only = null } = {}) {
  const rows = (only || sections()).map((s) => `
      <section>
        <h2>${escape(s.title)}</h2>
        <p>${rich(s.holds)}</p>
        <dl>
          <dt>About pupils</dt><dd>${rich(s.pupils)}</dd>
          <dt>Kept for</dt><dd>${rich(s.kept)}</dd>
        </dl>
        ${s.note ? `<p class="note">${rich(s.note)}</p>` : ''}
      </section>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>What Teacher's Desk holds about pupils</title>
<link rel="stylesheet" href="/css/styles.css">
<style>
  .paper { max-width: 46rem; margin: 0 auto; padding: 2rem 1.1rem 4rem; }
  .paper h1 { font-family: var(--display); font-size: 1.6rem; margin: 0 0 .3rem; }
  .paper .lede { color: var(--muted); margin: 0 0 1.6rem; }
  .paper section { padding: .9rem 0; border-top: 1px solid var(--line); }
  .paper h2 { font-family: var(--display); font-size: 1.05rem; margin: 0 0 .35rem; }
  .paper p { margin: 0 0 .5rem; }
  .paper dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem; margin: .4rem 0 0; font-size: .92rem; }
  .paper dt { color: var(--muted); }
  .paper dd { margin: 0; }
  .paper .note { font-size: .88rem; color: var(--muted); border-left: 2px solid var(--line); padding-left: .7rem; }
  .paper footer { margin-top: 2rem; font-size: .88rem; color: var(--muted); }
</style>
</head><body>
<main class="paper">
  <h1>What Teacher&rsquo;s Desk holds about pupils</h1>
  <p class="lede">Every place this app stores anything, what is in it, and how long it stays.
  Written next to the code it describes: a test refuses to pass if the software
  gains a new store and this page does not mention it.</p>

  <section style="border-top:0">
    <h2>The short version</h2>
    <p>Pupils have no accounts here and never sign in. The only people who use
    this app are teachers. A pupil&rsquo;s <strong>name</strong> is the only thing about them
    a teacher types in, and the class-list editor suggests a first name and an
    initial, which every tool works with perfectly well.</p>
    <p>Behaviour notes are the exception worth reading about in full, below.</p>
    <p>Somebody using the desk <strong>without logging in</strong> can type class lists
    too. Those never reach this server: they stay in that browser, on that
    computer, and are cleared after thirty days unopened. Nothing in the tables
    below comes from a visitor. The behaviour tracker is not offered to
    visitors at all.</p>
  </section>
  ${rows}

  <footer>
    <p>Classes imported from Signify ID are not copied into this app. They are
    asked for when a tool needs them and cached for one minute.</p>
    <p>Questions about a particular child&rsquo;s record go to the school, which
    holds the audited export. <a href="https://${escape(host)}/">Back to the desk</a></p>
  </footer>
</main>
</body></html>`;
}

/** The collections the store actually has, for the completeness test. */
const collections = () => Object.keys(store.EMPTY || {});

module.exports = { sections, collections, page };
