// ===================================================================
// Signify ID — sign-in, sign-out, and the session middleware
//
// Google is the only identity provider today. It is deliberately isolated in
// verifyGoogle() below: adding Microsoft, Clever or ClassLink later means
// another function of the same shape returning the same profile object, and
// nothing downstream changes.
// ===================================================================

const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');
const views = require('./views');
const audit = require('./audit');
const sessions = require('./sessions');
const identity = require('./identity');
const survey = require('./access-survey');
const { config } = require('./config');

const router = express.Router();
const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

// Only allow onward redirects to paths on this service. Without this check an
// attacker can hand a teacher a sign-in link that bounces to their own site.
//
// Rejecting a leading "//" is not enough on its own. Browsers normalise a
// backslash to a forward slash while parsing a URL, so "/\\evil.example" is
// read as "//evil.example" — a protocol-relative address, and an open redirect
// out of the sign-in flow. Control characters are stripped during parsing for
// the same reason, so "/\tevil" has to go too. What is left is a single
// leading slash followed by ordinary path characters.
function safeContinue(value, fallback = '/admin') {
  const v = String(value || '');
  if (!v.startsWith('/')) return fallback;
  if (v.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f\x7f]/.test(v)) return fallback;
  return v;
}

// ---------- provider adapters ----------

async function verifyGoogle(credential) {
  if (!googleClient) throw new Error('Google sign-in is not configured on this server.');
  const ticket = await googleClient.verifyIdToken({
    idToken: String(credential || ''),
    audience: config.googleClientId,
  });
  const p = ticket.getPayload();
  if (!p || !p.email) throw new Error('That Google account did not provide an email address.');
  if (!p.email_verified) throw new Error('That Google account has no verified email address.');
  return {
    provider: 'google',
    subject: p.sub,
    email: p.email,
    name: p.name,
    givenName: p.given_name,
    familyName: p.family_name,
    picture: p.picture,
    // Present only for Google Workspace accounts. Used to tell a genuine
    // school account from a personal one wearing the same domain.
    hostedDomain: p.hd || '',
  };
}

// ---------- the shared tail of every sign-in ----------

async function completeSignIn(req, res, profile, continueTo) {
  const resolved = await identity.resolveUser(profile, { ip: req.ip });
  if (!resolved.ok) {
    await audit.record({
      actorEmail: identity.lower(profile.email),
      action: 'signin.refused',
      detail: { code: resolved.code, provider: profile.provider },
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    return res.status(403).json({ error: resolved.message });
  }

  const user = resolved.user;
  await identity.ensureMembership(user.id, user.email, profile.hostedDomain);

  // Bootstrap: an address named in SUPER_ADMINS becomes a platform admin the
  // first time it signs in, so a fresh deployment is never locked out.
  if (config.superAdmins.includes(user.email)) {
    const already = await identity.isPlatformAdmin(user.id);
    if (!already) {
      await db.query(
        'INSERT INTO platform_admins (user_id, note) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
        [user.id, 'Bootstrapped from the SUPER_ADMINS environment variable']
      );
      await db.query("UPDATE users SET is_minor = false, minor_source = 'admin_set' WHERE id = $1", [user.id]);
      await audit.record({
        actorUserId: user.id, actorEmail: user.email,
        action: 'platform_admin.bootstrapped', targetType: 'user', targetId: user.id,
        detail: { source: 'SUPER_ADMINS' }, ip: req.ip,
      });
    }
  }

  const access = await identity.accessFor(user.id);
  const block = identity.loginBlock(access);
  if (block) {
    // Nobody's address matches a school here. Rather than a dead end, the
    // attempt becomes a request an administrator can see and act on — and a
    // second attempt bumps the same request rather than making a new one.
    if (block.code === 'no_tenant') {
      // Which app they were on their way to, if any — it is the obvious
      // first answer to "which apps are you interested in".
      let cameFrom = null;
      const fromApp = /[?&]client_id=([^&]+)/.exec(safeContinue(continueTo));
      if (fromApp) {
        try {
          const known = await db.one('SELECT client_id FROM apps WHERE client_id = $1', [decodeURIComponent(fromApp[1])]);
          cameFrom = known ? known.client_id : null;
        } catch { /* a malformed client_id names no app */ }
      }

      await db.query(
        `INSERT INTO access_requests (user_id, email, came_from_app) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) WHERE status = 'pending'
         DO UPDATE SET attempts = access_requests.attempts + 1, last_seen_at = now(),
                       came_from_app = COALESCE(EXCLUDED.came_from_app, access_requests.came_from_app)`,
        [user.id, user.email, cameFrom]);
      block.message = 'Your account is not attached to a school yet.';

      // Rather than a dead end, a few questions. The signed cookie is the only
      // way onto that page, and only this sign-in can have produced it.
      res.cookie(survey.COOKIE, survey.sign(user.id), survey.cookieOptions());
      block.next = survey.PATH;
    }

    await audit.record({
      actorUserId: user.id, actorEmail: user.email,
      tenantId: access.membership ? access.membership.tenant_id : null,
      action: block.code === 'no_tenant' ? 'access.requested' : 'signin.blocked',
      detail: { code: block.code }, ip: req.ip,
    });
    return res.status(403).json({ error: block.message, code: block.code, next: block.next });
  }

  const session = await sessions.create(user.id, {
    ip: req.ip, userAgent: req.get('user-agent'), isMinor: access.user.isMinor,
  });
  res.cookie(sessions.COOKIE, session.raw, sessions.cookieOptions(session.absoluteMs));
  sessions.issueCsrf(res);

  const next = safeContinue(continueTo);
  const forApp = /[?&]client_id=([^&]+)/.exec(next);

  await audit.record({
    actorUserId: user.id, actorEmail: user.email,
    tenantId: access.membership ? access.membership.tenant_id : null,
    action: 'signin.ok',
    detail: {
      provider: profile.provider,
      created: !!resolved.created,
      linked: !!resolved.linked,
      // Where this sign-in was headed. Without it the log cannot tell a
      // sign-in that began at an app from one that began here, which is
      // exactly the question when somebody is left on the wrong site.
      destination: forApp ? decodeURIComponent(forApp[1]) : 'console',
    },
    ip: req.ip, userAgent: req.get('user-agent'),
  });

  return res.json({ ok: true, next });
}

// ---------- routes ----------

router.get('/signin', async (req, res) => {
  const continueTo = safeContinue(req.query.continue);
  const cookies = sessions.parseCookies(req);
  const existing = await sessions.touch(cookies[sessions.COOKIE]);

  // Sensitive operations ask for a recent sign-in. `reauth=1` ends the current
  // session so Google is asked again, rather than bouncing straight back with
  // the same stale session and no way forward.
  if (existing && req.query.reauth === '1') {
    await sessions.revoke(existing.id, 'reauth');
    await audit.record({ actorUserId: existing.user_id, action: 'signin.reauth_requested', ip: req.ip });
    res.clearCookie(sessions.COOKIE, { path: '/' });
    res.set('Cache-Control', 'no-store');
    return res.send(views.signinPage({ continueTo, reauth: true }));
  }

  // Already signed in and nothing special asked for? Go straight through.
  if (existing) return res.redirect(continueTo);

  // If the sign-in was triggered by an app, name it so the person knows what
  // they are agreeing to open.
  let appName = '';
  const m = /[?&]client_id=([^&]+)/.exec(continueTo);
  if (m) {
    const app = await db.one('SELECT name FROM apps WHERE client_id = $1', [decodeURIComponent(m[1])]);
    if (app) appName = app.name;
  }

  res.set('Cache-Control', 'no-store');
  res.send(views.signinPage({ continueTo, appName }));
});

router.post('/auth/google', async (req, res) => {
  try {
    const profile = await verifyGoogle((req.body || {}).credential);
    return await completeSignIn(req, res, profile, (req.body || {}).continue);
  } catch (e) {
    console.error('Google sign-in failed:', e.message);
    return res.status(401).json({ error: 'Google could not confirm that sign-in. Please try again.' });
  }
});

// Local development only. config.js refuses to enable this on Railway.
router.post('/auth/dev', async (req, res) => {
  if (!config.allowDevLogin) return res.status(404).json({ error: 'Not available.' });
  const email = identity.lower((req.body || {}).email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  return completeSignIn(req, res, {
    provider: 'dev',
    subject: 'dev:' + email,
    email,
    name: email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    hostedDomain: email.split('@')[1],
  }, (req.body || {}).continue);
});

// ---------- asking for an account ----------
// Reached only straight after a verified Google sign-in that matched no
// school, carrying a short-lived signed cookie naming who signed in.

function surveyUser(req) {
  return survey.verify(sessions.parseCookies(req)[survey.COOKIE]);
}

router.get('/request-access', async (req, res) => {
  const userId = surveyUser(req);
  if (!userId) return res.redirect('/signin');
  const request = await survey.currentRequest(userId);
  if (!request) {
    // Decided since they last looked. Signing in again says what happened.
    res.clearCookie(survey.COOKIE, { path: survey.PATH });
    return res.redirect('/signin');
  }

  const apps = await survey.surveyApps();
  res.set('Cache-Control', 'no-store');
  if (request.survey_submitted_at && request.respondent && req.query.edit !== '1') {
    return res.send(views.requestReceivedPage({ request, apps }));
  }
  res.send(views.requestAccessPage({ request, apps }));
});

router.post('/request-access', async (req, res) => {
  const userId = surveyUser(req);
  if (!userId) return res.redirect(303, '/signin');
  const request = await survey.currentRequest(userId);
  if (!request) return res.redirect(303, '/signin');

  const apps = await survey.surveyApps();
  const result = survey.normalise(req.body, apps.map((a) => a.client_id));
  res.set('Cache-Control', 'no-store');
  if (!result.ok) {
    return res.status(400).send(views.requestAccessPage({ request, apps, values: req.body, errors: result.errors }));
  }

  await survey.save(request.id, result.answers);
  // Only the kind of respondent goes in the log. The answers themselves stay
  // on the request, where the retention sweep can clear them.
  await audit.record({
    actorUserId: userId, actorEmail: request.email,
    action: 'access.request_answered', targetType: 'user', targetId: userId,
    detail: { respondent: result.answers.respondent }, ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.redirect(303, survey.PATH);
});

router.get('/logout', async (req, res) => {
  const cookies = sessions.parseCookies(req);
  const raw = cookies[sessions.COOKIE];
  if (raw) {
    const s = await sessions.touch(raw);
    if (s) {
      await sessions.revoke(s.id, 'logout');
      await audit.record({ actorUserId: s.user_id, action: 'signout', ip: req.ip });
    }
  }
  res.clearCookie(sessions.COOKIE, { path: '/' });
  res.clearCookie(sessions.CSRF_COOKIE, { path: '/' });

  // RP-initiated logout: an app may hand us where to return to, but only an
  // address it has registered.
  const target = String(req.query.post_logout_redirect_uri || '');
  let leaving = null;
  if (target) {
    const app = await db.one(
      'SELECT name, post_logout_uris FROM apps WHERE $1 = ANY(post_logout_uris)', [target]);
    if (app) return res.redirect(target);

    // Not registered, so it is not safe to redirect to. But an app whose
    // sign-in address shares this origin is still a known app, and naming it
    // beats dropping the person on a page whose only way forward is the admin
    // console — which is where every logout used to end.
    try {
      const origin = new URL(target).origin;
      leaving = await db.one(
        `SELECT name, redirect_uris FROM apps
          WHERE status = 'active'
            AND EXISTS (SELECT 1 FROM unnest(redirect_uris) u WHERE u LIKE $1)`,
        [origin + '/%']);
    } catch { /* an unparseable address tells us nothing */ }
  }

  res.set('Cache-Control', 'no-store');
  res.send(views.signedOutPage(leaving
    ? { appName: leaving.name, backTo: new URL(leaving.redirect_uris[0]).origin + '/auth/login' }
    : {}));
});

router.get('/privacy', (req, res) => {
  res.send(views.privacyPage({ retentionDays: config.retentionDays }));
});

// The full policy, at a stable public address. COPPA expects one that does
// not move, and a school's own privacy notice will link to it.
router.get('/privacy-policy', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.send(views.privacyPolicyPage({ retentionDays: config.retentionDays }));
});

// ---------- middleware ----------

// Attaches req.actor for anything behind a browser session. Every request
// re-reads the account, so a block or role change lands immediately rather
// than at the next sign-in.
async function attachActor(req, res, next) {
  try {
    const cookies = sessions.parseCookies(req);
    const session = await sessions.touch(cookies[sessions.COOKIE]);
    if (!session) return next();

    const access = await identity.accessFor(session.user_id);
    if (!access || identity.loginBlock(access)) return next();

    req.actor = {
      sessionId: session.id,
      userId: access.user.id,
      email: access.user.email,
      name: access.user.name,
      picture: access.user.picture,
      isMinor: access.user.isMinor,
      isSuper: access.isSuper,
      tenantId: access.membership ? access.membership.tenant_id : null,
      tenantName: access.membership ? access.membership.tenant_name : null,
      role: access.isSuper ? 'super_admin' : (access.membership ? access.membership.role_key : null),
      roleLabel: access.isSuper ? 'Super admin' : (access.membership ? access.membership.role_label : null),
      perms: access.perms,
      memberships: access.memberships,
    };
    next();
  } catch (e) {
    console.error('Session lookup failed:', e.message);
    next();
  }
}

module.exports = { router, attachActor, safeContinue, verifyGoogle };
