// ===================================================================
// Widget — Stopwatch
//
// Counts up, with laps. Like the timer it stores a start timestamp rather
// than a running total, so nothing drifts and a reload does not lose the run.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, duration } = Desk;

  const elapsed = (s) => (s.running ? s.accumulatedMs + (Date.now() - s.startedAt) : s.accumulatedMs);

  Desk.widget({
    type: 'stopwatch',
    name: 'Stopwatch',
    blurb: 'Count up, and record a lap for each pupil or each round.',
    icon: 'stopwatch',
    category: 'time',
    guest: true,
    tone: 'block',
    size: { w: 4, h: 4 },
    min: { w: 3, h: 3 },

    init(s) {
      if (typeof s.accumulatedMs !== 'number') s.accumulatedMs = 0;
      if (typeof s.startedAt !== 'number') s.startedAt = 0;
      if (typeof s.running !== 'boolean') s.running = false;
      if (!Array.isArray(s.laps)) s.laps = [];
      if (typeof s.title !== 'string') s.title = '';
    },

    holdsContent: (s) => (s.laps.length ? `${s.laps.length} lap time${s.laps.length === 1 ? '' : 's'} are on it.` : ''),

    mount(ctx) {
      const s = ctx.state;

      const digits = el('div.sw-digits');
      const lapList = el('ol.sw-laps');
      const playBtn = el('button.btn.btn--primary.btn--wide', { onclick: toggle });
      const lapBtn = el('button.btn', { onclick: lap });
      const titleInput = el('input.timer-title', {
        type: 'text', placeholder: 'What is being timed?', value: s.title, maxlength: 40,
        oninput: () => { s.title = titleInput.value; ctx.save(); },
      });

      ctx.root.append(el('div.stopwatch', {}, [
        ctx.expanded ? titleInput : (s.title ? el('div.timer-label', { text: s.title }) : null),
        digits,
        el('div.timer-controls', {}, [playBtn, lapBtn]),
        lapList,
      ]));

      function toggle() {
        Desk.sound.unlock();
        if (s.running) { s.accumulatedMs = elapsed(s); s.running = false; s.startedAt = 0; }
        else { s.startedAt = Date.now(); s.running = true; }
        ctx.save(); paintButtons();
      }

      function lap() {
        if (!s.running && !s.accumulatedMs) return;
        if (!s.running) { reset(); return; }
        const at = elapsed(s);
        const previous = s.laps.length ? s.laps[0].at : 0;
        s.laps.unshift({ id: `l${Date.now()}`, at, split: at - previous, label: '' });
        s.laps = s.laps.slice(0, 60);
        ctx.save(); drawLaps();
      }

      async function reset() {
        if (s.laps.length && !await Desk.ask({
          title: 'Clear the stopwatch?',
          body: `${s.laps.length} lap time${s.laps.length === 1 ? '' : 's'} will go too.`,
          confirmLabel: 'Clear', danger: true,
        })) return;
        s.accumulatedMs = 0; s.startedAt = 0; s.running = false; s.laps = [];
        ctx.save(); paintButtons(); drawLaps();
      }

      function drawLaps() {
        Desk.clear(lapList);
        const shown = ctx.expanded ? s.laps : s.laps.slice(0, 4);
        s.laps.forEach((l, i) => {
          if (!shown.includes(l)) return;
          const number = s.laps.length - i;
          const row = el('li.sw-lap', {}, [
            el('span.sw-lap-n', { text: `${number}` }),
            ctx.expanded
              ? el('input.sw-lap-label', {
                type: 'text', placeholder: 'Who?', value: l.label, maxlength: 30,
                oninput: (e) => { l.label = e.target.value; ctx.save(); },
              })
              : el('span.sw-lap-label-text', { text: l.label || '' }),
            el('span.sw-lap-split', { text: duration(l.split, { tenths: true }) }),
            el('span.sw-lap-total', { text: duration(l.at, { tenths: true }) }),
          ]);
          lapList.append(row);
        });
        if (!s.laps.length) lapList.append(el('li.hint', { text: ctx.expanded ? 'Press Lap while it runs to record a time.' : '' }));
        else if (!ctx.expanded && s.laps.length > 4) lapList.append(el('li.hint', { text: `and ${s.laps.length - 4} more` }));
      }

      function paintButtons() {
        Desk.clear(playBtn).append(
          el('span', { svg: icon(s.running ? 'pause' : 'play', 16) }),
          document.createTextNode(s.running ? ' Stop' : (s.accumulatedMs ? ' Continue' : ' Start')),
        );
        playBtn.classList.toggle('btn--danger', s.running);
        Desk.clear(lapBtn).append(document.createTextNode(s.running ? 'Lap' : 'Clear'));
        lapBtn.disabled = !s.running && !s.accumulatedMs;
      }

      let last = '';
      function paint() {
        const text = duration(elapsed(s), { tenths: true });
        if (text !== last) { digits.textContent = text; last = text; }
      }

      paintButtons(); drawLaps(); paint();
      return { frame: paint, tick: paint };
    },
  });
}(window.Desk));
