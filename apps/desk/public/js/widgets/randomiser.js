// ===================================================================
// Widget — Student randomiser
//
// Picks a pupil. The default is "everyone before anyone twice", because the
// thing a class notices about a random picker is the child it picks three
// times in a row while somebody else is never asked all week.
//
// Who has already had a turn is kept in the widget's own state, so it
// survives the lesson and is still there after lunch.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, shuffle, toast } = Desk;

  Desk.widget({
    type: 'randomiser',
    name: 'Student randomiser',
    blurb: 'Pick a pupil at random — with everyone getting a turn before anyone gets a second.',
    icon: 'randomiser',
    size: { w: 4, h: 5 },
    min: { w: 3, h: 4 },
    needsRoster: true,

    init(s) {
      if (typeof s.classKey !== 'string') s.classKey = '';
      if (typeof s.noRepeats !== 'boolean') s.noRepeats = true;
      if (!Array.isArray(s.drawn)) s.drawn = [];
      if (!Array.isArray(s.away)) s.away = [];
      if (typeof s.sound !== 'string') s.sound = 'tick';
      if (!s.last) s.last = null;
    },

    holdsContent: (s) => (s.drawn.length ? `${s.drawn.length} pupil${s.drawn.length === 1 ? ' has' : 's have'} had a turn.` : ''),

    mount(ctx) {
      const s = ctx.state;
      let students = [];
      let rolling = null;

      const nameEl = el('div.pick-name', { text: s.last ? s.last.name : '—' });
      const countEl = el('div.pick-count');
      const pickBtn = el('button.btn.btn--primary.btn--wide.pick-btn', { onclick: pick }, 'Pick someone');
      const body = el('div.pick-extra');

      const picker = Desk.roster.picker({
        value: s.classKey,
        onPick: (key) => {
          // Mount reports the current class as a "choice"; only a real change
          // should clear who has already had a turn.
          if (key !== s.classKey) { s.classKey = key; s.drawn = []; s.last = null; ctx.save(); }
          load();
        },
      });

      ctx.root.append(el('div.randomiser', {}, [
        picker,
        el('div.pick-face', {}, [nameEl, countEl]),
        pickBtn,
        body,
      ]));

      async function load() {
        students = [];
        if (!s.classKey) { paint(); return; }
        try {
          students = await Desk.roster.members(s.classKey);
        } catch (e) {
          toast(e.message, 'warn');
        }
        // Forget anyone who has left the class, or the counter never empties.
        const ids = new Set(students.map((x) => x.id));
        s.drawn = s.drawn.filter((id) => ids.has(id));
        s.away = s.away.filter((id) => ids.has(id));
        paint();
      }

      const pool = () => students.filter((x) => !s.away.includes(x.id) && (!s.noRepeats || !s.drawn.includes(x.id)));

      function pick() {
        Desk.sound.unlock();
        if (rolling) return;
        if (!students.length) { toast('Choose a class list first.', 'warn'); return; }

        let candidates = pool();
        if (!candidates.length) {
          if (!s.noRepeats) { toast('Everyone is marked away.', 'warn'); return; }
          // A round has finished. Start the next one rather than stopping.
          s.drawn = [];
          candidates = pool();
          if (!candidates.length) { toast('Everyone is marked away.', 'warn'); return; }
          toast('Everyone has had a turn — starting again.');
        }

        const winner = candidates[Math.floor(Math.random() * candidates.length)];
        // Roll through the names, slowing down, then land on the winner.
        const reel = shuffle(students.length > 1 ? students : candidates);
        const startedAt = performance.now();
        const RUN = 1500;
        let i = 0;
        let nextAt = 0;

        pickBtn.disabled = true;
        nameEl.classList.add('is-rolling');

        rolling = (now) => {
          const t = Math.min(1, (now - startedAt) / RUN);
          if (t >= 1) {
            cancel();
            s.last = { id: winner.id, name: winner.name, at: Date.now() };
            if (!s.drawn.includes(winner.id)) s.drawn.push(winner.id);
            ctx.save();
            nameEl.textContent = winner.name;
            nameEl.classList.add('is-landed');
            setTimeout(() => nameEl.classList.remove('is-landed'), 900);
            Desk.sound.play('rise');
            paint();
            return;
          }
          if (now >= nextAt) {
            // 45ms at the start, easing out to about 260ms at the end.
            nextAt = now + 45 + 215 * (t * t);
            nameEl.textContent = reel[i % reel.length].name;
            i += 1;
            if (s.sound !== 'none') Desk.sound.play('tick');
          }
        };

        function cancel() {
          rolling = null;
          pickBtn.disabled = false;
          nameEl.classList.remove('is-rolling');
        }
      }

      function paint() {
        const left = pool().length;
        const total = students.filter((x) => !s.away.includes(x.id)).length;

        if (!s.classKey) countEl.textContent = 'No class chosen';
        else if (!total) countEl.textContent = 'Nobody on this list';
        else if (s.noRepeats) countEl.textContent = `${left} of ${total} still to have a turn`;
        else countEl.textContent = `${total} in the class`;

        if (!s.last) nameEl.textContent = students.length ? 'Ready' : '—';
        else if (!rolling) nameEl.textContent = s.last.name;

        Desk.clear(body);
        body.append(el('label.check-inline', {}, [
          el('input', {
            type: 'checkbox', checked: s.noRepeats,
            onchange: (e) => { s.noRepeats = e.target.checked; ctx.save(); paint(); },
          }),
          el('span', { text: 'Everyone before anyone twice' }),
        ]));

        if (s.drawn.length) {
          body.append(el('button.btn.btn--small', {
            svg: icon('reset', 14),
            onclick: () => { s.drawn = []; s.last = null; ctx.save(); paint(); },
          }, ' Start the round again'));
        }

        if (ctx.expanded) drawRoll();
      }

      function drawRoll() {
        if (!students.length) return;
        const grid = el('div.pick-roll');
        for (const st of students) {
          const away = s.away.includes(st.id);
          const had = s.drawn.includes(st.id);
          grid.append(el('button.pick-chip', {
            text: st.name,
            title: away ? 'Marked away — tap to include' : 'Tap to mark away',
            class: [away ? 'is-away' : '', had ? 'is-had' : ''].filter(Boolean).join(' '),
            onclick: () => {
              s.away = away ? s.away.filter((id) => id !== st.id) : [...s.away, st.id];
              ctx.save(); paint();
            },
          }));
        }
        body.append(
          el('h3.section-title', { text: 'Who is here' }),
          el('p.hint', { text: 'Tap anyone who is away to leave them out. Names that have already had a turn are marked.' }),
          grid,
        );
      }

      const offRoster = Desk.roster.onChange(() => load());
      paint();

      return {
        frame() { if (rolling) rolling(performance.now()); },
        destroy() { offRoster(); picker.destroy && picker.destroy(); },
      };
    },
  });
}(window.Desk));
