// ===================================================================
// Widget — Scoreboard
//
// Team points, house points, table points. Deliberately about GROUPS rather
// than individuals: a public running total against a child's name is the
// thing the behaviour tracker was kept private to avoid, and putting one on
// the projector by accident would undo that.
//
// Teams can be typed in, or taken from a set of groups the group maker has
// already made, so the same four tables do not have to be entered twice.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast, shuffle } = Desk;

  // In the same order as the starting teams, so a new board's "Red" is red.
  // The two lists used to disagree — Red was blue, Blue was green — which a
  // thin coloured stripe hid and a coloured team does not.
  const COLOURS = ['red', 'accent', 'green', 'yellow', 'purple', 'teal'];
  const STARTER = ['Red', 'Blue', 'Green', 'Yellow'];

  /* A team named after a colour is that colour, whatever it was saved as.
     Children read "Blue team" off the board and look for blue. */
  const NAMED = { red: 'red', blue: 'accent', green: 'green', yellow: 'yellow', purple: 'purple', teal: 'teal' };
  const colourFor = (team) => NAMED[String(team.name || '').trim().toLowerCase()] || team.colour;

  Desk.widget({
    type: 'scoreboard',
    name: 'Scoreboard',
    blurb: 'Points for teams, houses or tables. Groups rather than named children, on purpose.',
    icon: 'trophy',
    category: 'class',
    guest: true,
    size: { w: 4, h: 4 },
    min: { w: 2, h: 3 },

    init(s) {
      if (!Array.isArray(s.teams) || !s.teams.length) {
        s.teams = STARTER.map((name, i) => ({ id: `t${i}`, name, score: 0, colour: COLOURS[i % COLOURS.length] }));
      }
      // Put right any team whose name says one colour and whose fill says
      // another — every board made before the two lists agreed.
      for (const team of s.teams) team.colour = colourFor(team);
      if (typeof s.step !== 'number') s.step = 1;
      if (typeof s.title !== 'string') s.title = '';
    },

    holdsContent(s) {
      const played = s.teams.some((t) => t.score);
      return played ? 'The scores go with it.' : '';
    },

    mount(ctx) {
      const s = ctx.state;
      const list = el('div.score-list');
      const foot = el('div.score-foot');
      const titleInput = el('input.note-title', {
        type: 'text', maxlength: 30, value: s.title, placeholder: 'What are we playing?',
        oninput: (e) => { s.title = e.target.value; ctx.save(); },
      });

      ctx.root.append(el('div.scoreboard', {}, [
        ctx.expanded ? titleInput : (s.title ? el('div.timer-label', { text: s.title }) : null),
        list, foot,
      ]));

      const leader = () => Math.max(0, ...s.teams.map((t) => t.score));

      let bumped = null;          // { id, up } — the score to make a fuss of on this draw

      function bump(team, by) {
        team.score = Math.max(-999, Math.min(9999, team.score + by));
        bumped = { id: team.id, up: by > 0 };
        ctx.save();
        draw();
        bumped = null;
        if (by > 0) Desk.sound.play('tick');
      }

      function draw() {
        Desk.clear(list);
        const top = leader();

        for (const team of s.teams) {
          const winning = top > 0 && team.score === top;
          const row = el(`div.score-row.score-row--${team.colour}`, { class: winning ? 'is-leading' : '' }, [
            ctx.expanded
              ? el('input.score-name', {
                type: 'text', value: team.name, maxlength: 20,
                oninput: (e) => {
                  team.name = e.target.value;
                  const was = team.colour;
                  team.colour = colourFor(team);
                  if (team.colour !== was) row.className = `score-row score-row--${team.colour}${winning ? ' is-leading' : ''}`;
                  ctx.save();
                },
              })
              : el('span.score-name-text', { text: team.name }),
            el('button.score-btn', { text: '−', 'aria-label': `Take a point from ${team.name}`, onclick: () => bump(team, -s.step) }),
            el('span.score-value', {
              text: String(team.score),
              class: bumped && bumped.id === team.id ? (bumped.up ? 'is-up' : 'is-down') : '',
            }),
            el('button.score-btn.score-btn--plus', { text: '+', 'aria-label': `Give a point to ${team.name}`, onclick: () => bump(team, s.step) }),
          ]);

          if (ctx.expanded) {
            row.append(el('button.icon-btn.icon-btn--danger', {
              svg: icon('trash', 14), 'aria-label': `Remove ${team.name}`,
              onclick: () => { s.teams = s.teams.filter((t) => t !== team); ctx.save(); draw(); },
            }));
          }
          list.append(row);
        }

        drawFoot();
      }

      function drawFoot() {
        Desk.clear(foot);
        if (!ctx.expanded) {
          foot.append(el('button.btn.btn--small', { svg: icon('reset', 14), onclick: reset }, ' Reset'));
          return;
        }

        foot.append(
          el('div.plan-row', {}, [
            el('span.hint', { text: 'Points per tap' }),
            el('div.stepper', {}, [
              el('button.icon-btn', { svg: icon('minus', 15), 'aria-label': 'Fewer', onclick: () => { s.step = Math.max(1, s.step - 1); ctx.save(); drawFoot(); } }),
              el('span.stepper-value', { text: String(s.step) }),
              el('button.icon-btn', { svg: icon('plus', 15), 'aria-label': 'More', onclick: () => { s.step = Math.min(50, s.step + 1); ctx.save(); drawFoot(); } }),
            ]),
          ]),
          el('div.starter-row', {}, [
            el('button.btn.btn--small', { svg: icon('plus', 14), onclick: addTeam }, ' Add a team'),
            // Saved groupings live in an account; a visitor has none to borrow from.
            ctx.guest ? null : el('button.btn.btn--small', { svg: icon('groups', 14), onclick: fromGroups }, ' From my groups'),
            el('button.btn.btn--small', { svg: icon('reset', 14), onclick: reset }, ' Reset scores'),
          ]),
        );
      }

      function addTeam() {
        if (s.teams.length >= 12) { toast('That is as many teams as fit.', 'warn'); return; }
        s.teams.push({
          id: `t${Date.now().toString(36)}`,
          name: `Team ${s.teams.length + 1}`,
          score: 0,
          colour: COLOURS[s.teams.length % COLOURS.length],
        });
        ctx.save(); draw();
      }

      /** Borrows the teams from a grouping the group maker already saved. */
      async function fromGroups() {
        let saved = [];
        try { saved = (await Desk.api.groupings()).groupings || []; }
        catch { toast('Could not load your groupings.', 'warn'); return; }
        if (!saved.length) { toast('Keep a set of groups in the group maker first.', 'warn'); return; }

        const host = el('div.saved');
        let picked = null;
        for (const g of saved) {
          host.append(el('button.btn.btn--small.btn--block', {
            onclick: (e) => { e.preventDefault(); picked = g; for (const b of host.children) b.classList.remove('is-on'); e.target.closest('.btn').classList.add('is-on'); },
          }, `${g.name} — ${g.groups.length} groups`));
        }

        if (!await Desk.ask({ title: 'Use a set of groups', body: host, confirmLabel: 'Use it' }) || !picked) return;
        s.teams = picked.groups.slice(0, 12).map((g, i) => ({
          id: `t${i}${Date.now().toString(36)}`,
          name: g.label || `Group ${i + 1}`,
          score: 0,
          colour: COLOURS[i % COLOURS.length],
        }));
        ctx.save(); draw();
      }

      async function reset() {
        if (!s.teams.some((t) => t.score)) return;
        if (!await Desk.ask({ title: 'Back to nil?', body: 'Every score goes to zero. The teams stay.', confirmLabel: 'Reset' })) return;
        for (const t of s.teams) t.score = 0;
        ctx.save(); draw();
      }

      draw();
      return {};
    },
  });
}(window.Desk));
