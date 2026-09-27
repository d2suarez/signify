// ===================================================================
// Widget — Countdown to a day
//
// Days until the trip, the holidays, the exam. Not the lesson timer — this
// one counts in sleeps, and it is the thing a class asks about every morning.
//
// It counts whole DAYS by calendar date, not by elapsed hours: "3 days" has
// to mean three more times waking up, so a countdown set on Monday afternoon
// still says the same thing on Monday evening.
//
// It holds several days rather than one, because a term has several: the
// nearest one still to come gets the big number, the rest wait their turn
// underneath, and a day that has been and gone can be taken off the list.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon } = Desk;

  const EMOJI = ['', '🎒', '🎄', '🏖️', '🎂', '🎭', '🏆', '🚌', '🔬', '📚'];
  const MAX = 8;

  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  /** Whole days between today and a yyyy-mm-dd, by date rather than by hours. */
  function daysUntil(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return null;
    const target = new Date(y, m - 1, d);
    if (Number.isNaN(target.getTime())) return null;
    // Both ends floored to midnight LOCAL, so daylight saving cannot make a
    // day disappear or appear.
    return Math.round((startOfDay(target) - startOfDay(new Date())) / 864e5);
  }

  function phrase(days) {
    if (days === 0) return { big: 'Today', small: 'It is today' };
    if (days === 1) return { big: '1', small: 'more sleep' };
    if (days > 1) return { big: String(days), small: 'more sleeps' };
    if (days === -1) return { big: 'Yesterday', small: '' };
    return { big: `${Math.abs(days)}`, small: 'days ago' };
  }

  const longDate = (iso) => new Date(`${iso}T00:00`)
    .toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

  /**
   * The days in the order a class cares about them: the next one first, then
   * the ones after it, and anything already past at the bottom.
   */
  function ordered(events) {
    const dated = events.filter((e) => daysUntil(e.date) != null);
    return dated.slice().sort((a, b) => {
      const da = daysUntil(a.date);
      const db = daysUntil(b.date);
      const pastA = da < 0 ? 1 : 0;
      const pastB = db < 0 ? 1 : 0;
      if (pastA !== pastB) return pastA - pastB;
      return pastA ? db - da : da - db;
    });
  }

  Desk.widget({
    type: 'countdown',
    name: 'Countdown to a day',
    blurb: 'Sleeps until the trip, the holidays or the concert — the thing they ask about every morning.',
    icon: 'calendar',
    category: 'time',
    guest: true,
    tone: 'block',
    size: { w: 3, h: 4 },
    min: { w: 2, h: 3 },

    init(s) {
      if (!Array.isArray(s.events)) s.events = [];
      // Boards made when this widget counted down to exactly one day.
      if (typeof s.date === 'string' && s.date && !s.events.length) {
        s.events = [{ id: 'e0', label: s.label || '', date: s.date, emoji: s.emoji || '' }];
      }
      delete s.label; delete s.date; delete s.emoji;
      for (const e of s.events) {
        if (!e.id) e.id = `e${Math.random().toString(36).slice(2, 8)}`;
      }
    },

    holdsContent(s) {
      const n = (s.events || []).filter((e) => e.date).length;
      return n ? `${n} date${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} with it.` : '';
    },

    mount(ctx) {
      const s = ctx.state;
      // Which row has its emoji picker open. Local, not saved: it is where the
      // teacher is looking, not part of the countdown.
      let picking = null;

      const face = el('div.cd-face');
      const settings = el('div.cd-settings');

      ctx.root.append(el('div.countdown', {}, [face, settings]));

      const newId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

      function draw() {
        drawFace();
        drawSettings();
      }

      /** Just the numbers and the labels. Safe to call while typing. */
      function drawFace() {
        Desk.clear(face);
        const list = ordered(s.events);

        if (!list.length) {
          face.append(el('p.hint', { text: 'Pick a day to count down to.' }));
          return;
        }

        const [next, ...rest] = list;
        const days = daysUntil(next.date);
        const { big, small } = phrase(days);

        Desk.append(face,
          next.emoji ? el('div.cd-emoji', { text: next.emoji }) : null,
          el('div.cd-big', { class: days < 0 ? 'is-past' : days === 0 ? 'is-today' : '', text: big }),
          small ? el('div.cd-small', { text: small }) : null,
          el('div.cd-label', { text: next.label || '' }),
          el('div.hint', { text: longDate(next.date) }),
        );

        // The rest, small. Three is as many as fits on a card without the big
        // number losing the room it needs to be readable from the back.
        if (rest.length) {
          const others = el('div.cd-others');
          for (const e of rest.slice(0, ctx.expanded ? rest.length : 3)) {
            const d = daysUntil(e.date);
            const { big: b, small: sm } = phrase(d);
            others.append(el('div.cd-other', { class: d < 0 ? 'is-past' : '' }, [
              el('span.cd-other-when', { text: sm === 'more sleeps' || sm === 'more sleep' ? `${b}` : b }),
              el('span.cd-other-what', { text: `${e.emoji ? `${e.emoji} ` : ''}${e.label || longDate(e.date)}` }),
            ]));
          }
          face.append(others);
        }
      }

      function drawSettings() {
        Desk.clear(settings);
        // Collapsed, with something to show, the card is just the countdown.
        if (!ctx.expanded && s.events.length) return;

        const rows = el('div.cd-rows');
        s.events.forEach((e, i) => {
          const row = el('div.cd-row');

          const line = el('div.cd-line', {}, [
            el('button.chip.cd-emoji-btn', {
              text: e.emoji || '＋',
              title: 'A picture for it',
              'aria-label': `A picture for ${e.label || 'this day'}`,
              onclick: () => { picking = picking === e.id ? null : e.id; drawSettings(); },
            }),
            el('input.input', {
              type: 'text', maxlength: 40, value: e.label, placeholder: 'e.g. Trip to the museum',
              // Only the face. Rebuilding the settings here would destroy this
              // very input and drop the caret after every keystroke.
              oninput: (ev) => { e.label = ev.target.value; ctx.save(); drawFace(); },
            }),
            el('input.input.cd-date', {
              type: 'date', value: e.date,
              // A date picker can fire change part-way through typing one, so
              // the caret has to survive the redraw.
              onchange: (ev) => { e.date = ev.target.value; ctx.save(); Desk.keepFocus(ctx.root, draw); },
            }),
            el('button.icon-btn.icon-btn--danger', {
              svg: icon('trash', 14),
              title: 'Remove this day',
              'aria-label': `Remove ${e.label || 'this day'}`,
              onclick: () => {
                s.events.splice(i, 1);
                if (picking === e.id) picking = null;
                ctx.save();
                draw();
              },
            }),
          ]);
          row.append(line);

          if (picking === e.id) {
            const chips = el('div.chips');
            for (const ch of EMOJI) {
              chips.append(el('button.chip', {
                text: ch || 'None',
                class: e.emoji === ch ? 'is-on' : '',
                onclick: () => { e.emoji = ch; picking = null; ctx.save(); draw(); },
              }));
            }
            row.append(chips);
          }

          rows.append(row);
        });
        settings.append(rows);

        if (s.events.length < MAX) {
          settings.append(el('div.starter-row', {}, [
            el('button.btn.btn--small', {
              svg: icon('plus', 14),
              onclick: () => {
                s.events.push({ id: newId(), label: '', date: '', emoji: '' });
                ctx.save();
                draw();
              },
            }, s.events.length ? ' Add another day' : ' Add a day'),
          ]));
        }

        // Only worth saying once there is something that has been and gone.
        if (s.events.some((e) => { const d = daysUntil(e.date); return d != null && d < 0; })) {
          settings.append(el('p.hint', { text: 'Days that have passed drop to the bottom. Remove one with the bin when you are done with it.' }));
        }
      }

      draw();

      // Days only change at midnight, so a check every half minute is ample
      // and keeps a desk left open overnight honest.
      let lastDay = new Date().getDate();
      return {
        tick() {
          const today = new Date().getDate();
          if (today !== lastDay) { lastDay = today; drawFace(); }
        },
      };
    },
  });
}(window.Desk));
