// ===================================================================
// Teacher's Desk — a desk opened from Schoology (LTI 1.3)
//
// Loaded first, and only on /lti/desk. The session token arrives in the
// fragment (never sent to a server, never in a Referer), is kept in this
// window's sessionStorage, and travels on every API call as a header. No
// cookie: nothing here signs anybody in to Signify.
// ===================================================================

(function () {
  'use strict';
  const KEY = 'desk:lti-token';
  let token = null;
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{20,})/.exec(location.hash || '');
  try {
    if (m) sessionStorage.setItem(KEY, m[1]);
    token = sessionStorage.getItem(KEY);
  } catch { token = m ? m[1] : null; }
  if (m) history.replaceState(null, '', location.pathname + location.search);
  window.DESK_LTI = { token, header: 'x-desk-lti' };
}());
