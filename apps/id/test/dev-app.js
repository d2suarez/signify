// ===================================================================
// A stand-in Signify app, so the round trip a real app makes can be walked
// locally: /auth/login -> id /authorize -> the sign-in page -> the code ->
// /auth/callback -> back to the page you started on.
//
// It uses the same client library maps and desk use, unmodified. Run the ID
// server first (node test/dev-server.js), then this, then open :3011.
// ===================================================================

process.env.SIGNIFY_ISSUER = 'http://localhost:3010';
process.env.SIGNIFY_CLIENT_ID = 'demo-app';
process.env.SIGNIFY_CLIENT_SECRET = 'demo-secret';
process.env.SIGNIFY_REDIRECT_URI = 'http://localhost:3011/auth/callback';
process.env.SIGNIFY_COOKIE_SECRET = 'dev'.repeat(16);

const express = require('express');
const signify = require('../client/signify-auth');

const app = express();
signify.mount(app);
app.use(signify.middleware);   // mount() adds the routes; this is what fills req.user

app.get('/', (req, res) => {
  const who = req.user;
  res.set('Cache-Control', 'no-store').send(`<!doctype html>
<meta charset="utf-8"><title>Demo App</title>
<style>body{font:16px/1.5 system-ui;margin:3rem auto;max-width:34rem}
a,button{font:inherit;padding:.5rem .9rem;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer}</style>
<h1>Demo App</h1>
<p>Landed at <code>${req.originalUrl}</code></p>
${who
  ? `<p><strong>Signed in:</strong> ${who.name} &lt;${who.email}&gt;</p><p><a href="/auth/logout">Sign out</a></p>`
  : `<p>Not signed in.</p><p><a href="/auth/login?return=/">Sign in with your school account</a></p>`}
<p><a href="/deep?x=1">A deeper page</a> (tests coming back to where you started)</p>`);
});

app.get('/deep', signify.requireUser, (req, res) => {
  res.set('Cache-Control', 'no-store')
    .send(`<h1>Deep page</h1><p>Signed in as ${req.user.email}</p><p>URL: <code>${req.originalUrl}</code></p>`);
});

app.listen(3011, () => console.log('Demo app on http://localhost:3011'));
