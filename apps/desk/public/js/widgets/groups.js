// ===================================================================
// Widget — Student groups
//
// Splits a class into groups, either "four groups" or "groups of four".
// Two things make this more than a shuffle:
//
//   * Keep-apart pairs. Every teacher has two or three of these, and a
//     grouping tool that ignores them is one they stop using by Wednesday.
//     Solved by trying repeatedly and keeping the best attempt, which is
//     plenty for thirty children and never hangs.
//   * Saving an arrangement. The groups that worked last week are the ones
//     wanted again this week.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, shuffle, toast, when } = Desk;

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /** Deals the class out into `count` groups, balancing the sizes. */
  function deal(people, count) {
    const groups = Array.from({ length: count }, () => []);
    shuffle(people).forEach((p, i) => groups[i % count].push(p));
    return groups;
  }

  const violations = (groups, apart) => groups.reduce((total, g) => {
    const ids = new Set(g.map((p) => p.id));
    return total + apart.filter(([a, b]) => ids.has(a) && ids.has(b)).length;
  }, 0);

  /** Best of many attempts. Stops as soon as an arrangement breaks no rules. */
  function arrange(people, count, apart) {
    let best = null;
    let bestScore = Infinity;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const groups = deal(people, count);
      const score = violations(groups, apart);
      if (score < bestScore) { best = groups; bestScore = score; }
      if (!score) break;
    }
    return { groups: best || [], unmet: bestScore };
  }

  Desk.widget({
    type: 'groups',
    name: 'Student groups',
    blurb: 'Split the class into groups or pairs, keeping apart the ones who need to be.',
    icon: 'groups',
    category: 'class',
    tone: 'block',
    guest: true,
    size: { w: 4, h: 5 },
    min: { w: 3, h: 4 },
    needsRoster: true,

    init(s) {
      if (typeof s.classKey !== 'string') s.classKey = '';
      if (s.mode !== 'size') s.mode = 'count';
      if (typeof s.n !== 'number') s.n = 4;
      if (!Array.isArray(s.groups)) s.groups = [];
      if (!Array.isArray(s.away)) s.away = [];
      if (!Array.isArray(s.apart)) s.apart = [];
    },

    holdsContent: (s) => (s.groups.length ? `The ${s.groups.length} groups on it go too.` : ''),

    mount(ctx) {
      const s = ctx.state;
      let students = [];
      // Remembered when the class loads, so printing — one gesture — never
      // has to wait on a lookup.
      let className = '';

      const controls = el('div.group-controls');
      const output = el('div.group-output');
      const extra = el('div.group-extra');

      const picker = Desk.roster.picker({
        value: s.classKey,
        onPick: (key) => {
          // The picker reports its choice on mount too, so this must not treat
          // "the class it already had" as a change — that threw away the
          // groups every time the widget was opened larger.
          const changed = key !== s.classKey;
          if (changed) { s.classKey = key; s.groups = []; ctx.save(); }
          load();
        },
      });

      ctx.root.append(el('div.groups', {}, [picker, controls, output, extra]));

      // Held in locals across the awaits, and discarded if a newer load has
      // started. A widget opened into the big view is mounted twice, and the
      // two loads used to trample a shared `students` — see the long note in
      // seating.js for the afternoon that cost.
      let loadSeq = 0;
      async function load() {
        const mine = ++loadSeq;
        let got = [];
        let name = '';
        let rosterKnown = false;

        if (s.classKey) {
          try {
            got = await Desk.roster.members(s.classKey);
            rosterKnown = true;
          } catch (e) { toast(e.message, 'warn'); }
          try {
            const found = (await Desk.roster.classes()).find((c) => c.key === s.classKey);
            name = (found && found.name) || '';
          } catch { /* it prints without a name in the heading */ }
        }

        if (mine !== loadSeq) return;
        students = got;
        className = name;

        // Only tidy these against a roster we were actually given. A refused
        // lookup returns nobody, and pruning against nobody throws away every
        // "away today" mark and every keep-apart pair the teacher has built
        // up — work that is invisible until the next time groups are made and
        // two children who must not sit together do.
        if (rosterKnown) {
          const ids = new Set(students.map((x) => x.id));
          s.away = s.away.filter((id) => ids.has(id));
          s.apart = s.apart.filter(([a, b]) => ids.has(a) && ids.has(b));
        }
        draw();
      }

      const present = () => students.filter((x) => !s.away.includes(x.id));

      // Set by make(), read once by draw(): new groups are dealt out like
      // cards, but groups that are simply being redrawn just appear.
      let dealt = false;

      function make() {
        const people = present();
        if (people.length < 2) { toast('There need to be at least two pupils.', 'warn'); return; }
        const count = s.mode === 'count'
          ? Math.min(Math.max(2, s.n), people.length)
          : Math.max(1, Math.ceil(people.length / Math.max(2, s.n)));

        const { groups, unmet } = arrange(people, count, s.apart);
        s.groups = groups.map((members, i) => ({
          label: `Group ${LETTERS[i] || i + 1}`,
          members: members.map((p) => ({ key: p.id, name: p.name })),
        }));
        ctx.save();
        dealt = true;
        draw();
        if (unmet) toast(`${unmet} keep-apart pair${unmet === 1 ? '' : 's'} could not be honoured with these group sizes.`, 'warn');
      }

      function draw() {
        drawControls();
        drawOutput();
        Desk.clear(extra);
        if (ctx.expanded) { drawAway(); drawApart(); drawSaved(); }
      }

      function drawControls() {
        Desk.clear(controls);
        const modeSeg = el('div.seg', {}, [
          el('button.seg-btn', { text: 'Groups of', class: s.mode === 'size' ? 'is-on' : '', onclick: () => { s.mode = 'size'; ctx.save(); draw(); } }),
          el('button.seg-btn', { text: 'Number of groups', class: s.mode === 'count' ? 'is-on' : '', onclick: () => { s.mode = 'count'; ctx.save(); draw(); } }),
        ]);

        const stepper = el('div.stepper', {}, [
          el('button.icon-btn', { svg: icon('minus', 15), 'aria-label': 'Fewer', onclick: () => { s.n = Math.max(2, s.n - 1); ctx.save(); draw(); } }),
          el('span.stepper-value', { text: String(s.n) }),
          el('button.icon-btn', { svg: icon('plus', 15), 'aria-label': 'More', onclick: () => { s.n = Math.min(20, s.n + 1); ctx.save(); draw(); } }),
        ]);

        controls.append(
          modeSeg,
          el('div.group-row', {}, [
            stepper,
            el('button.btn.btn--primary', { svg: icon('shuffle', 16), onclick: make }, ' Make groups'),
          ]),
          el('p.hint', { text: `${present().length} here${s.away.length ? `, ${s.away.length} away` : ''}` }),
        );
      }

      function drawOutput() {
        Desk.clear(output);
        if (!s.groups.length) {
          output.append(el('p.hint', { text: students.length ? 'No groups made yet.' : 'Choose a class list to begin.' }));
          return;
        }
        const grid = el('div.group-grid');
        s.groups.forEach((g, i) => {
          const title = ctx.expanded
            ? el('input.group-title', {
              type: 'text', value: g.label, maxlength: 30,
              oninput: (e) => { g.label = e.target.value; ctx.save(); },
            })
            : el('h4.group-title-text', { text: g.label });
          const names = el('ul.group-names');
          for (const m of g.members) names.append(el('li', { text: m.name }));
          grid.append(el('div.group-card', {
            class: dealt ? 'is-dealt' : '',
            style: { '--deal': grid.children.length },
          }, [title, names, el('span.group-size', { text: `${g.members.length}` })]));
        });
        output.append(grid);
        dealt = false;

        if (ctx.expanded) {
          output.append(el('div.group-row.no-print', {}, [
            el('button.btn.btn--small', { svg: icon('shuffle', 14), onclick: make }, ' Again'),
            el('button.btn.btn--small', { svg: icon('print', 14), onclick: printGroups }, ' Print'),
            el('button.btn.btn--small', { svg: icon('save', 14), onclick: saveGrouping }, ' Keep these groups'),
          ]));
        }
      }

      /** The groups on paper, to hand out or stick on the wall. */
      function printGroups() {
        if (!s.groups.length) { toast('There are no groups to print yet.', 'warn'); return; }
        const heads = s.groups.length;
        const seated = s.groups.reduce((n, g) => n + g.members.length, 0);
        Desk.print(output, {
          title: className || 'Groups',
          subtitle: `${heads} group${heads === 1 ? '' : 's'}, ${seated} pupil${seated === 1 ? '' : 's'}`,
        });
      }

      function drawAway() {
        const grid = el('div.pick-roll');
        for (const st of students) {
          const away = s.away.includes(st.id);
          grid.append(el('button.pick-chip', {
            text: st.name, class: away ? 'is-away' : '',
            title: away ? 'Away — tap to include' : 'Tap to mark away',
            onclick: () => { s.away = away ? s.away.filter((id) => id !== st.id) : [...s.away, st.id]; ctx.save(); draw(); },
          }));
        }
        extra.append(el('h3.section-title', { text: 'Who is here' }), grid);
      }

      function drawApart() {
        const byId = new Map(students.map((x) => [x.id, x.name]));
        const wrap = el('div.apart');
        for (const pair of s.apart) {
          wrap.append(el('div.apart-row', {}, [
            el('span.icon-wrap', { svg: icon('lock', 14) }),
            el('span', { text: `${byId.get(pair[0]) || '?'} and ${byId.get(pair[1]) || '?'}` }),
            el('button.icon-btn.icon-btn--danger', {
              svg: icon('close', 14), 'aria-label': 'Remove this rule',
              onclick: () => { s.apart = s.apart.filter((p) => p !== pair); ctx.save(); draw(); },
            }),
          ]));
        }

        const a = el('select.select.select--small');
        const b = el('select.select.select--small');
        for (const sel of [a, b]) {
          sel.append(el('option', { value: '', text: 'Choose…' }));
          for (const st of students) sel.append(el('option', { value: st.id, text: st.name }));
        }
        wrap.append(el('div.apart-row', {}, [
          a, el('span.hint', { text: 'and' }), b,
          el('button.btn.btn--small', {
            text: 'Keep apart',
            onclick: () => {
              if (!a.value || !b.value || a.value === b.value) { toast('Choose two different pupils.', 'warn'); return; }
              if (s.apart.some(([x, y]) => (x === a.value && y === b.value) || (x === b.value && y === a.value))) return;
              s.apart.push([a.value, b.value]);
              ctx.save(); draw();
            },
          }),
        ]));

        extra.append(
          el('h3.section-title', { text: 'Keep apart' }),
          el('p.hint', { text: 'These two never land in the same group, as long as the group sizes allow it.' }),
          wrap,
        );
      }

      async function drawSaved() {
        const host = el('div.saved');
        extra.append(el('h3.section-title', { text: 'Kept groupings' }), host);
        let saved = [];
        try { saved = (await Desk.api.groupings(s.classKey)).groupings || []; }
        catch { host.append(el('p.hint', { text: 'Could not load your kept groupings.' })); return; }

        if (!saved.length) { host.append(el('p.hint', { text: 'Nothing kept for this class yet.' })); return; }
        for (const g of saved) {
          host.append(el('div.saved-row', {}, [
            el('span.saved-name', { text: g.name }),
            el('span.hint', { text: `${g.groups.length} groups · ${when(g.createdAt)}` }),
            el('button.btn.btn--small', { text: 'Put back', onclick: () => { s.groups = g.groups.map((x) => ({ ...x })); ctx.save(); draw(); } }),
            el('button.icon-btn.icon-btn--danger', {
              svg: icon('trash', 14), 'aria-label': `Delete ${g.name}`,
              onclick: async () => { await Desk.api.deleteGrouping(g.id); draw(); },
            }),
          ]));
        }
      }

      async function saveGrouping() {
        const input = el('input.input', { type: 'text', placeholder: 'e.g. Science investigation', maxlength: 60 });
        if (!await Desk.ask({ title: 'Keep these groups', body: input, confirmLabel: 'Keep' })) return;
        try {
          await Desk.api.saveGrouping({
            classKey: s.classKey,
            className: '',
            name: input.value,
            groups: s.groups,
          });
          toast('Kept. You can put it back from this panel.');
          draw();
        } catch (e) { toast(e.message, 'warn'); }
      }

      const offRoster = Desk.roster.onChange(() => load());
      draw();

      return { destroy() { offRoster(); picker.destroy && picker.destroy(); } };
    },
  });
}(window.Desk));
