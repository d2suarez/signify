// ===================================================================
// Teacher's Desk — Signify Learning's door (server/learning.js)
//   node test/learning.js
//
// Its own file, and its checks one after another: they stub global fetch
// (Signify ID's answers), which run.js's async checks would race.
// ===================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-learning-'));
delete process.env.RAILWAY_ENVIRONMENT;
process.env.NODE_ENV = 'test';

const { describe, it: itNow, assert, equal, report } = require('./harness');
const board = require('../server/board');
const roster = require('../server/roster');

let chain = Promise.resolve();
const it = (name, fn) => itNow(name, () => { const p = chain.then(fn); chain = p.catch(() => {}); return p; });

describe('seating plans for Signify Learning', () => {
  const crypto = require('crypto');
  const signify = require('../signify-auth');
  const learning = require('../server/learning');
  const realFetch = global.fetch;
  const plan = () => ({ desks: [{ id: 'dA', shape: 'row', seats: 2, facing: 'up', x: 4, y: 6 }, { id: 'dB', shape: 'table', seats: 4, facing: 'up', x: 20, y: 6 }], objects: [], front: 'top', seats: { 'dA#0': 'p1', 'dA#1': 'p2' } });
  const students = [{ id: 'p1', name: 'Ana Ruiz' }, { id: 'p2', name: 'Ana Smith' }, { id: 'p3', name: 'Ben Ode' }];
  const seatingItem = (plans) => ({ id: 'wS', type: 'seating', x: 0, y: 0, w: 6, h: 7, state: { classKey: 'signify:c1', plans, room: 'medium' } });

  // A real RS256 key, so verify() is tested as it runs.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
  const mint = (claims) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${b}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey).toString('base64url')}`;
  };
  const base = () => ({ iss: 'https://id.test', aud: 'signify-learning', typ: 'id', exp: Math.floor(Date.now() / 1000) + 600, sub: 'u-teach', role: 'teacher', tenant_id: 't1' });

  it('trusts only a Signify ID token minted for Learning', async () => {
    const was = signify.ISSUER;
    signify.ISSUER = 'https://id.test';
    try {
      const getKeys = async () => [jwk];
      assert(await learning.verify(mint(base()), { getKeys }), 'Learning\'s token is accepted');
      equal(await learning.verify(mint({ ...base(), aud: 'teachers-desk' }), { getKeys }), null, 'the desk\'s own token is not this door');
      equal(await learning.verify(mint({ ...base(), aud: 'helpdesk' }), { getKeys }), null, 'nor another app\'s');
      equal(await learning.verify(mint({ ...base(), iss: 'https://evil.test' }), { getKeys }), null);
      equal(await learning.verify(mint({ ...base(), exp: 1 }), { getKeys }), null, 'expired');
      equal(await learning.verify(mint({ ...base(), typ: 'access' }), { getKeys }), null);
      const t = mint(base()); const forged = t.slice(0, -4) + (t.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      equal(await learning.verify(forged, { getKeys }), null, 'a bad signature');
    } finally { signify.ISSUER = was; }
  });

  // The routes, with Signify ID stubbed: what it says about the class decides.
  const call = async (handler, { method = 'GET', body, classId = 'c1', vouched = true, role = 'teacher', tools = ['seating'], classes, members } = {}) => {
    const wasOn = signify.ENABLED; const wasIss = signify.ISSUER;
    signify.ENABLED = true; signify.ISSUER = 'https://id.test';
    roster._forget('');
    global.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/classes')) return classes === 'down' ? { ok: false, status: 503, text: async () => '' } : { ok: true, json: async () => ({ classes: classes || [{ id: 'c1', name: 'Bible 9', role: 'teacher' }] }) };
      if (u.includes('/members')) return members === 'down' ? { ok: false, status: 503, text: async () => '' } : { ok: true, json: async () => ({ members: (members || students).map((s) => ({ id: s.id, display_name: s.name, role: 'student' })) }) };
      throw new Error(`unexpected fetch ${u}`);
    };
    const req = { method, params: { classId }, body, headers: {}, signifyToken: 'tok', deskTools: new Set(tools),
      user: { id: 'u-learn', email: 'l@school.test', role, tenantId: 't1', perms: {}, ...(vouched ? { vouchedBy: 'signify-learning' } : {}) } };
    const res = { code: 200, headers: {}, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
    try { await handler(req, res); } finally { global.fetch = realFetch; signify.ENABLED = wasOn; signify.ISSUER = wasIss; roster._forget(''); }
    return res;
  };
  const teacherUser = { uid: 'u-learn', email: 'l@school.test', tenantId: 't1' };

  it('serves the teacher\'s plan for a class Signify ID says they teach, and nothing else', async () => {
    const b = board.boardFor(teacherUser);
    board.saveBoard(teacherUser, { rev: b.rev, items: [seatingItem({ 'signify:c1': plan() })] });
    const res = await call(learning.getSeating);
    equal(res.code, 200);
    equal(res.body.chart.desks.length, 2);
    equal(res.headers['Cache-Control'], 'no-store');
    equal((await call(learning.getSeating, { vouched: false })).code, 401, 'a browser\'s desk cookie is not enough');
    equal((await call(learning.getSeating, { role: 'student' })).code, 403);
    equal((await call(learning.getSeating, { tools: [] })).code, 403, 'a school that turned seating off');
    equal((await call(learning.getSeating, { classes: [{ id: 'c9', name: 'Other', role: 'teacher' }] })).code, 403, 'not their class');
    equal((await call(learning.getSeating, { classes: [{ id: 'c1', name: 'Bible 9', role: 'student' }] })).code, 403, 'in the class, but not teaching it');
    equal((await call(learning.getSeating, { classes: 'down' })).code, 502, 'ID down is not "no class"');
    equal((await call(learning.getSeating, { members: 'down' })).code, 502, 'silence is not an empty class');
  });

  it('moves a seat back onto the desk through the rev-checked save, and refuses a stale one', async () => {
    const rev = board.boardFor(teacherUser).rev;
    const res = await call(learning.putSeating, { method: 'PUT', body: { widgetId: 'wS', rev, pupil: 'p3', seat: 'dB#1' } });
    equal(res.code, 200);
    equal(board.boardFor(teacherUser).rev, rev + 1, 'the desk moved on a revision, so an open desk tab reloads');
    equal(board.boardFor(teacherUser).items[0].state.plans['signify:c1'].seats['dB#1'], 'p3');
    equal(res.body.chart.rev, rev + 1);
    const stale = await call(learning.putSeating, { method: 'PUT', body: { widgetId: 'wS', rev, pupil: 'p1', seat: 'dB#2' } });
    equal(stale.code, 409);
    equal(stale.body.chart.rev, rev + 1, 'with the current chart to show');
    equal((await call(learning.putSeating, { method: 'PUT', body: { widgetId: 'wS', rev: rev + 1, pupil: 'stranger', seat: 'dB#2' } })).code, 400, 'only a pupil in the class');
  });
});

describe('the rail frame, signed in by Learning (server/embed.js)', () => {
  const embed = require('../server/embed');
  const auth = require('../server/auth');
  const exp = Math.floor(Date.now() / 1000) + 600;
  const tok = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const resOf = () => ({ code: 200, headers: {}, cookies: [], body: null,
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; }, append(k, v) { if (k === 'Set-Cookie') this.cookies.push(v); return this; } });
  const vouched = (role, extra = {}) => ({ headers: {}, signifyToken: tok,
    user: { id: `u-${role}`, email: `${role}@school.test`, role, tenantId: 't1', perms: {}, vouchedBy: 'signify-learning', ...extra } });
  const mint = async (req, isOpen = async () => true) => { const res = resOf(); await embed.mintTicket(req, res, { isOpen }); return res; };
  const hdr = (h) => (k) => h[k.toLowerCase()];
  const redeemReq = (ticket, h = { 'sec-fetch-site': 'same-origin' }) => ({ body: { ticket }, get: hdr(h), protocol: 'https', headers: h });
  const pageReq = (cookie, referer, path = '/api/board') => {
    const h = { cookie, host: 'desk.test', ...(referer ? { referer } : {}) };
    return { path, headers: h, get: hdr(h), user: null };
  };

  it('gives Learning a one-use ticket only for a person Signify ID lets open the desk', async () => {
    equal((await mint({ headers: {}, user: { id: 'x', role: 'teacher', perms: {} }, signifyToken: tok })).code, 401, 'a desk cookie is not Learning');
    equal((await mint(vouched('guardian'))).code, 403, 'parents get no desk');
    equal((await mint(vouched('teacher'), async () => false)).code, 403, 'the desk app is off for them in Signify ID');
    equal((await mint(vouched('teacher'), async () => null)).code, 502, 'ID down is not "no"');
    const ok = await mint(vouched('teacher'));
    equal(ok.code, 200);
    assert(/^[\w-]{40,}$/.test(ok.body.ticket), 'a long random ticket');
    equal(ok.body.until, exp * 1000, 'lasts as long as Learning\'s token');
    equal(ok.headers['Cache-Control'], 'no-store');
  });

  it('trades a ticket once, same origin only, for a cookie the /embed page alone uses', async () => {
    const { ticket } = (await mint(vouched('teacher'))).body;
    equal((() => { const r = resOf(); embed.redeem(redeemReq(ticket, { 'sec-fetch-site': 'cross-site' }), r); return r.code; })(), 403, 'another site cannot plant it');
    const { ticket: t2 } = (await mint(vouched('teacher'))).body;
    const r = resOf(); embed.redeem(redeemReq(t2), r);
    equal(r.code, 200);
    const sid = /desk_emb=([\w-]+)/.exec(r.cookies[0])[1];
    assert(/HttpOnly/.test(r.cookies[0]) && /SameSite=Lax/.test(r.cookies[0]), 'HttpOnly, Lax (signify.one siblings are one site)');
    const again = resOf(); embed.redeem(redeemReq(t2), again);
    equal(again.code, 401, 'a ticket works once');

    const fromEmbed = pageReq(`desk_emb=${sid}`, 'https://desk.test/embed?tools=timer&from=x');
    embed.identify(fromEmbed, {}, () => {});
    equal(fromEmbed.user && fromEmbed.user.id, 'u-teacher', 'the /embed page is that person');
    equal(fromEmbed.signifyToken, tok, 'class lists are asked for with Learning\'s token');
    equal(fromEmbed.user.vouchedBy, undefined, 'and it is not Learning\'s server door');
    equal(auth.canOpen(fromEmbed), true, 'staff may open their desk');
    equal(auth.can(fromEmbed, 'desk:behaviour', 'class'), false, 'but behaviour notes need the desk\'s own sign-in');

    for (const [what, req] of [
      ['a desk tab', pageReq(`desk_emb=${sid}`, 'https://desk.test/')],
      ['no Referer', pageReq(`desk_emb=${sid}`, null)],
      ['another host', pageReq(`desk_emb=${sid}`, 'https://evil.test/embed')],
      ['Learning\'s server door', pageReq(`desk_emb=${sid}`, 'https://desk.test/embed', '/api/learning/seating/c1')],
      ['an unknown session', pageReq('desk_emb=nope', 'https://desk.test/embed')],
    ]) { embed.identify(req, {}, () => {}); equal(req.user, null, `not for ${what}`); }

    const signedIn = { ...pageReq(`desk_emb=${sid}`, 'https://desk.test/embed'), user: { id: 'own-desk-sign-in' } };
    embed.identify(signedIn, {}, () => {});
    equal(signedIn.user.id, 'own-desk-sign-in', 'a real desk sign-in wins');
  });

  it('a student comes with no permissions: their school\'s student tools decide', async () => {
    const { ticket } = (await mint(vouched('student'))).body;
    const r = resOf(); embed.redeem(redeemReq(ticket), r);
    const sid = /desk_emb=([\w-]+)/.exec(r.cookies[0])[1];
    const req = pageReq(`desk_emb=${sid}`, 'https://desk.test/embed');
    embed.identify(req, {}, () => {});
    equal(req.user.role, 'student');
    equal(JSON.stringify(req.user.perms), '{}');
    req.deskTools = new Set();
    equal(auth.canOpen(req), false, 'every tool off for students closes it');
    req.deskTools = new Set(['timer']);
    equal(auth.canOpen(req), true);
  });
});

report();
