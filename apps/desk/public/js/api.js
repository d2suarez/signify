// ===================================================================
// Teacher's Desk — talking to the server
// ===================================================================

window.Desk = window.Desk || {};

(function (Desk) {
  'use strict';

  async function request(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });

    let data = null;
    try { data = await res.json(); } catch { /* an empty body is fine */ }

    if (!res.ok) {
      if (res.status === 401) sessionEnded();
      const err = new Error((data && data.error) || `The server said ${res.status}.`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /**
   * The sign-in has ended while a desk was open on screen. Cover the page
   * with a solid log-in screen rather than a toast: the board holds class
   * lists and behaviour notes, and nobody who is logged out should be able to
   * read them over the top of a small red message.
   *
   * Only for a desk that WAS signed in (Desk.app.signedIn, set once the board
   * is up): the very first lookup of a visitor also answers 401, and there is
   * no sign-in to have lost.
   */
  function sessionEnded() {
    if (!Desk.app || !Desk.app.signedIn || document.querySelector('.session-gate')) return;
    const href = (Desk.config && Desk.config.signInUrl) || '/auth/login';
    const gate = document.createElement('div');
    gate.className = 'guest-gate session-gate';
    gate.innerHTML =
      '<aside class="guest-prompt" role="alertdialog" aria-modal="true" aria-label="Log in">' +
        '<div class="guest-prompt-text"><strong>You’ve been logged out.</strong>' +
        '<span>Your desk is hidden until you log in again. Nothing has been lost.</span></div>' +
        '<a class="btn btn--primary guest-prompt-btn"></a></aside>';
    gate.querySelector('a').href = href;
    gate.querySelector('a').textContent = 'Log in';
    document.documentElement.classList.add('session-ended');
    document.body.append(gate);
    gate.querySelector('a').focus();
  }

  /**
   * A desk left open in a tab for hours finds out it is logged out only when
   * it next talks to the server — which may be a click, minutes after the
   * teacher came back to it. Ask the moment the tab is shown again.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !Desk.app || !Desk.app.signedIn) return;
    request('GET', '/api/me').catch(() => { /* a 401 is handled in request() */ });
  });

  /**
   * Uploads one file as a raw body. The name rides in a header rather than a
   * multipart envelope: one file per request means there is no parser here to
   * get wrong, and the server decides what the file IS by sniffing it anyway.
   */
  async function upload(file) {
    const res = await fetch('/api/assets', {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name || 'Untitled'),
      },
      body: file,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401) sessionEnded();
      const err = new Error((data && data.error) || `The server said ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const api = {
    uploadAsset: upload,
    config: () => request('GET', '/api/config'),
    me: () => request('GET', '/api/me'),

    board: () => request('GET', '/api/board'),
    saveBoard: (payload) => request('PUT', '/api/board', payload),
    resetBoard: () => request('POST', '/api/board/reset'),
    boardHistory: () => request('GET', '/api/board/history'),
    restoreBoard: (rev) => request('POST', `/api/board/history/${encodeURIComponent(rev)}/restore`),

    classes: () => request('GET', '/api/classes'),
    members: (key) => request('GET', `/api/classes/${encodeURIComponent(key)}/members`),
    createList: (name, students) => request('POST', '/api/lists', { name, students }),
    updateList: (id, patch) => request('PUT', `/api/lists/${encodeURIComponent(id)}`, patch),
    deleteList: (id) => request('DELETE', `/api/lists/${encodeURIComponent(id)}`),

    reasons: () => request('GET', '/api/behaviour/reasons'),
    saveReasons: (reasons) => request('PUT', '/api/behaviour/reasons', { reasons }),
    behaviour: (classKey, since) => request('GET', `/api/behaviour?classKey=${encodeURIComponent(classKey)}&since=${since || 0}`),
    addBehaviour: (entry) => request('POST', '/api/behaviour', entry),
    deleteBehaviour: (id) => request('DELETE', `/api/behaviour/${encodeURIComponent(id)}`),

    groupings: (classKey) => request('GET', `/api/groupings${classKey ? `?classKey=${encodeURIComponent(classKey)}` : ''}`),
    saveGrouping: (payload) => request('POST', '/api/groupings', payload),
    deleteGrouping: (id) => request('DELETE', `/api/groupings/${encodeURIComponent(id)}`),

    videoTitle: (id) => request('GET', `/api/video/${encodeURIComponent(id)}`),

    weather: (lat, lon, units) => request('GET', `/api/weather?lat=${lat}&lon=${lon}&units=${encodeURIComponent(units || 'metric')}`),
    weatherSearch: (q) => request('GET', `/api/weather/search?q=${encodeURIComponent(q)}`),

    assets: (kind) => request('GET', `/api/assets${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
    deleteAsset: (id) => request('DELETE', `/api/assets/${encodeURIComponent(id)}`),
    renameAsset: (id, label) => request('PUT', `/api/assets/${encodeURIComponent(id)}`, { label }),

    templates: () => request('GET', '/api/templates'),
    saveTemplate: (payload) => request('POST', '/api/templates', payload),
    renameTemplate: (id, name) => request('PUT', `/api/templates/${encodeURIComponent(id)}`, { name }),
    deleteTemplate: (id) => request('DELETE', `/api/templates/${encodeURIComponent(id)}`),
  };

  Desk.api = api;
}(window.Desk));
