// ===================================================================
// Teacher's Desk — the page Schoology shows inside its frame.
//
// A desk needs a whole window (and Google sign-in refuses to run in a
// frame), so this page only opens one. Students: their own desk. Teachers:
// their usual Teacher's Desk, a preview of the student desk, and which tools
// students get in this course.
// ===================================================================

(function () {
  'use strict';
  const root = document.getElementById('lti');
  const KEY = 'desk:lti-token';
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{20,})/.exec(location.hash || '');
  let token = m ? m[1] : null;
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else token = sessionStorage.getItem(KEY);
  } catch { /* storage blocked in the frame: the in-memory copy is enough */ }
  if (m) history.replaceState(null, '', location.pathname + location.search);

  const h = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(kids)) if (c) n.append(c);
    return n;
  };
  const card = (...kids) => h('section', { class: 'lti-card' }, kids);
  const say = (title, body) => root.replaceChildren(card(h('h1', { text: title }), h('p', { text: body })));

  async function call(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: Object.assign({ 'x-desk-lti': token }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `The server said ${res.status}.`); e.status = res.status; throw e; }
    return data;
  }

  const deskLink = () => '/lti/desk#t=' + encodeURIComponent(token);
  const framed = (() => { try { return window.top !== window; } catch { return true; } })();

  async function start() {
    if (!token) return say('Teacher’s Desk', 'Open this from a link in a Schoology course.');
    let st;
    try { st = await call('GET', '/lti/api/state'); }
    catch (e) { return say('Teacher’s Desk', e.message); }

    if (st.role !== 'teacher') {
      // Not in a frame (Schoology set to open in a new window): go straight in.
      if (!framed) { location.replace(deskLink()); return; }
      return root.replaceChildren(card(
        h('h1', { text: 'Your desk' }),
        h('p', { text: 'Your own desk of tools. It opens in a new window, and it is saved for next time.' }),
        h('div', { class: 'lti-actions' }, h('a', { class: 'btn btn--primary', href: deskLink(), target: '_blank', rel: 'noopener' }, 'Open my desk')),
      ));
    }
    teacher(st);
  }

  function teacher(st) {
    const boxes = st.tools.map((t) => h('li', {}, h('label', {}, [
      h('input', { type: 'checkbox', value: t.type, checked: t.on }),
      h('span', {}, [document.createTextNode(t.name), t.blurb ? h('small', { text: t.blurb }) : null]),
    ])));
    const status = h('span', { class: 'status', role: 'status' });
    const list = h('ul', { class: 'tools' }, boxes);
    const all = (on) => { for (const b of list.querySelectorAll('input')) b.checked = on; };
    const save = h('button', { class: 'btn btn--primary', type: 'button', onclick: async () => {
      save.disabled = true; status.textContent = 'Saving…';
      try {
        const on = [...list.querySelectorAll('input')].filter((b) => b.checked).map((b) => b.value);
        const out = await call('PUT', '/lti/api/course', { on });
        status.textContent = `Saved. Students in this course get ${out.on.length} tool${out.on.length === 1 ? '' : 's'}.`;
      } catch (e) { status.textContent = e.message; }
      save.disabled = false;
    } }, 'Save');

    root.replaceChildren(
      card(
        h('h1', { text: 'Teacher’s Desk' }),
        h('p', { text: 'Your own desk opens in a new window, where you sign in as usual.' }),
        h('div', { class: 'lti-actions' }, [
          h('a', { class: 'btn btn--primary', href: st.deskUrl, target: '_blank', rel: 'noopener' }, 'Open my Teacher’s Desk'),
          h('a', { class: 'btn', href: deskLink(), target: '_blank', rel: 'noopener' }, 'Try the student desk'),
        ]),
      ),
      card(
        h('h2', { text: st.courseTitle ? `Tools students get in ${st.courseTitle}` : 'Tools students get in this course' }),
        h('p', { text: 'Each student who opens this link gets their own blank desk and chooses from these tools. Schoology knows who they are; the desk keeps only an anonymous id.' }),
        h('p', { text: st.schoolSet
          ? 'Only the tools your school allows students in Signify ID (Tools by role) are listed.'
          : 'These are the standard student tools that work without an account.' }),
        list.children.length ? list : h('p', { text: 'Your school has turned every tool off for students.' }),
        h('div', { class: 'row' }, [
          save,
          h('button', { class: 'linkish', type: 'button', onclick: () => all(true) }, 'All'),
          h('button', { class: 'linkish', type: 'button', onclick: () => all(false) }, 'None'),
          status,
        ]),
      ),
    );
  }

  start();
}());
