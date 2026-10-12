// ===================================================================
// Widget — Alarms
//
// Times of day rather than lengths of time: assembly at 10:40, pack away at
// 2:55, the bus at 3:20. Each alarm remembers which days it belongs to, so
// the Friday-only ones stay quiet the rest of the week.
//
// An alarm that has already rung today is marked with the date it rang, not
// a boolean — a tab left open over the weekend must not swallow Monday.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, clockTime, minutesNow } = Desk;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAYS = [1, 2, 3, 4, 5];

  const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

  /**
   * When this alarm next rings: { mins, ahead } where `ahead` is how many
   * days away it is, or null if it never does. The day matters as well as the
   * minutes — "at 2:21 pm" for something twenty-three hours away reads as
   * "in a moment".
   */
  function nextIn(a, now = minutesNow(), weekday = new Date().getDay()) {
    if (!a.enabled || !a.days.length) return null;
    for (let ahead = 0; ahead < 8; ahead += 1) {
      const day = (weekday + ahead) % 7;
      if (!a.days.includes(day)) continue;
      const mins = ahead * 1440 + a.minutes - now;
      if (mins >= 0) return { mins, ahead };
    }
    return null;
  }

  Desk.widget({
    type: 'alarms',
    name: 'Alarms',
    blurb: 'Ring at a time of day — assembly, pack away, the bus — on the days you choose.',
    icon: 'alarm',
    category: 'time',
    tone: 'card',
    guest: true,
    size: { w: 4, h: 4 },
    min: { w: 3, h: 4 },

    init(s) {
      if (!Array.isArray(s.alarms)) {
        s.alarms = [
          { id: 'a1', minutes: 10 * 60 + 40, label: 'Break', days: WEEKDAYS.slice(), enabled: false, sound: 'chime', rangOn: '' },
        ];
      }
      for (const a of s.alarms) {
        if (!Array.isArray(a.days)) a.days = WEEKDAYS.slice();
        if (!a.sound) a.sound = 'chime';
        if (typeof a.rangOn !== 'string') a.rangOn = '';
      }
    },

    holdsContent(s) {
      const on = s.alarms.filter((a) => a.enabled).length;
      return on ? `${on} alarm${on === 1 ? ' is' : 's are'} set.` : '';
    },

    mount(ctx) {
      const s = ctx.state;
      const nextLine = el('div.alarm-next');
      const list = el('div.alarm-list');
      const ringing = el('div.alarm-ringing', { hidden: true });

      ctx.root.append(el('div.alarms', {}, [
        ringing,
        nextLine,
        list,
        el('button.btn.btn--primary.btn--block', { svg: icon('plus', 16), onclick: () => addAlarm() }, ' Add an alarm'),
        ctx.expanded ? el('p.hint', { text: 'Alarms ring while this desk is open in a tab, even a background one. They cannot ring if the browser is closed.' }) : null,
      ]));

      function addAlarm() {
        const now = minutesNow();
        s.alarms.push({
          id: `a${Date.now().toString(36)}`,
          minutes: Math.min(23 * 60 + 59, now + 15),
          label: '', days: WEEKDAYS.slice(), enabled: true, sound: 'chime', rangOn: '',
        });
        ctx.save(); draw();
      }

      function draw() {
        Desk.clear(list);
        const sorted = s.alarms.slice().sort((a, b) => a.minutes - b.minutes);

        for (const a of sorted) {
          const timeInput = el('input.alarm-time', {
            type: 'time',
            value: `${String(Math.floor(a.minutes / 60)).padStart(2, '0')}:${String(a.minutes % 60).padStart(2, '0')}`,
            // Fires part-way through typing a time, so the caret has to
            // survive the redraw that follows.
            onchange: (e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              if (Number.isFinite(h) && Number.isFinite(m)) { a.minutes = h * 60 + m; a.rangOn = ''; ctx.save(); Desk.keepFocus(ctx.root, draw); }
            },
          });

          const toggle = el('button.switch', {
            role: 'switch', 'aria-checked': String(!!a.enabled), class: a.enabled ? 'is-on' : '',
            'aria-label': `Turn ${a.label || 'this alarm'} ${a.enabled ? 'off' : 'on'}`,
            onclick: () => { a.enabled = !a.enabled; a.rangOn = ''; Desk.sound.unlock(); ctx.save(); draw(); },
          }, el('span.switch-dot'));

          const head = el('div.alarm-head', {}, [
            toggle,
            timeInput,
            el('input.alarm-label', {
              type: 'text', placeholder: 'What for?', value: a.label, maxlength: 30,
              oninput: (e) => { a.label = e.target.value; ctx.save(); },
            }),
            el('button.icon-btn.icon-btn--danger', {
              title: 'Delete this alarm', 'aria-label': 'Delete this alarm', svg: icon('trash', 15),
              onclick: () => { s.alarms = s.alarms.filter((x) => x !== a); ctx.save(); draw(); },
            }),
          ]);

          const dayRow = el('div.alarm-days');
          DAYS.forEach((name, i) => {
            dayRow.append(el('button.day', {
              text: name[0], title: name,
              'aria-pressed': String(a.days.includes(i)),
              class: a.days.includes(i) ? 'is-on' : '',
              onclick: () => {
                a.days = a.days.includes(i) ? a.days.filter((d) => d !== i) : [...a.days, i].sort();
                a.rangOn = ''; ctx.save(); Desk.keepFocus(ctx.root, draw);
              },
            }));
          });

          const row = el('div.alarm', { class: a.enabled ? '' : 'is-off' }, [head, dayRow]);

          if (ctx.expanded) {
            const soundSelect = el('select.select.select--small', {
              onchange: (e) => { a.sound = e.target.value; ctx.save(); Desk.sound.preview(a.sound); },
            });
            for (const key of Desk.sound.options) {
              soundSelect.append(el('option', { value: key, text: Desk.sound.NAMES[key], selected: a.sound === key }));
            }
            row.append(el('div.alarm-sound', {}, [el('span.field-label', { svg: icon('sound', 15) }), soundSelect]));
          }

          list.append(row);
        }

        if (!s.alarms.length) list.append(el('p.hint', { text: 'No alarms yet.' }));
        paintNext();
      }

      function paintNext() {
        const upcoming = s.alarms
          .map((a) => ({ a, next: nextIn(a) }))
          .filter((x) => x.next)
          .sort((x, y) => x.next.mins - y.next.mins)[0];

        if (!upcoming) { nextLine.textContent = 'Nothing set'; nextLine.classList.remove('is-live'); return; }
        const { a, next: { mins, ahead } } = upcoming;
        const at = clockTime(a.minutes);
        const when = mins < 60 ? `in ${mins} min`
          : ahead === 0 ? `at ${at}`
            : ahead === 1 ? `tomorrow at ${at}`
              : `${DAYS[(new Date().getDay() + ahead) % 7]} at ${at}`;
        Desk.clear(nextLine).append(
          el('span.alarm-next-label', { text: a.label || 'Alarm' }),
          el('span.alarm-next-when', { text: when }),
        );
        nextLine.classList.add('is-live');
      }

      function showRinging(a) {
        Desk.clear(ringing).append(
          el('span.icon-wrap', { svg: icon('alarm', 20) }),
          el('span.alarm-ringing-label', { text: a.label || `It is ${clockTime(a.minutes)}` }),
          el('button.btn.btn--small', { text: 'Stop', onclick: () => { ringing.hidden = true; } }),
        );
        ringing.hidden = false;
        setTimeout(() => { ringing.hidden = true; }, 60_000);
      }

      draw();

      return {
        tick() {
          const now = minutesNow();
          const day = new Date().getDay();
          const stamp = today();
          let changed = false;
          for (const a of s.alarms) {
            if (!a.enabled || !a.days.includes(day)) continue;
            if (a.rangOn === stamp) continue;
            // Ring at the minute, or within two minutes after — a laptop that
            // was asleep at 10:40 should still say so at 10:41.
            if (now >= a.minutes && now - a.minutes <= 2) {
              a.rangOn = stamp;
              changed = true;
              Desk.sound.play(a.sound, { repeat: 2 });
              if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
              showRinging(a);
            }
          }
          if (changed) ctx.save();
          paintNext();
        },
      };
    },
  });
}(window.Desk));
