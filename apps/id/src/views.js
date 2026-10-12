// ===================================================================
// Signify ID — server-rendered pages
// Only three pages need to exist before a session does: sign-in, an error
// sheet, and the "signed out" confirmation. Hand-written rather than pulling
// in a template engine for three files.
// ===================================================================

const { config } = require('./config');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// `head` lands in <head>; `tail` lands after the body. Anything that touches
// the DOM belongs in `tail` — a script in <head> runs before the body exists,
// so a listener attached by element id silently never attaches at all.
function shell(title, body, head = '', tail = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · Signify ID</title>
<link rel="stylesheet" href="/css/app.css">
${head}
</head>
<body>
${body}
${tail}
</body>
</html>`;
}

const brand = `<div class="brand"><span class="mark"></span><span class="brand-name">Signify ID</span></div>`;

function errorPage({ title, message, signout = false, detail = '' }) {
  return shell(title, `
<div class="sheet-wrap">
  <div class="sheet">
    ${brand}
    <h1>${esc(title)}</h1>
    <p class="muted">${esc(message)}</p>
    ${detail ? `<p class="small faint">${esc(detail)}</p>` : ''}
    <div style="display:flex;gap:.6rem;margin-top:1.25rem">
      ${signout ? `<a class="btn" href="/logout">Sign out</a>` : ''}
      <a class="btn btn-quiet" href="/">Back to start</a>
    </div>
  </div>
</div>`);
}

function signedOutPage({ appName = '', backTo = '' } = {}) {
  const again = backTo
    ? `<a class="btn btn-primary" href="${esc(backTo)}" style="margin-top:1rem">Sign in again to ${esc(appName)}</a>`
    : `<a class="btn btn-primary" href="/signin" style="margin-top:1rem">Sign in again</a>`;

  return shell('Signed out', `
<div class="sheet-wrap">
  <div class="sheet">
    ${brand}
    <h1>You are signed out</h1>
    <p class="muted">Your session has ended on this device. If this is a shared computer, close the browser before handing it on.</p>
    ${again}
  </div>
</div>`, `<script src="https://accounts.google.com/gsi/client" async defer></script>
<script>
  // Stop Google silently signing the previous person back in on a shared
  // device the moment the next child opens the page.
  window.addEventListener('load', function () {
    try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  });
</script>`);
}

function signinPage({ continueTo = '/admin', error = '', appName = '', reauth = false }) {
  // Loaded whenever Google is configured, whether or not the developer
  // bypass is also available.
  const head = config.googleClientId
    ? `<script src="https://accounts.google.com/gsi/client" async defer></script>`
    : '';

  const googleBlock = config.googleClientId ? `
    <div id="g_id_onload"
         data-client_id="${esc(config.googleClientId)}"
         data-callback="onGoogleCredential"
         data-auto_prompt="false"
         data-auto_select="false"
         data-itp_support="true"
         data-context="signin"></div>
    <div class="g_id_signin" data-type="standard" data-size="large"
         data-theme="outline" data-text="signin_with" data-shape="rectangular"
         data-logo_alignment="left" data-width="340"></div>` : '';

  const devBlock = config.allowDevLogin ? `
    <div class="notice notice-danger" style="margin-top:1rem">
      <strong>Developer sign-in is enabled</strong>
      Any address below is accepted without proof. This must never be on in a hosted environment.
    </div>
    <form id="devform" class="field">
      <label for="devemail">Email address</label>
      <input id="devemail" type="email" required placeholder="teacher@example.edu" autocomplete="off">
      <button class="btn btn-primary" style="margin-top:.6rem;width:100%" type="submit">Continue without Google</button>
    </form>` : '';

  return shell('Sign in', `
<div class="sheet-wrap">
  <div class="sheet">
    ${brand}
    <h1>Sign in</h1>
    <p class="muted">${reauth
      ? 'That action needs a fresh sign-in. Confirm it is you and it will carry straight on.'
      : (appName
        ? `to continue to <strong>${esc(appName)}</strong>`
        : 'Use the Google account your school gave you.')}</p>

    <div id="err" class="notice notice-danger" ${error ? '' : 'hidden'}>
      <strong>Could not sign you in</strong><span id="errtext">${esc(error)}</span>
    </div>

    <div style="margin:1.25rem 0 .5rem">${googleBlock}</div>
    ${devBlock}

    <p class="small faint" style="margin-top:1.5rem;margin-bottom:0">
      Signify ID records your name, school email address, role and class list so that
      your school's apps know who you are. It is never used for advertising.
      <a href="/privacy">What we store</a>
    </p>
  </div>
</div>`, head, `
<script>
  var CONTINUE = ${JSON.stringify(String(continueTo || '/admin'))};

  function showError(msg) {
    document.getElementById('errtext').textContent = msg;
    document.getElementById('err').hidden = false;
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var failure = new Error(data.error || 'Sign-in failed. Please try again.');
      failure.data = data;
      throw failure;
    }
    return data;
  }

  // CONTINUE has to travel WITH the sign-in. The server decides where to send
  // somebody next from the request body, so leaving it out means every
  // sign-in falls back to the admin console — including one that arrived here
  // mid-way through an app's OAuth flow, which then simply never finishes and
  // strands the teacher on this site instead of the app they came from.
  // A sign-in that matched no school is not an error to show: the server says
  // where to go next, which is the questions for asking for an account.
  function failed(e) {
    if (e.data && e.data.next) { window.location.href = e.data.next; return; }
    showError(e.message);
  }

  window.onGoogleCredential = function (response) {
    post('/auth/google', { credential: response.credential, continue: CONTINUE })
      .then(function (d) { window.location.href = d.next || CONTINUE; })
      .catch(failed);
  };

  var devform = document.getElementById('devform');
  if (devform) devform.addEventListener('submit', function (e) {
    e.preventDefault();
    post('/auth/dev', { email: document.getElementById('devemail').value, continue: CONTINUE })
      .then(function (d) { window.location.href = d.next || CONTINUE; })
      .catch(failed);
  });
</script>`);
}

// The plain-language data notice. COPPA's 2025 amendments expect a school to
// be able to see, in one place, what is collected and how long it is kept.
function privacyPage({ retentionDays }) {
  return shell('What Signify ID stores', `
<div class="sheet-wrap">
  <div class="sheet" style="max-width:40rem">
    ${brand}
    <h1>What Signify ID stores</h1>
    <p class="muted">This is the plain-language version. Your school holds the full agreement.</p>

    <h2 style="margin-top:1.5rem">About every person</h2>
    <ul class="small">
      <li>Name, school email address and Google profile picture</li>
      <li>A permanent internal ID, and the identifier Google uses for the account</li>
      <li>Role, school, year group and class membership</li>
      <li>When the account was created and last used</li>
    </ul>

    <h2 style="margin-top:1.25rem">About sign-ins</h2>
    <ul class="small">
      <li>Time, IP address and browser of each sign-in, and which app was opened</li>
      <li>Administrative actions taken on an account, and by whom</li>
    </ul>

    <h2 style="margin-top:1.25rem">What is never collected</h2>
    <ul class="small">
      <li>Home address, phone number, date of birth or government identifiers</li>
      <li>Location beyond the approximate region implied by an IP address</li>
      <li>Anything used for advertising, profiling or sale. There is no advertising here.</li>
    </ul>

    <h2 style="margin-top:1.25rem">How long it is kept</h2>
    <p class="small">Account records are erased ${retentionDays} days after a person stops
    using the apps, or sooner if the school asks. Records of disclosures are kept
    as long as the education record itself, because the law requires it. Deleted
    records disappear from encrypted backups within 30 days.</p>

    <h2 style="margin-top:1.25rem">Your rights</h2>
    <p class="small">A parent or eligible student may ask the school to show them everything
    held about them, correct it, or have it erased. The school can do all three from the
    admin console. Ask your school office.</p>

    <a class="btn btn-quiet" href="/" style="margin-top:1rem">Back</a>
  </div>
</div>`);
}


// ---------- the published privacy policy ----------
// Prose here; the table of what is collected is generated from the data
// inventory, so it cannot drift from what the database actually holds.

function privacyPolicyPage({ retentionDays }) {
  const policy = require('./policy');
  const inventory = require('./data-inventory');
  const vendor = policy.POSTURE === 'vendor';

  const CATEGORY_TITLES = {
    identity: 'Who somebody is',
    school: 'Their place in the school',
    technical: 'Records of use',
    operational: 'Administrative notes',
    request: 'Asking for an account',
  };
  const CATEGORY_INTROS = {
    identity: 'The information that identifies a person.',
    school: 'What a person is allowed to do, and which classes they are in.',
    technical: 'Kept so the school can see who did what, and so an account being misused can be spotted. Not used to build a picture of a student.',
    operational: 'Notes an administrator has written about an account.',
    request: 'Only ever about someone who does not have an account yet and asks for one.',
  };

  // One line per thing collected, not one per database column. The grouping
  // is checked against the schema by the test suite, so it can shorten the
  // list without ever leaving something out of it.
  const grouped = inventory.disclosuresByCategory();
  // Rendered from the titles rather than a second list of categories: a
  // separate list let a new section pass every coverage check and still never
  // reach the page.
  const collected = Object.keys(CATEGORY_TITLES)
    .filter((cat) => grouped[cat] && grouped[cat].length)
    .map((cat) => `
      <h3>${esc(CATEGORY_TITLES[cat] || cat)}</h3>
      <p class="small muted">${esc(CATEGORY_INTROS[cat] || '')}</p>
      <ul class="small">${grouped[cat].map((d) => `<li>${esc(d.text)}</li>`).join('')}</ul>`)
    .join('');

  const placeholderWarning = policy.unfilled().length ? `
    <div class="notice notice-danger">
      <strong>This policy is not finished</strong>
      It is missing: ${esc(policy.unfilled().join(', '))}. Until those are set it
      should not be given to anyone as a final document.
    </div>` : '';

  const covered = policy.COVERED.map((a) =>
    `<li><strong>${esc(a.name)}</strong> — ${esc(a.what)}</li>`).join('');

  // Who is responsible, said plainly. A named person at a school is a
  // perfectly good answer; a company is only needed once these apps are
  // offered to schools their author does not work at.
  // A parent needs a real route to exercise the rights below. Where no
  // address is published, that route is the school — whose administrators
  // genuinely hold the export and erase controls, so it is not a deflection.
  const howToAsk = policy.OPERATOR.contactEmail ? `
    <p class="small">Questions, or a request to see, correct or delete something:
    <strong>${esc(policy.OPERATOR.contactEmail)}</strong>. You can also ask your school,
    who can act on any of it immediately.</p>` : `
    <p class="small">Questions, or a request to see, correct or delete something, go through
    your school. Their administrators hold the controls for all of it and can act
    immediately — they do not have to ask anyone's permission, and nothing waits on a
    reply from elsewhere.</p>`;

  const whoWeAre = vendor ? `
    <p class="small">${esc(policy.OPERATOR.legalName)}, ${esc(policy.OPERATOR.address)}.
    Privacy questions: ${esc(policy.OPERATOR.contactEmail)}.
    The person responsible for keeping this data safe is
    ${esc(policy.OPERATOR.securityCoordinator)}.</p>` : `
    <p class="small">Signify.one Apps are built and run by <strong>${esc(policy.OPERATOR.name)}</strong>,
    ${esc(policy.OPERATOR.role)}. They are not sold, and there is no company behind them.</p>
    ${howToAsk}`;

  const legalBasis = vendor ? `
    <p class="small">In United States terms: under <strong>FERPA</strong> we act as a school
    official with a legitimate educational interest, using education records only for the
    purpose the school authorised. Under <strong>COPPA</strong>, for students under 13, we rely
    on the school having consented on parents’ behalf for classroom software — which holds only
    because use is strictly educational, the school authorised it in writing, and the school was
    told exactly what is collected. That authorisation is recorded and dated.</p>` : `
    <p class="small">Accounts are for students aged <strong>${esc(policy.MINIMUM_AGE)} and over</strong>.
    That matters legally: <strong>COPPA</strong> — the US children's privacy law — governs
    information collected from children under 13, so it does not apply here. If that ever changes,
    so does this policy, and the school will be told before it does.</p>
    <p class="small">All user data belongs to the school. The school decides who has an account,
    what each person may do, and when something is corrected or deleted. Nothing is used for any
    purpose the school has not asked for.</p>
    ${policy.FOLLOWS_FERPA_VOLUNTARILY ? `
    <p class="small"><strong>FERPA.</strong> The US student-records law covers schools that
    receive federal funding. Your school does not, so it does not apply. Signify.one Apps work the
    same way regardless: you can see everything held about a student, ask for it to be corrected, ask
    for it to be deleted, and there is a record of every time a student's information is shown to
    anyone.</p>` : ''}`;

  return shell('Privacy policy', `
<div class="sheet-wrap" style="align-items:start">
  <div class="sheet" style="max-width:48rem">
    ${brand}
    <h1>Privacy policy</h1>
    <p class="muted">Version ${esc(policy.VERSION)} · in effect from ${esc(policy.EFFECTIVE)}</p>

    ${placeholderWarning}

    <p>This explains what <strong>Signify.one Apps</strong> record about the people who use
    them, why, who can see it, and how long it is kept. It is written to be read by a parent or
    a student, not only by a lawyer. “Signify.one Apps” means the apps listed under
    <em>What this covers</em> below — no others.</p>

    <h2>Who runs this</h2>
    ${whoWeAre}

    <h2>Who it is for</h2>
    ${legalBasis}

    <h2>What this covers</h2>
    <ul class="small">${covered}</ul>
    <p class="small muted">These share one sign-in and one class list, so signing in once
    covers all of them.</p>

    <p class="small muted">Only these. Any other app your student uses is a separate thing with
    its own arrangements and is not part of Signify.one Apps, so this policy does not describe it.
    If one is ever brought in, this policy is updated first and the school is told.</p>

    <h2>What is collected</h2>
    <p class="small">Each line accounts for specific fields in the database, and a test refuses
    to let the two drift apart.</p>
    ${collected}

    <h2>What is never done</h2>
    <ul class="small">
      <li>No advertising of any kind. There are no adverts in Signify.one Apps and no advertising
      code in them.</li>
      <li>No profiling. Schoolwork is marked and teachers see the results — that is what the
      apps are for. Nothing goes beyond it: no behavioural profile of a student, no prediction
      about what they will do, and no rating of anyone for any purpose outside the lessons they
      are taking.</li>
      <li>No selling, renting or trading anyone's information, to anyone, ever.</li>
      <li>No app can see another app's work. The map app cannot see what someone did on the
      whiteboard, and never receives it. Signing in is logged centrally, including which app was
      opened, because that is the record of who reached what — but it is kept for security and
      never analysed to build a picture of anyone.</li>
      <li><strong>No home address, postal address, phone number or date of birth is ever asked
      for.</strong> There is no field for any of them anywhere in Signify.one Apps. Everything
      held about a student comes from the school's own records: a name, a school email address,
      and which classes they are in.</li>
      <li>A few places let a member of staff type a short note — why an account was approved, for
      instance. Those are for the administrative reason only, and personal details do not belong
      in them. Anything of that sort in a note is there because a person typed it, not because
      these apps asked for it, and it can be removed on request like anything else.</li>
      <li>No tracking across other websites. There are no third-party trackers, analytics or
      advertising cookies. Even the fonts are served from these servers, so opening a page
      does not report anyone's address to anybody else.</li>
    </ul>

    <h2>Who else is involved</h2>
    <p class="small">Three companies handle this data because they run the infrastructure.
    There is nobody else.</p>
    <ul class="small">
      <li><strong>Google</strong> — signs people in. This is the school's own Google account;
      only the name, email address and profile picture it provides are received.</li>
      <li><strong>Railway</strong> — runs the servers and the database, encrypted at rest.</li>
      <li><strong>Cloudflare</strong> — keeps backup copies, so that a failure at Railway cannot
      lose everything. Each copy is encrypted before it leaves Railway, and Cloudflare is never
      given the key, so what it holds cannot be read.</li>
    </ul>

    <h2>How long it is kept</h2>
    <p class="small">Account records are erased ${esc(retentionDays)} days after someone stops
    using Signify.one Apps, or sooner if the school asks. Erasure runs automatically — it does not wait
    for anyone to remember.</p>
    <p class="small">One thing is kept longer: the record of which records were shown to whom,
    because the point of keeping that is to be able to look back at it. The safety snapshot taken
    automatically before restoring a backup is destroyed after 30 days.</p>
    <p class="small">Backups are kept for four weeks and then deleted automatically, so
    deleted records leave encrypted backups within 30 days. Behaviour notes in Teacher’s Desk
    leave its backups a week after they are deleted.</p>

    <h2>Seeing, correcting and deleting</h2>
    <p class="small">A student, or a parent of a student, may:</p>
    <ul class="small">
      <li><strong>See everything held</strong> about them. It can be produced in one click, as a
      complete file.</li>
      <li><strong>Ask for a correction</strong> if something is wrong.</li>
      <li><strong>Ask for it to be erased.</strong> Once erased it is not restored, even if an older
      backup is later loaded — a request to delete outlives the backups.</li>
    </ul>
    <p class="small">Start with the school office. They hold the controls and can act immediately.</p>

    <h2>Keeping it safe</h2>
    <ul class="small">
      <li>Everything travels encrypted, and the database is encrypted at rest.</li>
      <li>No password is ever stored. Sign-in is handled entirely by the school's Google accounts.</li>
      <li>Sign-in cookies and tokens are stored only as one-way hashes, so a copy of the database
      would not let anyone into an account.</li>
      <li>Backups are encrypted before they leave the servers, and they never include sign-in
      sessions or the keys that sign people in — so even a stolen backup could not be used to
      sign in as anybody.</li>
      <li>Blocking an account ends every session on every device immediately.</li>
      <li>Every administrative action is logged, and the significant ones are shown to
      administrators rather than buried in a log nobody opens.</li>
    </ul>

    <h2>If something goes wrong</h2>
    <p class="small">If data is exposed, the school will be told without delay, along with what
    happened, what was affected and what has been done about it.</p>

    <h2>When this policy would change</h2>
    <p class="small">Four things would change what is written here, and each would mean a new
    version and telling the school first:</p>
    <ul class="small">
      <li>A student <strong>under ${esc(policy.MINIMUM_AGE)}</strong> being given an account —
      children's privacy law would then apply, and considerably more would be required.</li>
      <li>Signify.one Apps being offered to <strong>another school</strong>, which would make
      this a service rather than one person's classroom tools.</li>
      <li>Any <strong>new company</strong> handling the data — an analytics service, an error
      tracker, anything. Today it is Google, Railway and Cloudflare and nobody else.</li>
      <li><strong>Apps sharing a student's work with each other</strong>. Today none of them can:
      each is given only what it needs for its own job. Anything that joined them up would be a
      real change in what is known about a student, so it would be written here before it was
      built.</li>
    </ul>
    <p class="small">This policy is versioned, and the version in force is recorded against the
    school's authorisation, so nobody is treated as having agreed to something they never saw.</p>

    <p class="small faint" style="margin-top:2rem">
      <a href="/privacy">Short version</a> · <a href="/">Back to sign-in</a>
    </p>
  </div>
</div>`);
}

// ---------- asking for an account ----------
// Shown straight after a sign-in that matched no school. The questions come
// from src/access-survey.js; this only lays them out.

function requestAccessPage({ request, apps, values, errors = {} }) {
  const survey = require('./access-survey');
  const v = values ? survey.formValues(values) : survey.valuesFromRequest(request);
  const on = (yes) => (yes ? ' checked' : '');
  const problem = (key) => (errors[key] ? `<div class="field-error">${esc(errors[key])}</div>` : '');
  const host = (url) => { try { return new URL(url).host; } catch { return ''; } };
  const limit = survey.TEXT_LIMIT;
  const radios = (name, options, current) => options.map((o) => `
          <label class="choice"><input type="radio" name="${name}" value="${esc(o.key)}"${on(current === o.key)}>
            <span>${esc(o.label)}</span></label>`).join('');

  const respondents = survey.RESPONDENTS.map((r) => `
          <label class="choice"><input type="radio" name="respondent" value="${esc(r.key)}"${on(v.respondent === r.key)} required>
            <span>${esc(r.label)}</span></label>`).join('');

  const appChoices = (apps || []).map((a) => `
          <label class="choice"><input type="checkbox" name="interested_apps" value="${esc(a.client_id)}"${on(v.interested_apps.includes(a.client_id))}>
            <span>${esc(a.name)} <span class="faint small">${esc(host(a.launch_url))}</span></span></label>`).join('');

  const heard = survey.HEARD_FROM.map((h) => `
          <label class="choice"><input type="radio" name="heard_from" value="${esc(h.key)}"${h.key === 'other' ? ' id="heard_other"' : ''}${on(v.heard_from === h.key)}>
            <span>${esc(h.label)}</span></label>`).join('');

  const subjects = survey.SUBJECTS.map((x) => `
          <label class="choice"><input type="checkbox" name="subjects" value="${esc(x.key)}"${x.key === 'other' ? ' id="subjects_other"' : ''}${on(v.subjects.includes(x.key))}>
            <span>${esc(x.label)}</span></label>`).join('');

  const grades = survey.GRADE_LEVELS.map((g) => `
          <label class="grade-pill"><input type="checkbox" name="grade_levels" value="${esc(g)}"${on(v.grade_levels.includes(g))}><span>${esc(g)}</span></label>`).join('');

  const summary = Object.keys(errors).length ? `
    <div class="notice notice-danger"><strong>A few answers need another look</strong>Each one is marked below.</div>` : '';

  return shell('Ask for an account', `
<div class="sheet-wrap" style="align-items:start">
  <div class="sheet sheet-wide">
    ${brand}
    <h1>Ask for an account</h1>
    <p class="muted">You signed in as <strong>${esc(request.email)}</strong>, which is not part of a
    school using Signify.one Apps yet. A few questions help decide what to set up. Every request is
    read by the person who runs Signify.one Apps.</p>
    ${summary}
    <form class="survey" method="post" action="${survey.PATH}">
      <fieldset>
        <legend>Which describes you?</legend>
        <div class="choice-list">${respondents}
        </div>
        ${problem('respondent')}
      </fieldset>

      <div class="notice notice-info survey-student-note">
        <strong>Student accounts come from a school</strong>
        A student does not ask for an account here. If a teacher would like to use Signify.one Apps
        with a class, the teacher signs in and asks. Send this and nothing more is asked.
      </div>

      <div class="survey-details">
        <fieldset>
          <legend>Which apps are you interested in?</legend>
          <div class="choice-grid">${appChoices}
            <label class="choice"><input type="checkbox" name="interested_apps" value="other" id="apps_other"${on(v.interested_apps.includes('other'))}>
              <span>Something else</span></label>
          </div>
          <div class="other-text other-apps">
            <input type="text" name="interested_other" maxlength="${limit}" value="${esc(v.interested_other)}"
                   placeholder="What are you looking for?" aria-label="What are you looking for?">
          </div>
          ${problem('interested_apps')}
        </fieldset>

        <fieldset>
          <legend>Your school</legend>
          <div class="school-name">
            <input type="text" name="school_name" maxlength="${limit}" value="${esc(v.school_name)}"
                   placeholder="Name of your school" aria-label="Name of your school" autocomplete="organization">
          </div>
          <label class="choice" style="margin-top:.45rem"><input type="checkbox" name="not_at_school" id="not_at_school"${on(v.not_at_school)}>
            <span>I do not work at a school</span></label>
          ${problem('school_name')}
        </fieldset>

        <fieldset>
          <legend>Job title</legend>
          <input type="text" name="job_title" maxlength="${limit}" value="${esc(v.job_title)}"
                 placeholder="For example: Grade 7 science teacher" aria-label="Job title" autocomplete="organization-title">
          ${problem('job_title')}
        </fieldset>

        <fieldset class="school-only">
          <legend>Does your school use Google accounts for staff and students?</legend>
          <div class="choice-grid">${radios('google_accounts', survey.GOOGLE_ACCOUNTS, v.google_accounts)}
          </div>
          <div class="hint">Signify.one Apps sign people in with Google, so this decides whether your school can use them.</div>
          ${problem('google_accounts')}
        </fieldset>

        <fieldset>
          <legend>Who would use the apps? <span class="optional">Optional</span></legend>
          <div class="choice-grid">${radios('usage_scope', survey.USAGE_SCOPE, v.usage_scope)}
          </div>
        </fieldset>

        <fieldset>
          <legend>Roughly how many students? <span class="optional">Optional</span></legend>
          <div class="choice-grid">${radios('student_count', survey.STUDENT_COUNT, v.student_count)}
          </div>
        </fieldset>

        <fieldset>
          <legend>When would you like to start? <span class="optional">Optional</span></legend>
          <div class="choice-grid">${radios('start_when', survey.START_WHEN, v.start_when)}
          </div>
        </fieldset>

        <fieldset>
          <legend>How did you hear about Signify.one? <span class="optional">Optional</span></legend>
          <div class="choice-grid">${heard}
          </div>
          <div class="other-text other-heard">
            <input type="text" name="heard_from_other" maxlength="${limit}" value="${esc(v.heard_from_other)}"
                   placeholder="Where?" aria-label="Where did you hear about Signify.one?">
          </div>
        </fieldset>

        <fieldset>
          <legend>What subjects do you teach? <span class="optional">Optional</span></legend>
          <div class="choice-grid">${subjects}
          </div>
          <div class="other-text other-subjects">
            <input type="text" name="subjects_other" maxlength="${limit}" value="${esc(v.subjects_other)}"
                   placeholder="Which other subjects?" aria-label="Which other subjects?">
          </div>
        </fieldset>

        <fieldset>
          <legend>Which grade levels? <span class="optional">Optional</span></legend>
          <div class="grade-pills">${grades}
          </div>
        </fieldset>
      </div>

      <button class="btn btn-primary" type="submit">Send request</button>
      <p class="small faint" style="margin:1rem 0 0">Only an administrator sees these answers. They are
      cleared ${survey.ANSWER_RETENTION_DAYS} days after the request is decided.
      <a href="/privacy-policy">Privacy policy</a></p>
    </form>
  </div>
</div>`);
}

function requestReceivedPage({ request, apps }) {
  const survey = require('./access-survey');
  const student = request.respondent === 'student';
  const first = String(request.display_name || '').trim().split(/\s+/)[0];

  const appList = (apps || []).map((a) => `
      <li><a href="${esc(a.launch_url)}">${esc(a.name)}</a>${a.description ? ` — ${esc(a.description)}` : ''}</li>`).join('');

  const body = student ? `
    <h1>Student accounts come from a school</h1>
    <p class="muted">Signify.one Apps are used by schools, and a school sets up its students’ accounts.
    Nobody asks for a student account on their own. If your class would like to use them, ask your
    teacher to sign in with their school account and ask for access.</p>` : `
    <h1>Your request is in</h1>
    <p class="muted">Thank you${first ? `, ${esc(first)}` : ''}. Your answers have been sent, and any reply
    goes to <strong>${esc(request.email)}</strong>.</p>
    <h2 style="font-size:1rem;margin-top:1.25rem">What happens next</h2>
    <ol class="steps">
      <li>The person who runs Signify.one Apps reads your request.</li>
      <li>If the apps suit what you need, your account is set up.</li>
      <li>After that, signing in takes you straight to the apps.</li>
    </ol>`;

  return shell('Request received', `
<div class="sheet-wrap" style="align-items:start">
  <div class="sheet sheet-wide">
    ${brand}
    ${body}
    ${appList ? `<h2 style="font-size:1rem;margin-top:1.25rem">The apps</h2>
    <ul class="steps">${appList}
    </ul>` : ''}
    <div class="row" style="gap:.5rem;margin-top:1rem">
      <a class="btn" href="${survey.PATH}?edit=1" style="flex:none">Change my answers</a>
      <a class="btn btn-quiet" href="/privacy-policy" style="flex:none">Privacy policy</a>
    </div>
    <p class="small faint" style="margin:1rem 0 0">Signing in again before the request is decided
    brings you back to this page.</p>
  </div>
</div>`);
}

module.exports = {
  requestAccessPage, requestReceivedPage, shell, esc, errorPage, signinPage, signedOutPage, privacyPage, privacyPolicyPage, brand };
