// ===================================================================
// Widget — Notes
//
// Two shapes of the same thing: a note to write in, or a checklist to tick
// off. The lesson plan on the board and the "don't forget" to yourself are
// different jobs, and one textarea does not do both well.
//
// Text is saved as you type, debounced by the board. Nothing here is ever
// rendered as markup — it is a teacher's own words, and a note that quietly
// interprets angle brackets is a note that loses them.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon } = Desk;

  const COLOURS = [
    { key: 'yellow', label: 'Yellow' },
    { key: 'blue', label: 'Blue' },
    { key: 'green', label: 'Green' },
    { key: 'pink', label: 'Pink' },
    { key: 'plain', label: 'Plain' },
  ];

  Desk.widget({
    type: 'notes',
    name: 'Notes',
    blurb: 'A note to write in, or a checklist to tick off. Big enough to read from the back when you open it.',
    icon: 'notes',
    category: 'board',
    fills: true,
    size: { w: 4, h: 5 },
    min: { w: 2, h: 3 },

    init(s) {
      if (typeof s.text !== 'string') s.text = '';
      if (!Array.isArray(s.items)) s.items = [];
      if (s.mode !== 'list') s.mode = s.mode === 'list' ? 'list' : 'note';
      if (!COLOURS.some((c) => c.key === s.colour)) s.colour = 'yellow';
      if (typeof s.title !== 'string') s.title = '';
    },

    holdsContent(s) {
      if (s.mode === 'list' && s.items.length) return `${s.items.length} item${s.items.length === 1 ? '' : 's'} are on it.`;
      if (s.text.trim()) return 'What you have written goes with it.';
      return '';
    },

    mount(ctx) {
      const s = ctx.state;
      const body = el('div.note-body');

      const titleInput = el('input.note-title', {
        type: 'text', placeholder: 'Untitled', value: s.title, maxlength: 40,
        oninput: () => { s.title = titleInput.value; ctx.save(); },
      });

      const modeToggle = el('div.seg', {}, [
        el('button.seg-btn', { text: 'Note', class: s.mode === 'note' ? 'is-on' : '', onclick: () => setMode('note') }),
        el('button.seg-btn', { text: 'Checklist', class: s.mode === 'list' ? 'is-on' : '', onclick: () => setMode('list') }),
      ]);

      const colourRow = el('div.swatches');
      for (const c of COLOURS) {
        colourRow.append(el('button.swatch', {
          'data-colour': c.key, title: c.label, 'aria-label': c.label,
          class: s.colour === c.key ? 'is-on' : '',
          onclick: () => { s.colour = c.key; ctx.save(); paintColour(); },
        }));
      }

      const printBtn = el('button.icon-btn.no-print', {
        svg: icon('print', 15), title: 'Print this', 'aria-label': 'Print this note',
        onclick: () => Desk.print(shell, {
          title: s.title || (s.mode === 'list' ? 'Checklist' : 'Note'),
          subtitle: s.mode === 'list'
            ? `${s.items.filter((i) => i.done).length} of ${s.items.length} done`
            : '',
        }),
      });

      const shell = el('div.note', {}, [
        el('div.note-head', {}, [titleInput, modeToggle, ctx.expanded ? printBtn : null].filter(Boolean)),
        body,
        ctx.expanded ? colourRow : null,
      ]);
      ctx.root.append(shell);

      function paintColour() {
        shell.dataset.colour = s.colour;
        for (const b of colourRow.children) b.classList.toggle('is-on', b.dataset.colour === s.colour);
      }

      function setMode(mode) {
        if (s.mode === mode) return;
        // Moving between the two should not throw work away: a note becomes
        // its lines, and a checklist becomes its text.
        if (mode === 'list' && !s.items.length && s.text.trim()) {
          s.items = s.text.split('\n').map((t) => t.trim()).filter(Boolean)
            .slice(0, 100).map((text, i) => ({ id: `i${i}${Date.now().toString(36)}`, text, done: false }));
        } else if (mode === 'note' && !s.text.trim() && s.items.length) {
          s.text = s.items.map((i) => (i.done ? `[done] ${i.text}` : i.text)).join('\n');
        }
        s.mode = mode;
        ctx.save();
        for (const b of modeToggle.children) b.classList.toggle('is-on', b.textContent === (mode === 'note' ? 'Note' : 'Checklist'));
        draw();
      }

      function draw() {
        Desk.clear(body);
        if (s.mode === 'note') drawNote(); else drawList();
      }

      function drawNote() {
        // A textarea prints only what fits inside its own scroll box, so a
        // long note would come out with most of it missing. The mirror below
        // is plain text that grows, hidden on screen and shown on paper.
        const mirror = el('div.note-print', { text: s.text });
        const area = el('textarea.note-text', {
          value: s.text, spellcheck: 'true',
          placeholder: 'Today we are…',
          oninput: () => { s.text = area.value; mirror.textContent = s.text; ctx.save(); },
        });
        body.append(area, mirror);
      }

      function drawList() {
        const listEl = el('ul.check-list');
        for (const item of s.items) {
          const box = el('button.check', {
            role: 'checkbox', 'aria-checked': String(!!item.done),
            class: item.done ? 'is-on' : '',
            svg: item.done ? icon('check', 14) : '',
            onclick: () => { item.done = !item.done; ctx.save(); draw(); },
          });
          const text = el('input.check-text', {
            type: 'text', value: item.text, maxlength: 120,
            class: item.done ? 'is-done' : '',
            oninput: (e) => { item.text = e.target.value; ctx.save(); },
            onkeydown: (e) => {
              if (e.key === 'Enter') { e.preventDefault(); addItem(s.items.indexOf(item) + 1); }
              if (e.key === 'Backspace' && !e.target.value && s.items.length > 1) {
                e.preventDefault();
                const at = s.items.indexOf(item);
                s.items.splice(at, 1); ctx.save(); draw();
                listEl.querySelectorAll('.check-text')[Math.max(0, at - 1)]?.focus();
              }
            },
          });
          listEl.append(el('li.check-row', {}, [
            box, text,
            el('button.icon-btn.icon-btn--danger', {
              title: 'Remove this line', 'aria-label': 'Remove this line', svg: icon('close', 14),
              onclick: () => { s.items = s.items.filter((x) => x !== item); ctx.save(); draw(); },
            }),
          ]));
        }
        body.append(listEl);

        const done = s.items.filter((i) => i.done).length;
        body.append(el('div.check-foot', {}, [
          el('button.btn.btn--small', { svg: icon('plus', 14), onclick: () => addItem(s.items.length) }, ' Add a line'),
          s.items.length ? el('span.hint', { text: `${done} of ${s.items.length} done` }) : null,
          done ? el('button.btn.btn--small', { text: 'Clear ticked', onclick: () => { s.items = s.items.filter((i) => !i.done); ctx.save(); draw(); } }) : null,
        ]));
      }

      function addItem(at) {
        if (s.items.length >= 100) return;
        s.items.splice(at, 0, { id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: '', done: false });
        ctx.save(); draw();
        body.querySelectorAll('.check-text')[at]?.focus();
      }

      paintColour();
      draw();
      return {};
    },
  });
}(window.Desk));
