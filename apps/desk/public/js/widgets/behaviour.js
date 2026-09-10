// ===================================================================
// Widget — Behaviour tracker
//
// A running tally per pupil, and a short log behind it. Three deliberate
// choices, because these are records about named children:
//
//   * Only the teacher who wrote a note can read it back. There is no view
//     here of anybody else's, at any role.
//   * Everything expires — the retention window is shown on the widget, not
//     buried in a policy page.
//   * Positive chips come first and there are more of them. The tool should
//     not make it easier to record what went wrong than what went right.
//
// The tally is the thing on screen; the log is one tap behind it, so the
// board never becomes a wall of a child's worst moments.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, when, toast } = Desk;

  const WINDOWS = [
    { key: 'today', label: 'Today' },
    { key: 'week', label: 'This week' },
    { key: 'all', label: 'Everything kept' },
  ];

  function since(windowKey) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (windowKey === 'today') return d.getTime();
    if (windowKey === 'week') { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
    return 0;
  }

  Desk.widget({
    type: 'behaviour',
    name: 'Behaviour tracker',
    blurb: 'A private running tally for your own classes. Nobody else can read it, and it clears itself.',
    icon: 'behaviour',
    category: 'class',
    size: { w: 5, h: 6 },
    min: { w: 3, h: 4 },
    needsRoster: true,
    permission: 'behaviour',

    init(s) {
      if (typeof s.classKey !== 'string') s.classKey = '';
      if (!WINDOWS.some((w) => w.key === s.window)) s.window = 'today';
    },

    mount(ctx) {
      const s = ctx.state;
      let students = [];
      let data = { entries: [], totals: {}, retentionDays: null };
      let reasons = [];
      let openFor = null;

      const grid = el('div.beh-grid');
      const foot = el('div.beh-foot');
      const log = el('div.beh-log');

      const picker = Desk.roster.picker({
        value: s.classKey,
        onPick: (key) => { if (key !== s.classKey) { s.classKey = key; ctx.save(); } load(); },
      });

      const windowSeg = el('div.seg');
      for (const w of WINDOWS) {
        windowSeg.append(el('button.seg-btn', {
          text: w.label, class: s.window === w.key ? 'is-on' : '',
          onclick: () => { s.window = w.key; ctx.save(); load(); },
        }));
      }

      ctx.root.append(el('div.behaviour', {}, [
        picker,
        windowSeg,
        grid,
        foot,
        ctx.expanded ? log : null,
      ]));

      async function load() {
        students = [];
        if (s.classKey) {
          try { students = await Desk.roster.members(s.classKey); }
          catch (e) { toast(e.message, 'warn'); }
        }
        try {
          if (!reasons.length) reasons = (await Desk.api.reasons()).reasons || [];
          data = s.classKey ? await Desk.api.behaviour(s.classKey, since(s.window)) : { entries: [], totals: {} };
        } catch (e) { toast(e.message, 'warn'); }
        for (const b of windowSeg.children) b.classList.toggle('is-on', b.textContent === (WINDOWS.find((w) => w.key === s.window) || {}).label);
        draw();
      }

      function draw() {
        Desk.clear(grid);
        if (!s.classKey) { grid.append(el('p.hint', { text: 'Choose a class list to begin.' })); drawFoot(); return; }
        if (!students.length) { grid.append(el('p.hint', { text: 'Nobody is on this list yet.' })); drawFoot(); return; }

        const ranked = students.slice().sort((a, b) => a.name.localeCompare(b.name));
        for (const st of ranked) {
          const t = data.totals[st.id] || { positive: 0, concern: 0 };
          const cell = el('button.beh-pupil', {
            class: openFor === st.id ? 'is-open' : '',
            onclick: () => { openFor = openFor === st.id ? null : st.id; draw(); },
          }, [
            el('span.beh-name', { text: st.name }),
            el('span.beh-tallies', {}, [
              el('span.tally.tally--pos', { text: String(t.positive) }),
              el('span.tally.tally--neg', { text: String(t.concern) }),
            ]),
          ]);
          grid.append(cell);
          if (openFor === st.id) grid.append(chipsFor(st));
        }
        drawFoot();
        if (ctx.expanded) drawLog();
      }

      function chipsFor(student) {
        const wrap = el('div.beh-chips');
        for (const kind of ['positive', 'concern']) {
          const row = el('div.beh-chip-row');
          for (const r of reasons.filter((x) => x.kind === kind)) {
            row.append(el(`button.chip.chip--${kind}`, {
              text: r.label,
              onclick: () => record(student, kind, r.label),
            }));
          }
          if (row.children.length) wrap.append(row);
        }
        wrap.append(el('button.btn.btn--small', {
          svg: icon('plus', 14),
          onclick: () => noteFor(student),
        }, ' With a note'));

        // What is already against this pupil, and a way to take it back.
        // A tally you can add to but not correct is one a teacher stops
        // trusting the moment they tap the wrong name — which they will,
        // because this gets used one-handed with a class in front of them.
        const mine = (data.entries || []).filter((b) => b.studentKey === student.id);
        if (mine.length) {
          wrap.append(el('div.beh-mine', {}, [
            el('span.section-title', { text: `Recorded for ${student.name.split(' ')[0]}` }),
            ...mine.map((b) => el(`span.beh-pill.beh-pill--${b.kind}`, {}, [
              el('span.beh-pill-text', { text: b.reason || b.note || (b.kind === 'positive' ? 'Went well' : 'Concern') }),
              el('span.beh-pill-when', { text: when(b.at) }),
              el('button.icon-btn.icon-btn--danger', {
                svg: icon('close', 13),
                title: 'Remove this', 'aria-label': `Remove ${b.reason || 'this note'} for ${student.name}`,
                onclick: (e) => { e.stopPropagation(); removeEntry(b); },
              }),
            ])),
          ]));
        }
        return wrap;
      }

      /**
       * Removing what was recorded. A typed note is asked about first — it is
       * something the teacher wrote rather than a chip they tapped, so losing
       * it by a stray tap costs more than re-tapping a chip would.
       */
      async function removeEntry(entry) {
        if (entry.note) {
          const ok = await Desk.ask({
            title: 'Remove this note?',
            body: `“${entry.note}” — recorded for ${entry.studentName}. This cannot be brought back.`,
            confirmLabel: 'Remove', danger: true,
          });
          if (!ok) return;
        }
        try {
          await Desk.api.deleteBehaviour(entry.id);
          await load();
        } catch (e) { toast(e.message, 'warn'); }
      }

      async function noteFor(student) {
        const input = el('textarea.textarea', { rows: 3, maxlength: 300, placeholder: 'What happened?' });
        const seg = el('div.seg', {}, [
          el('button.seg-btn.is-on', { text: 'Went well', onclick: (e) => pickKind(e, 'positive') }),
          el('button.seg-btn', { text: 'Concern', onclick: (e) => pickKind(e, 'concern') }),
        ]);
        let kind = 'positive';
        function pickKind(e, k) {
          e.preventDefault();
          kind = k;
          for (const b of seg.children) b.classList.toggle('is-on', b === e.target);
        }
        const yes = await Desk.ask({
          title: student.name,
          body: el('div', {}, [seg, input, el('p.dialog-note', { text: `Only you can read this. It is deleted after ${data.retentionDays || 90} days.` })]),
          confirmLabel: 'Record',
        });
        if (!yes) return;
        record(student, kind, '', input.value);
      }

      async function record(student, kind, reason, note) {
        try {
          const saved = await Desk.api.addBehaviour({
            classKey: s.classKey,
            studentKey: student.id,
            studentName: student.name,
            kind, reason, note,
          });
          openFor = null;
          await load();

          // The commonest reason to remove a note is that it went on the
          // wrong child a second ago. Offering that here means the fast path
          // stays one tap, without a confirmation in front of every chip.
          toast(`${reason || (kind === 'positive' ? 'Went well' : 'Concern')} — ${student.name}`, 'info', {
            actionLabel: 'Undo',
            onAction: async () => {
              try { await Desk.api.deleteBehaviour(saved.id); await load(); }
              catch (e) { toast(e.message, 'warn'); }
            },
          });
        } catch (e) { toast(e.message, 'warn'); }
      }

      function drawFoot() {
        Desk.clear(foot);
        const totals = Object.values(data.totals || {});
        const pos = totals.reduce((n, t) => n + t.positive, 0);
        const neg = totals.reduce((n, t) => n + t.concern, 0);
        foot.append(
          el('span.beh-summary', {}, [
            el('span.tally.tally--pos', { text: String(pos) }),
            el('span', { text: 'went well' }),
            el('span.tally.tally--neg', { text: String(neg) }),
            el('span', { text: 'concerns' }),
          ]),
        );
        if (ctx.expanded) {
          foot.append(el('button.btn.btn--small', { svg: icon('settings', 14), onclick: editReasons }, ' Chips'));
        }
        foot.append(el('p.hint.beh-privacy', {
          svg: icon('lock', 13),
        }, ` Only you can see these. They are deleted after ${data.retentionDays || 90} days.`));
      }

      function drawLog() {
        Desk.clear(log);
        log.append(el('h3.section-title', { text: 'What you recorded' }));
        if (!data.entries.length) { log.append(el('p.hint', { text: 'Nothing in this window.' })); return; }
        for (const b of data.entries.slice(0, 120)) {
          log.append(el(`div.beh-entry.beh-entry--${b.kind}`, {}, [
            el('span.beh-entry-who', { text: b.studentName }),
            el('span.beh-entry-what', { text: b.reason || b.note || (b.kind === 'positive' ? 'Went well' : 'Concern') }),
            b.reason && b.note ? el('span.beh-entry-note', { text: b.note }) : null,
            el('span.beh-entry-when', { text: when(b.at) }),
            el('button.icon-btn.icon-btn--danger', {
              svg: icon('close', 13),
              title: 'Remove this', 'aria-label': `Remove ${b.reason || 'this note'} for ${b.studentName}`,
              onclick: () => removeEntry(b),
            }),
          ]));
        }
      }

      async function editReasons() {
        const host = el('div.reason-editor');
        function drawRows() {
          Desk.clear(host);
          for (const r of reasons) {
            host.append(el('div.reason-row', {}, [
              el('div.seg.seg--tiny', {}, [
                el('button.seg-btn', { text: 'Well', class: r.kind === 'positive' ? 'is-on' : '', onclick: (e) => { e.preventDefault(); r.kind = 'positive'; drawRows(); } }),
                el('button.seg-btn', { text: 'Concern', class: r.kind === 'concern' ? 'is-on' : '', onclick: (e) => { e.preventDefault(); r.kind = 'concern'; drawRows(); } }),
              ]),
              el('input.input', { type: 'text', value: r.label, maxlength: 40, oninput: (e) => { r.label = e.target.value; } }),
              el('button.icon-btn.icon-btn--danger', { svg: icon('trash', 14), 'aria-label': 'Remove', onclick: (e) => { e.preventDefault(); reasons = reasons.filter((x) => x !== r); drawRows(); } }),
            ]));
          }
          host.append(el('button.btn.btn--small', {
            svg: icon('plus', 14),
            onclick: (e) => { e.preventDefault(); reasons.push({ id: `r${Date.now().toString(36)}`, kind: 'positive', label: '' }); drawRows(); },
          }, ' Add a chip'));
        }
        drawRows();

        const yes = await Desk.ask({ title: 'Your chips', body: host, confirmLabel: 'Save' });
        if (!yes) { reasons = []; await load(); return; }
        try { reasons = (await Desk.api.saveReasons(reasons)).reasons || []; }
        catch (e) { toast(e.message, 'warn'); }
        draw();
      }

      const offRoster = Desk.roster.onChange(() => load());
      load();

      return { destroy() { offRoster(); picker.destroy && picker.destroy(); } };
    },
  });
}(window.Desk));
