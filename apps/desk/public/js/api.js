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
      if (res.status === 401 && data && data.signedOut) signInAgain();
      const err = new Error((data && data.error) || `The server said ${res.status}.`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /**
   * The server has told us this sign-in is over and cleared its cookies, so a
   * reload lands on the sign-in page. The teacher was doing this by hand.
   *
   * Guarded by a timestamp, because a reload that came back to the same answer
   * would otherwise spin: if it happens twice inside a minute, something else
   * is wrong and a stuck page is easier to report than a flickering one.
   */
  function signInAgain() {
    const KEY = 'desk:reauth';
    let last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch { /* private mode */ }
    if (Date.now() - last < 60_000) return;
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ }
    window.location.reload();
  }

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
