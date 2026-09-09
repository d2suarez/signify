// ===================================================================
// Teacher's Desk — class lists, in the browser
//
// Three widgets need the same thing: "which class, and who is in it".
// This holds one cache for all of them, so picking 4B in the randomiser does
// not make the group maker fetch it again — and a list edited in one place
// shows up in the others without a reload.
// ===================================================================

window.Desk = window.Desk || {};

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  let classesPromise = null;
  const memberCache = new Map();      // key -> promise
  const listeners = new Set();

  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const announce = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

  // Whether the last lookup against Signify ID actually worked. An empty list
  // because the request was refused must never be shown as "you have no
  // classes" — that reads as the school's data having gone missing.
  let lastOk = true;

  function classes({ refresh = false } = {}) {
    if (refresh || !classesPromise) {
      classesPromise = Desk.api.classes()
        .then((r) => { lastOk = r.signifyOk !== false; return r.classes || []; })
        .catch((e) => { classesPromise = null; lastOk = false; throw e; });
    }
    return classesPromise;
  }

  const lookupWorked = () => lastOk;

  function members(key, { refresh = false } = {}) {
    if (refresh) memberCache.delete(key);
    if (!memberCache.has(key)) {
      memberCache.set(key, Desk.api.members(key)
        .then((r) => r.students || [])
        .catch((e) => { memberCache.delete(key); throw e; }));
    }
    return memberCache.get(key);
  }

  function invalidate(key) {
    classesPromise = null;
    if (key) memberCache.delete(key); else memberCache.clear();
    announce();
  }

  // ---------- the picker every roster widget uses ----------

  /**
   * A <select> of the teacher's class lists, plus a way to make one.
   * Calls back with the chosen key (or '' when there is nothing to choose).
   */
  function picker({ value, onPick, allowManage = true }) {
    const select = el('select.select', { onchange: () => onPick(select.value) });
    const retry = el('span.picker-retry');
    const wrap = el('div.picker', {}, [select, retry]);

    if (allowManage) {
      wrap.append(el('button.icon-btn', {
        title: 'Class lists', 'aria-label': 'Manage class lists',
        svg: icon('list', 18),
        onclick: () => manage().then(() => refill(select.value)),
      }));
    }

    async function refill(want) {
      const list = await classes().catch(() => []);
      Desk.clear(select);
      if (!list.length) {
        // Two very different empties, and saying the wrong one sends a
        // teacher looking for classes that never went anywhere.
        const failed = !lookupWorked();
        select.append(el('option', { value: '', text: failed ? 'Could not load your classes' : 'No class lists yet' }));
        select.value = '';
        wrap.classList.toggle('is-broken', failed);
        Desk.clear(retry).append(failed
          ? el('button.btn.btn--small', {
            svg: icon('reset', 13),
            title: 'Try loading your classes again',
            onclick: () => { invalidate(); refill(want); },
          }, ' Retry')
          : document.createTextNode(''));
        onPick('');
        return;
      }
      wrap.classList.remove('is-broken');
      Desk.clear(retry);
      const fromSignify = list.filter((c) => c.source === 'signify');
      const typed = list.filter((c) => c.source === 'list');
      const add = (group, items) => {
        if (!items.length) return;
        const g = el('optgroup', { label: group });
        for (const c of items) g.append(el('option', { value: c.key, text: c.subject ? `${c.name} — ${c.subject}` : c.name }));
        select.append(g);
      };
      add('My classes', fromSignify);
      add('My own lists', typed);

      const chosen = list.some((c) => c.key === want) ? want : list[0].key;
      select.value = chosen;
      onPick(chosen);
    }

    refill(value);
    const off = onChange(() => refill(select.value));
    wrap.destroy = off;
    return wrap;
  }

  // ---------- making and editing a typed list ----------

  function manage() {
    return new Promise((resolve) => {
      const body = el('div.lists');
      const scrim = el('div.scrim', { onclick: (e) => { if (e.target === scrim) close(); } });
      const dialog = el('div.dialog.dialog--wide', { role: 'dialog', 'aria-modal': 'true' }, [
        el('h2.dialog-title', { text: 'Class lists' }),
        el('p.dialog-note', { text: 'Classes from Signify ID are kept up to date for you. Lists you type here belong to you alone — for a club, a set, or a class that has not been imported yet.' }),
        body,
        el('div.dialog-actions', {}, [el('button.btn.btn--primary', { text: 'Done', onclick: () => close() })]),
      ]);
      scrim.append(dialog);
      document.body.append(scrim);

      const onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);
      function close() { scrim.remove(); document.removeEventListener('keydown', onKey); resolve(); }

      draw();

      async function draw() {
        Desk.clear(body).append(el('p.hint', { text: 'Loading…' }));
        const list = await classes({ refresh: true }).catch(() => []);
        Desk.clear(body);

        for (const c of list) {
          const row = el('div.list-row', {}, [
            el('span.list-row-name', { text: c.name }),
            el('span.tag', { text: c.source === 'signify' ? 'From Signify ID' : `${c.size || 0} pupils` }),
          ]);
          if (c.editable) {
            row.append(el('button.btn.btn--small', { text: 'Edit', onclick: () => edit(c) }));
            row.append(el('button.icon-btn.icon-btn--danger', {
              title: `Delete ${c.name}`, svg: icon('trash', 16),
              onclick: async () => {
                if (!await Desk.ask({ title: `Delete “${c.name}”?`, body: 'The pupils on it are removed from this desk. Behaviour notes you have already written stay until they expire.', confirmLabel: 'Delete', danger: true })) return;
                await Desk.api.deleteList(c.key.slice(5));
                invalidate(c.key);
                draw();
              },
            }));
          } else {
            row.append(el('span.hint', { text: 'Managed centrally' }));
          }
          body.append(row);
        }

        body.append(el('button.btn.btn--primary.btn--block', { svg: icon('plus', 16), onclick: () => edit(null) }, ' Make a list'));
      }

      async function edit(existing) {
        const students = existing ? await members(existing.key, { refresh: true }).catch(() => []) : [];
        const nameInput = el('input.input', { type: 'text', placeholder: 'e.g. 4B Maths', value: existing ? existing.name : '', maxlength: 60 });
        const namesArea = el('textarea.textarea', {
          rows: 12, spellcheck: 'false',
          placeholder: 'One name per line\n\nAva Bennett\nNoah Clarke\nMia Duarte',
          value: students.map((s) => s.name).join('\n'),
        });

        Desk.clear(body).append(
          el('label.field', {}, [el('span.field-label', { text: 'What is this list called?' }), nameInput]),
          el('label.field', {}, [el('span.field-label', { text: 'Who is on it?' }), namesArea]),
          el('div.dialog-actions', {}, [
            el('button.btn', { text: 'Back', onclick: () => draw() }),
            el('button.btn.btn--primary', { text: 'Save', onclick: save }),
          ]),
        );
        nameInput.focus();

        async function save() {
          const names = namesArea.value.split('\n').map((s) => s.trim()).filter(Boolean);
          if (!names.length) { toast('Add at least one name.', 'warn'); return; }
          // Match typed names back to the pupils already on the list so their
          // ids survive an edit — a saved group or a behaviour note is
          // attached to the id, not the spelling.
          const byName = new Map(students.map((s) => [s.name.toLowerCase(), s]));
          const payload = names.map((n) => {
            const prev = byName.get(n.toLowerCase());
            return prev ? { id: prev.id, name: n } : { name: n };
          });
          try {
            if (existing) await Desk.api.updateList(existing.key.slice(5), { name: nameInput.value, students: payload });
            else await Desk.api.createList(nameInput.value, payload);
            invalidate(existing ? existing.key : null);
            draw();
          } catch (e) { toast(e.message, 'warn'); }
        }
      }
    });
  }

  Desk.roster = { classes, members, invalidate, onChange, picker, manage, lookupWorked };
}(window.Desk));
