// ===================================================================
// Widget — Help desk
//
// "The projector's flickering again" without leaving the lesson: a short
// form that files a request with the Signify Help Desk (help.signify.one),
// and the last few requests you sent with where each one stands.
//
// The desk server is not involved. The browser talks to the help desk
// directly — a sibling on the same site, so it carries the help desk's own
// sign-in cookie, and the help desk decides who is asking. The first time,
// that cookie does not exist yet: "Connect" opens the help desk in a small
// window, Signify ID signs the teacher in there (usually without a click),
// and the window closes itself.
//
// Nothing about a request is kept on the board. The card holds only the room
// the teacher last typed, so they are not asked for it every time.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  const KINDS = [
    { key: 'TECHNOLOGY', label: 'Technology', shape: 'square', role: 'p2' },
    { key: 'MAINTENANCE', label: 'Building', shape: 'circle', role: 'p1' },
    { key: 'OTHER', label: 'Something else', shape: 'arch', role: 'p4' },
  ];

  const base = () => ((Desk.config && Desk.config.helpDeskUrl) || 'https://help.signify.one').replace(/\/+$/, '');

  async function call(method, path, body) {
    const res = await fetch(base() + path, {
      method,
      credentials: 'include',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { const e = new Error('signed-out'); e.signedOut = true; throw e; }
    if (!res.ok) throw new Error(data.error || 'The help desk did not answer.');
    return data;
  }

  Desk.widget({
    type: 'helpdesk',
    name: 'Help desk',
    blurb: 'Ask for help with technology or the building, and see where your requests stand.',
    icon: 'lifebuoy',
    category: 'other',
    role: 'p2',
    size: { w: 4, h: 7 },
    min: { w: 3, h: 5 },

    init(s) {
      if (typeof s.room !== 'string') s.room = '';
      s.room = s.room.slice(0, 120);
    },

    mount(ctx) {
      const s = ctx.state;
      const root = el('div.hd');
      ctx.root.append(root);
      let alive = true;
      let kind = 'TECHNOLOGY';

      function onMessage(e) {
        if (e.origin !== base()) return;
        if (e.data && e.data.type === 'signify-helpdesk-connected') load();
      }
      window.addEventListener('message', onMessage);

      function connect() {
        const w = window.open(`${base()}/desk-connect`, 'signify-helpdesk', 'width=480,height=600');
        // If the window was blocked, fall back to a tab; the teacher comes back
        // and presses "I've connected".
        if (!w) window.open(`${base()}/desk-connect`, '_blank', 'noopener');
      }

      function drawSignedOut() {
        Desk.clear(root);
        root.append(
          el('div.hd-connect', {}, [
            el('span.hd-mark', { svg: icon('lifebuoy', 28) }),
            el('p.hd-lead', { text: 'Connect the help desk to send requests from here.' }),
            el('button.btn.btn--primary', { onclick: connect }, 'Connect'),
            el('button.btn.btn--ghost.btn--small', { onclick: load }, 'I’ve connected'),
          ]),
        );
      }

      function drawError(message) {
        Desk.clear(root);
        root.append(el('div.hd-connect', {}, [
          el('p.hint', { text: message }),
          el('button.btn.btn--small', { onclick: load }, 'Try again'),
          el('a.hint', { href: base(), target: '_blank', rel: 'noopener' }, 'Open the help desk'),
        ]));
      }

      function drawForm(me) {
        Desk.clear(root);

        const kinds = el('div.hd-kinds', { role: 'radiogroup', 'aria-label': 'What kind of help' });
        function drawKinds() {
          Desk.clear(kinds);
          for (const k of KINDS) {
            kinds.append(el('button.hd-kind', {
              type: 'button', role: 'radio', 'aria-checked': String(kind === k.key),
              class: kind === k.key ? 'is-on' : '',
              onclick: () => { kind = k.key; drawKinds(); },
            }, [el(`span.hd-shape.hd-shape--${k.shape}`, { style: { color: `var(--${k.role})` } }), k.label]));
          }
        }
        drawKinds();

        const title = el('input.input', { type: 'text', maxlength: '200', placeholder: 'What do you need help with?', 'aria-label': 'What do you need help with?' });
        const details = el('textarea.textarea', { rows: ctx.expanded ? '5' : '2', maxlength: '10000', placeholder: 'Details (optional)', 'aria-label': 'Details' });
        const room = el('input.input', { type: 'text', maxlength: '120', placeholder: 'Room', value: s.room, 'aria-label': 'Room' });
        const urgent = el('input', { type: 'checkbox' });
        const send = el('button.btn.btn--primary', { type: 'submit' }, 'Send request');

        const form = el('form.hd-form', {
          onsubmit: async (e) => {
            e.preventDefault();
            if (!title.value.trim()) { toast('Say in a few words what you need.', 'warn'); title.focus(); return; }
            send.disabled = true;
            try {
              if (room.value.trim() !== s.room) { s.room = room.value.trim().slice(0, 120); ctx.save(); }
              const made = await call('POST', '/api/desk/tickets', {
                category: kind,
                title: title.value.trim(),
                description: details.value.trim(),
                location: room.value.trim(),
                priority: urgent.checked ? 'URGENT' : 'NORMAL',
              });
              toast(`Sent. Your request is #${made.id}.`, 'info');
              title.value = '';
              details.value = '';
              urgent.checked = false;
              load();
            } catch (err) {
              if (err.signedOut) drawSignedOut();
              else toast(err.message, 'warn');
            } finally {
              send.disabled = false;
            }
          },
        }, [
          kinds,
          title,
          details,
          el('div.hd-row', {}, [
            room,
            el('label.hd-urgent', {}, [urgent, ' Urgent']),
          ]),
          send,
        ]);

        const list = el('ul.hd-list');
        for (const t of me.tickets || []) {
          list.append(el('li', {}, [
            el('a.hd-ticket', { href: t.url, target: '_blank', rel: 'noopener' }, [
              el('span.hd-ticket-title', { text: `#${t.id} ${t.title}` }),
              el(`span.hd-status.hd-status--${String(t.status).toLowerCase()}`, { text: t.statusLabel }),
            ]),
          ]));
        }

        root.append(form);
        if (me.tickets && me.tickets.length) {
          root.append(el('div.hd-recent', {}, [el('p.hd-label', { text: 'Your requests' }), list]));
        }
        root.append(
          el('a.hint.hd-open', { href: me.helpDeskUrl || base(), target: '_blank', rel: 'noopener', svg: icon('external', 12) }, ' Open the help desk'),
        );
      }

      async function load() {
        Desk.clear(root);
        root.append(el('p.hint', { text: 'Asking the help desk…' }));
        try {
          const me = await call('GET', '/api/desk/me');
          if (alive) drawForm(me);
        } catch (err) {
          if (!alive) return;
          if (err.signedOut) drawSignedOut();
          else drawError('The help desk could not be reached.');
        }
      }

      load();
      return {
        destroy() {
          alive = false;
          window.removeEventListener('message', onMessage);
        },
      };
    },
  });
}(window.Desk));
