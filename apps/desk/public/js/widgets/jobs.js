// ===================================================================
// Widget — Classroom jobs
//
// Who is doing what this week: the register, the door, tidying the library
// corner. Draws from a class list, and rotates so the same three children do
// not end up with every job for a term.
//
// Rotation is by POSITION, not by re-shuffling: everybody moves along one
// job each time. That is what makes it fair in a way a class can see and
// argue with — "I had the door last week, so this week I have the plants" —
// which a fresh random draw never is.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast, shuffle, when } = Desk;

  const DEFAULT_JOBS = ['Register', 'Door', 'Line leader', 'Library', 'Plants', 'Tidy up'];

  Desk.widget({
    type: 'jobs',
    name: 'Classroom jobs',
    blurb: 'Who has which job, rotating fairly so the same few do not get everything.',
    icon: 'list',
    size: { w: 4, h: 5 },
    min: { w: 3, h: 4 },
    needsRoster: true,

    init(s) {
      if (typeof s.classKey !== 'string') s.classKey = '';
      if (!Array.isArray(s.jobs) || !s.jobs.length) {
        s.jobs = DEFAULT_JOBS.map((name, i) => ({ id: `j${i}`, name }));
      }
      // The order pupils sit in the rota, and how far along it has moved.
      if (!Array.isArray(s.order)) s.order = [];
      if (typeof s.offset !== 'number') s.offset = 0;
      if (typeof s.rotatedAt !== 'number') s.rotatedAt = 0;
    },

    holdsContent: (s) => (s.order.length ? 'The rota goes with it.' : ''),

    mount(ctx) {
      const s = ctx.state;
      let students = [];

      const board = el('div.jobs-list');
      const foot = el('div.jobs-foot');
      const settings = el('div.jobs-settings');

      const picker = Desk.roster.picker({
        value: s.classKey,
        onPick: (key) => {
          if (key !== s.classKey) { s.classKey = key; s.order = []; s.offset = 0; ctx.save(); }
          load();
        },
      });

      ctx.root.append(el('div.jobs', {}, [picker, board, foot, settings]));

      async function load() {
        students = [];
        if (s.classKey) {
          try { students = await Desk.roster.members(s.classKey); }
          catch (e) { toast(e.message, 'warn'); }
        }
        // Anyone who has left drops out; anyone new joins the end, so the
        // rota survives a change of class list without being rebuilt.
        const here = new Set(students.map((x) => x.id));
        s.order = s.order.filter((id) => here.has(id));
        for (const st of students) if (!s.order.includes(st.id)) s.order.push(st.id);
        draw();
      }

      const nameOf = (id) => (students.find((x) => x.id === id) || {}).name || '—';

      /** Who holds job `i` right now. */
      const holder = (i) => (s.order.length ? s.order[(i + s.offset) % s.order.length] : null);

      function draw() {
        drawBoard();
        drawFoot();
        if (ctx.expanded) drawSettings(); else Desk.clear(settings);
      }

      /** The rota itself. Safe to call while a job name is being typed. */
      function drawBoard() {
        Desk.clear(board);

        if (!s.classKey) { board.append(el('p.hint', { text: 'Choose a class list to begin.' })); return; }
        if (!s.order.length) { board.append(el('p.hint', { text: 'Nobody on this list yet.' })); return; }

        s.jobs.forEach((job, i) => {
          const who = holder(i);
          const row = el('div.job-row', {}, [
            el('span.job-name', { text: job.name }),
            el('span.job-who', { text: nameOf(who) }),
          ]);
          if (ctx.expanded) {
            row.append(el('button.icon-btn.icon-btn--danger', {
              svg: icon('trash', 14), 'aria-label': `Remove ${job.name}`,
              onclick: () => { s.jobs = s.jobs.filter((j) => j !== job); ctx.save(); draw(); },
            }));
          }
          board.append(row);
        });

        const spare = s.order.length - s.jobs.length;
        if (spare > 0) {
          board.append(el('p.hint', { text: `${spare} not on a job this time — they come round next.` }));
        }
      }

      function drawFoot() {
        Desk.clear(foot);
        if (!s.order.length) return;
        Desk.append(foot,
          el('button.btn.btn--primary.btn--small', { svg: icon('reset', 14), onclick: rotate }, ' Move everyone along'),
          s.rotatedAt ? el('span.hint', { text: `Last moved ${when(s.rotatedAt)}` }) : null,
        );
      }

      function drawSettings() {
        Desk.clear(settings);
        settings.append(el('h3.section-title', { text: 'The jobs' }));

        const rows = el('div.jobs-edit');
        for (const job of s.jobs) {
          rows.append(el('input.input', {
            type: 'text', value: job.name, maxlength: 30,
            // The rota above updates; the list of fields this one lives in
            // must not be rebuilt, or the caret leaves after one letter.
            oninput: (e) => { job.name = e.target.value; ctx.save(); drawBoard(); },
          }));
        }
        settings.append(rows);

        settings.append(el('div.starter-row', {}, [
          el('button.btn.btn--small', {
            svg: icon('plus', 14),
            onclick: () => {
              if (s.jobs.length >= 20) { toast('That is plenty of jobs.', 'warn'); return; }
              s.jobs.push({ id: `j${Date.now().toString(36)}`, name: 'New job' });
              ctx.save(); draw();
            },
          }, ' Add a job'),
          el('button.btn.btn--small', { svg: icon('shuffle', 14), onclick: reshuffle }, ' Shuffle the order'),
        ]));

        settings.append(el('p.hint', {
          text: 'Everybody moves along one job each time, so the rota is the same for everyone. Shuffling starts a fresh order from scratch.',
        }));
      }

      function rotate() {
        if (!s.order.length) return;
        s.offset = (s.offset + 1) % s.order.length;
        s.rotatedAt = Date.now();
        ctx.save();
        draw();
        Desk.sound.play('chime');
      }

      async function reshuffle() {
        if (!await Desk.ask({
          title: 'Start a new order?',
          body: 'Everybody is put in a fresh random order. Who has had which job so far is forgotten.',
          confirmLabel: 'Shuffle', danger: true,
        })) return;
        s.order = shuffle(s.order);
        s.offset = 0;
        s.rotatedAt = Date.now();
        ctx.save(); draw();
      }

      const offRoster = Desk.roster.onChange(() => load());
      load();

      return { destroy() { offRoster(); picker.destroy && picker.destroy(); } };
    },
  });
}(window.Desk));
