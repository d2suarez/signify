// ===================================================================
// Signify ID — asking for an account
//
// Someone who signs in with a Google account no school claims is sent here
// instead of being shown a dead end. They answer a few questions, and the
// answers sit on their access request for an administrator to read.
//
// Three rules shape it:
//
//  - Only the person who just signed in can answer. The page is reached with a
//    short-lived signed cookie naming the account that proved itself to
//    Google, so nobody can fill in a request for an address they do not own.
//
//  - A student is asked nothing beyond "are you a student". Student accounts
//    come from a school; there is no reason to collect a stray student's
//    school, grade or anything else, and every reason not to.
//
//  - Every answer is a fixed choice or a short line of text. There is no open
//    comment box, because an open box is where a home address or a phone
//    number ends up, and the privacy policy says nothing asks for those.
// ===================================================================

const crypto = require('crypto');
const db = require('./db');
const rbac = require('./rbac');
const { config } = require('./config');

const COOKIE = 'rq';
const PATH = '/request-access';
const TOKEN_MS = 2 * 60 * 60 * 1000;
// Stated in the privacy policy. Change both or neither.
const ANSWER_RETENTION_DAYS = 90;
const TEXT_LIMIT = 120;

const RESPONDENTS = [
  { key: 'educator', label: 'I teach or work in education' },
  { key: 'student',  label: 'I am a student' },
  { key: 'other',    label: 'Someone else, such as a parent' },
];

// Signify.one Apps sign people in with Google. This is the answer that
// decides whether a school can use them at all.
const GOOGLE_ACCOUNTS = [
  { key: 'google',    label: 'Yes, Google Workspace' },
  { key: 'microsoft', label: 'No, Microsoft 365' },
  { key: 'other',     label: 'Something else' },
  { key: 'unsure',    label: 'Not sure' },
];

const USAGE_SCOPE = [
  { key: 'own',    label: 'Just my own classes' },
  { key: 'team',   label: 'My department or grade team' },
  { key: 'school', label: 'The whole school' },
  { key: 'unsure', label: 'Not sure yet' },
];

// Ranges rather than a number: enough to plan with, and no more precise than
// the decision needs.
const STUDENT_COUNT = [
  { key: 'under-30', label: 'Fewer than 30' },
  { key: '30-100',   label: '30 to 100' },
  { key: '100-500',  label: '100 to 500' },
  { key: 'over-500', label: 'More than 500' },
];

const START_WHEN = [
  { key: 'now',       label: 'As soon as possible' },
  { key: 'term',      label: 'Later this school year' },
  { key: 'next-year', label: 'Next school year' },
  { key: 'exploring', label: 'Just exploring' },
];

const HEARD_FROM = [
  { key: 'colleague',       label: 'A colleague or friend' },
  { key: 'school',          label: 'My school' },
  { key: 'edtech-unpacked', label: 'The EdTech Unpacked podcast' },
  { key: 'social',          label: 'Social media' },
  { key: 'event',           label: 'A conference or workshop' },
  { key: 'search',          label: 'Searching online' },
  { key: 'other',           label: 'Somewhere else' },
];

const SUBJECTS = [
  { key: 'english',    label: 'English and language arts' },
  { key: 'math',       label: 'Mathematics' },
  { key: 'science',    label: 'Science' },
  { key: 'history',    label: 'History and social studies' },
  { key: 'geography',  label: 'Geography' },
  { key: 'bible',      label: 'Bible and religion' },
  { key: 'languages',  label: 'World languages' },
  { key: 'arts',       label: 'Art and music' },
  { key: 'pe',         label: 'Physical education and health' },
  { key: 'technology', label: 'Technology and computer science' },
  { key: 'sped',       label: 'Special education' },
  { key: 'none',       label: 'I do not teach a subject' },
  { key: 'other',      label: 'Something else' },
];

const GRADE_LEVELS = [...rbac.DEFAULT_YEAR_GROUPS, 'College', 'Adults'];

// ---------- the cookie that says who may answer ----------

function mac(body) {
  return crypto.createHmac('sha256', config.cookieSecret)
    .update('access-request:' + body).digest('base64url');
}

function sign(userId, now = Date.now()) {
  const body = `${userId}.${now + TOKEN_MS}`;
  return `${body}.${mac(body)}`;
}

function verify(token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, given] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^\d+$/.test(exp)) return null;
  const want = Buffer.from(mac(`${userId}.${exp}`));
  const got = Buffer.from(given);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (Number(exp) <= now) return null;
  return userId;
}

function cookieOptions() {
  return { httpOnly: true, secure: config.production, sameSite: 'lax', path: PATH, maxAge: TOKEN_MS };
}

// ---------- reading a form ----------

const toArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String);

// Control characters become spaces, runs of space collapse, and the result is
// capped. Done character by character so no invisible byte survives.
const text = (v) => Array.from(String(v == null ? '' : v))
  .map((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127 ? ' ' : ch; })
  .join('').replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);

const flag = (v) => ['on', '1', 'true', 'yes'].includes(String(v).toLowerCase());
const keyOf = (options, v) => (options.some((o) => o.key === v) ? v : '');

// The apps a person can say they are interested in: whatever the switcher
// would offer, so a new app appears here the moment it is registered.
function surveyApps() {
  return db.many(
    `SELECT client_id, name, launch_url, description FROM apps
      WHERE status = 'active' AND launch_url IS NOT NULL
      ORDER BY sort_order NULLS LAST, name`);
}

const EMPTY = () => ({
  respondent: null,
  interested_apps: [], interested_other: '',
  school_name: '', not_at_school: false, job_title: '',
  google_accounts: '', usage_scope: '', student_count: '', start_when: '',
  heard_from: '', heard_from_other: '',
  subjects: [], subjects_other: '', grade_levels: [],
});

/**
 * Turn a submitted form into answers that are safe to store: unknown keys
 * dropped, text trimmed and capped, "something else" text kept only when
 * "something else" was actually chosen.
 */
function normalise(body, appKeys) {
  const b = body || {};
  const errors = {};
  const answers = EMPTY();

  answers.respondent = keyOf(RESPONDENTS, b.respondent) || null;
  if (!answers.respondent) errors.respondent = 'Choose which of these describes you.';
  if (answers.respondent === 'student') return { ok: true, errors: {}, answers };

  const chosenApps = toArray(b.interested_apps);
  answers.interested_apps = [...appKeys, 'other'].filter((k) => chosenApps.includes(k));
  answers.interested_other = answers.interested_apps.includes('other') ? text(b.interested_other) : '';
  if (!answers.interested_apps.length) {
    errors.interested_apps = 'Choose at least one app, or describe what you are looking for.';
  } else if (answers.interested_apps.length === 1 && answers.interested_apps[0] === 'other' && !answers.interested_other) {
    errors.interested_apps = 'Describe what you are looking for.';
  }

  answers.not_at_school = flag(b.not_at_school);
  answers.school_name = answers.not_at_school ? '' : text(b.school_name);
  answers.job_title = text(b.job_title);
  // Whether a school uses Google means nothing for someone with no school.
  answers.google_accounts = answers.not_at_school ? '' : keyOf(GOOGLE_ACCOUNTS, b.google_accounts);
  answers.usage_scope = keyOf(USAGE_SCOPE, b.usage_scope);
  answers.student_count = keyOf(STUDENT_COUNT, b.student_count);
  answers.start_when = keyOf(START_WHEN, b.start_when);

  if (answers.respondent === 'educator') {
    if (!answers.not_at_school && !answers.school_name) {
      errors.school_name = 'Give the name of your school, or tick that you do not work at one.';
    }
    if (!answers.job_title) errors.job_title = 'Give your job title.';
    if (!answers.not_at_school && !answers.google_accounts) {
      errors.google_accounts = 'Say whether your school uses Google accounts, or choose Not sure.';
    }
  }

  answers.heard_from = keyOf(HEARD_FROM, b.heard_from);
  answers.heard_from_other = answers.heard_from === 'other' ? text(b.heard_from_other) : '';

  const chosenSubjects = toArray(b.subjects);
  answers.subjects = SUBJECTS.map((s) => s.key).filter((k) => chosenSubjects.includes(k));
  answers.subjects_other = answers.subjects.includes('other') ? text(b.subjects_other) : '';

  const chosenGrades = toArray(b.grade_levels);
  answers.grade_levels = GRADE_LEVELS.filter((g) => chosenGrades.includes(g));

  return { ok: Object.keys(errors).length === 0, errors, answers };
}

// What to put back in the form: exactly what was sent after a mistake, or
// what was saved last time, or, on a first visit, the app they came from.
function formValues(body) {
  const b = body || {};
  return {
    respondent: String(b.respondent || ''),
    interested_apps: toArray(b.interested_apps), interested_other: text(b.interested_other),
    school_name: text(b.school_name), not_at_school: flag(b.not_at_school),
    job_title: text(b.job_title),
    google_accounts: String(b.google_accounts || ''), usage_scope: String(b.usage_scope || ''),
    student_count: String(b.student_count || ''), start_when: String(b.start_when || ''),
    heard_from: String(b.heard_from || ''), heard_from_other: text(b.heard_from_other),
    subjects: toArray(b.subjects), subjects_other: text(b.subjects_other),
    grade_levels: toArray(b.grade_levels),
  };
}

function valuesFromRequest(r) {
  if (!r.survey_submitted_at || !r.respondent) {
    return { ...formValues({}), interested_apps: r.came_from_app ? [r.came_from_app] : [] };
  }
  return {
    respondent: r.respondent,
    interested_apps: r.interested_apps || [], interested_other: r.interested_other || '',
    school_name: r.school_name || '', not_at_school: !!r.not_at_school,
    job_title: r.job_title || '',
    google_accounts: r.google_accounts || '', usage_scope: r.usage_scope || '',
    student_count: r.student_count || '', start_when: r.start_when || '',
    heard_from: r.heard_from || '', heard_from_other: r.heard_from_other || '',
    subjects: r.subjects || [], subjects_other: r.subjects_other || '',
    grade_levels: r.grade_levels || [],
  };
}

// ---------- storage ----------

function currentRequest(userId) {
  return db.one(
    `SELECT r.*, u.display_name
       FROM access_requests r JOIN users u ON u.id = r.user_id
      WHERE r.user_id = $1 AND r.status = 'pending' AND u.deleted_at IS NULL
      ORDER BY r.requested_at DESC LIMIT 1`, [userId]);
}

function save(requestId, a) {
  return db.one(
    `UPDATE access_requests
        SET respondent = $2, interested_apps = $3, interested_other = $4,
            school_name = $5, not_at_school = $6, job_title = $7,
            heard_from = $8, heard_from_other = $9,
            subjects = $10, subjects_other = $11, grade_levels = $12,
            google_accounts = $13, usage_scope = $14, student_count = $15, start_when = $16,
            survey_submitted_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [requestId, a.respondent, a.interested_apps, a.interested_other,
      a.school_name, a.not_at_school, a.job_title,
      a.heard_from, a.heard_from_other,
      a.subjects, a.subjects_other, a.grade_levels,
      a.google_accounts, a.usage_scope, a.student_count, a.start_when]);
}

// The answers exist to decide the request. Once it is decided they are kept
// long enough to look back at, then cleared. The request itself stays, so the
// record of who asked and what was decided is not lost.
async function clearDecidedAnswers(days = ANSWER_RETENTION_DAYS) {
  const { rowCount } = await db.query(
    `UPDATE access_requests
        SET respondent = NULL, interested_apps = '{}', interested_other = '',
            school_name = '', not_at_school = false, job_title = '',
            google_accounts = '', usage_scope = '', student_count = '', start_when = '',
            heard_from = '', heard_from_other = '',
            subjects = '{}', subjects_other = '', grade_levels = '{}'
      WHERE status <> 'pending'
        AND decided_at IS NOT NULL
        AND decided_at < now() - ($1 || ' days')::interval
        AND (respondent IS NOT NULL OR school_name <> '' OR job_title <> ''
             OR google_accounts <> '' OR usage_scope <> '' OR student_count <> '' OR start_when <> ''
             OR cardinality(interested_apps) > 0 OR cardinality(subjects) > 0
             OR cardinality(grade_levels) > 0)`,
    [days]);
  return rowCount;
}

// ---------- telling super admins ----------

/**
 * How many open requests a super admin has not seen yet. A request counts as
 * new when it arrived, or when its questions were answered, at or after the
 * moment that admin last opened the Requests page. Someone who has never
 * looked sees them all.
 *
 * "At or after", not "after": an answer landing in the same instant as the
 * look may not have been on the page, and a spare notice is harmless where a
 * swallowed request is not.
 */
async function newRequestsFor(userId) {
  const row = await db.one(
    `SELECT COUNT(*)::int AS n
       FROM access_requests r
       JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
       LEFT JOIN platform_admins pa ON pa.user_id = $1
      WHERE r.status = 'pending'
        AND (pa.requests_seen_at IS NULL
             OR r.requested_at >= pa.requests_seen_at
             OR r.survey_submitted_at >= pa.requests_seen_at)`, [userId]);
  return { count: row ? Number(row.n) : 0 };
}

// Every request with its answers, for the console. Selects r.* on purpose:
// the page used to name its columns one by one, and the four planning answers
// were saved correctly yet never reached it because nobody added them there.
// A new answer column must not need remembering in a second place.
function listRequests() {
  return db.many(
    `SELECT r.*, u.display_name, u.picture_url,
            d.email AS decided_by_email, t.name AS tenant_name
       FROM access_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users d ON d.id = r.decided_by
       LEFT JOIN tenants t ON t.id = r.tenant_id
      WHERE u.deleted_at IS NULL
      ORDER BY (r.status = 'pending') DESC, r.last_seen_at DESC
      LIMIT 200`);
}

// `at` should be the moment BEFORE the list was read. Stamping the time after
// reading it would mark as seen anything answered while the page was loading.
function markRequestsSeen(userId, at) {
  return db.query(
    'UPDATE platform_admins SET requests_seen_at = COALESCE($2, now()) WHERE user_id = $1', [userId, at || null]);
}

// Answers put into words for the console, so it never has to know what a
// stored key such as "edtech-unpacked" stands for.
function describe(row, apps) {
  const list = apps || [];
  const appName = (k) => (list.find((a) => a.client_id === k) || {}).name || k;
  const label = (options, key) => (options.find((o) => o.key === key) || {}).label || '';
  const answered = !!row.survey_submitted_at && !!row.respondent;
  const withOther = (keys, named, otherText) => keys.filter((k) => k !== 'other').map(named)
    .concat(keys.includes('other') ? [otherText || 'Something else'] : []);
  const when = (value) => (answered ? value : '');

  return {
    answered,
    cameFrom: row.came_from_app ? appName(row.came_from_app) : '',
    respondent: when(row.respondent),
    respondentLabel: when(label(RESPONDENTS, row.respondent)),
    apps: answered ? withOther(row.interested_apps || [], appName, row.interested_other) : [],
    school: when(row.not_at_school ? 'Does not work at a school' : row.school_name || ''),
    jobTitle: when(row.job_title || ''),
    googleAccountsKey: when(row.google_accounts || ''),
    googleAccounts: when(label(GOOGLE_ACCOUNTS, row.google_accounts)),
    usageScope: when(label(USAGE_SCOPE, row.usage_scope)),
    studentCount: when(label(STUDENT_COUNT, row.student_count)),
    startWhen: when(label(START_WHEN, row.start_when)),
    heardFrom: when(row.heard_from === 'other'
      ? row.heard_from_other || 'Somewhere else' : label(HEARD_FROM, row.heard_from)),
    subjects: answered ? withOther(row.subjects || [], (k) => label(SUBJECTS, k), row.subjects_other) : [],
    gradeLevels: answered ? row.grade_levels || [] : [],
  };
}

module.exports = {
  COOKIE, PATH, TOKEN_MS, ANSWER_RETENTION_DAYS, TEXT_LIMIT,
  RESPONDENTS, GOOGLE_ACCOUNTS, USAGE_SCOPE, STUDENT_COUNT, START_WHEN, HEARD_FROM, SUBJECTS, GRADE_LEVELS,
  sign, verify, cookieOptions,
  surveyApps, normalise, formValues, valuesFromRequest,
  currentRequest, save, clearDecidedAnswers,
  listRequests, newRequestsFor, markRequestsSeen, describe,
};
