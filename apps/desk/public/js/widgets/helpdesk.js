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
// Nothing about a request is kept on the board. The card holds only the place
// the teacher last picked, so they are not asked for it every time.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  // The help desk sends its own categories (an admin can add and reshape
  // them); these are only for a help desk too old to send any.
  const KINDS = [
    { key: 'TECHNOLOGY', name: 'Technology', shape: 'square', color: 'p2', askLocation: 'OPTIONAL', askDevice: 'HIDDEN', fields: [] },
    { key: 'MAINTENANCE', name: 'Building', shape: 'circle', color: 'p1', askLocation: 'OPTIONAL', askDevice: 'HIDDEN', fields: [] },
    { key: 'OTHER', name: 'Something else', shape: 'arch', color: 'p4', askLocation: 'OPTIONAL', askDevice: 'HIDDEN', fields: [] },
  ];
  const ELSEWHERE = '__elsewhere';

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
    students: true,
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
      let kind = '';

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
        const kinds = Array.isArray(me.categories) && me.categories.length ? me.categories : KINDS;
        const places = Array.isArray(me.locations) ? me.locations : [];
        if (!kinds.some((k) => k.key === kind)) kind = kinds[0].key;
        const current = () => kinds.find((k) => k.key === kind) || kinds[0];

        const kindBox = el('div.hd-kinds', { role: 'radiogroup', 'aria-label': 'What kind of help' });
        function drawKinds() {
          Desk.clear(kindBox);
          for (const k of kinds) {
            kindBox.append(el('button.hd-kind', {
              type: 'button', role: 'radio', 'aria-checked': String(kind === k.key),
              class: kind === k.key ? 'is-on' : '',
              onclick: () => { kind = k.key; drawKinds(); drawAsks(); },
            }, [el(`span.hd-shape.hd-shape--${k.shape}`, { style: { color: `var(--${k.color || 'p4'})` } }), k.name]));
          }
        }

        const title = el('input.input', { type: 'text', maxlength: '200', placeholder: 'What do you need help with?', 'aria-label': 'What do you need help with?' });
        const details = el('textarea.textarea', { rows: ctx.expanded ? '5' : '2', maxlength: '10000', placeholder: 'Details (optional)', 'aria-label': 'Details' });
        const urgent = el('input', { type: 'checkbox' });
        const send = el('button.btn.btn--primary', { type: 'submit' }, 'Send request');

        // Where: the help desk's list of places when it has one, else a box.
        const known = places.includes(s.room);
        const placePick = el('select.select', { 'aria-label': 'Where' }, [
          el('option', { value: '' }, 'Where?'),
          ...places.map((p) => el('option', { value: p, selected: p === s.room }, p)),
          el('option', { value: ELSEWHERE, selected: !!s.room && !known }, 'Somewhere else…'),
        ]);
        const room = el('input.input', { type: 'text', maxlength: '120', placeholder: places.length ? 'Where is it?' : 'Room', value: known ? '' : s.room, 'aria-label': 'Room' });
        placePick.addEventListener('change', () => { room.hidden = placePick.value !== ELSEWHERE; if (!room.hidden) room.focus(); });
        const device = el('input.input', { type: 'text', maxlength: '200', placeholder: 'Which device?', 'aria-label': 'Which device' });
        const where = () => (places.length && placePick.value !== ELSEWHERE ? placePick.value : room.value.trim());

        const placeRow = el('div.hd-row');
        const extras = el('div.hd-extras');
        let answers = {};
        function drawAsks() {
          const k = current();
          title.placeholder = k.titlePrompt || 'What do you need help with?';
          Desk.clear(placeRow);
          if (k.askLocation !== 'HIDDEN') {
            if (places.length) { placeRow.append(placePick); room.hidden = placePick.value !== ELSEWHERE; }
            placeRow.append(room);
          }
          placeRow.append(el('label.hd-urgent', {}, [urgent, ' Urgent']));
          device.hidden = k.askDevice === 'HIDDEN';
          device.placeholder = k.askDevice === 'REQUIRED' ? 'Which device?' : 'Which device? (optional)';
          // The category's own questions, named as the help desk expects.
          Desk.clear(extras);
          answers = {};
          for (const f of k.fields || []) {
            const name = `f_${f.id}`;
            const label = f.label + (f.required || f.type === 'CHECKBOX' ? '' : ' (optional)');
            let input;
            if (f.type === 'CHECKBOX') {
              input = el('input', { type: 'checkbox' });
              extras.append(el('label.hd-urgent', {}, [input, ' ' + f.label]));
              answers[name] = () => (input.checked ? 'on' : '');
              continue;
            }
            if (f.type === 'SELECT') {
              input = el('select.select', { 'aria-label': f.label }, [
                el('option', { value: '' }, label),
                ...f.options.map((o) => el('option', { value: o }, o)),
              ]);
            } else if (f.type === 'TEXTAREA') {
              input = el('textarea.textarea', { rows: '2', maxlength: '5000', placeholder: label, 'aria-label': f.label });
            } else if (f.type === 'DATE') {
              input = el('input.input', { type: 'date', 'aria-label': f.label, title: f.label });
              extras.append(el('p.hd-label', { text: label }));
            } else {
              input = el('input.input', { type: 'text', maxlength: '500', placeholder: label, 'aria-label': f.label });
            }
            extras.append(input);
            answers[name] = () => input.value.trim();
          }
        }
        drawKinds();
        drawAsks();

        const form = el('form.hd-form', {
          onsubmit: async (e) => {
            e.preventDefault();
            const k = current();
            if (!title.value.trim()) { toast('Say in a few words what you need.', 'warn'); title.focus(); return; }
            if (k.askLocation === 'REQUIRED' && !where()) { toast('Say where this is.', 'warn'); return; }
            if (k.askDevice === 'REQUIRED' && !device.value.trim()) { toast('Say which device this is about.', 'warn'); device.focus(); return; }
            const sent = {};
            for (const [name, read] of Object.entries(answers)) sent[name] = read();
            send.disabled = true;
            try {
              const place = k.askLocation === 'HIDDEN' ? '' : where();
              if (place && place !== s.room) { s.room = place.slice(0, 120); ctx.save(); }
              const made = await call('POST', '/api/desk/tickets', {
                category: kind,
                title: title.value.trim(),
                description: details.value.trim(),
                location: place,
                device: k.askDevice === 'HIDDEN' ? '' : device.value.trim(),
                answers: sent,
                priority: urgent.checked ? 'URGENT' : 'NORMAL',
              });
              toast(`Sent. Your request is #${made.id}.`, 'info');
              title.value = '';
              details.value = '';
              device.value = '';
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
          kindBox,
          title,
          details,
          device,
          extras,
          placeRow,
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
