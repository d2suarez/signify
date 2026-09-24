// ===================================================================
// Widget — Clock
//
// Analogue or digital, in any timezone, in the teacher's own colours.
//
// The analogue face exists for a reason beyond decoration: a class learning
// to tell the time needs a clock with hands on the wall, and most classrooms
// no longer have one. So the hands move smoothly, the numerals can be shown,
// and it is readable from the back of the room when opened up.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, pad } = Desk;

  const FACES = [
    { key: 'analogue', label: 'Hands' },
    { key: 'digital', label: 'Digital' },
  ];

  // A short list rather than the full IANA set: a picker with 400 entries is
  // worse than one with the places a school actually calls.
  const ZONES = [
    { id: '', label: 'Here' },
    { id: 'America/Los_Angeles', label: 'Los Angeles' },
    { id: 'America/Denver', label: 'Denver' },
    { id: 'America/Chicago', label: 'Chicago' },
    { id: 'America/New_York', label: 'New York' },
    { id: 'America/Sao_Paulo', label: 'São Paulo' },
    { id: 'Europe/London', label: 'London' },
    { id: 'Europe/Paris', label: 'Paris' },
    { id: 'Africa/Lagos', label: 'Lagos' },
    { id: 'Africa/Nairobi', label: 'Nairobi' },
    { id: 'Asia/Jerusalem', label: 'Jerusalem' },
    { id: 'Asia/Dubai', label: 'Dubai' },
    { id: 'Asia/Kolkata', label: 'Delhi' },
    { id: 'Asia/Shanghai', label: 'Beijing' },
    { id: 'Asia/Tokyo', label: 'Tokyo' },
    { id: 'Australia/Sydney', label: 'Sydney' },
    { id: 'Pacific/Auckland', label: 'Auckland' },
  ];

  const COLOURS = [
    { key: 'accent', label: 'Theme colour', css: 'var(--accent)' },
    { key: 'ink', label: 'Ink', css: 'var(--ink)' },
    { key: 'red', label: 'Red', css: 'var(--red)' },
    { key: 'yellow', label: 'Yellow', css: 'var(--yellow)' },
    { key: 'green', label: 'Green', css: 'var(--green)' },
  ];
  const cssFor = (key) => (COLOURS.find((c) => c.key === key) || COLOURS[0]).css;

  /**
   * The wall-clock time in a zone, as plain numbers.
   *
   * Intl is the only thing that knows about daylight saving, so the parts come
   * from a formatter rather than from arithmetic on an offset. Seconds carry
   * the fraction from Date so the second hand can sweep instead of tick.
   */
  function partsIn(zone, now) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone || undefined,
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', day: 'numeric', month: 'short',
    });
    const got = {};
    for (const p of fmt.formatToParts(now)) got[p.type] = p.value;
    return {
      h: Number(got.hour) % 24,
      m: Number(got.minute),
      s: Number(got.second) + (now.getMilliseconds() / 1000),
      date: `${got.weekday} ${got.day} ${got.month}`,
    };
  }

  Desk.widget({
    type: 'clock',
    name: 'Clock',
    blurb: 'Hands or digits, any timezone, in your colours. The face with hands is the one a class can learn to read.',
    icon: 'clock',
    category: 'time',
    tone: 'block',
    role: 'p4',
    fills: true,
    size: { w: 3, h: 4 },
    min: { w: 2, h: 3 },

    // The clock is the one readout that is always worth having: a teacher
    // glances at the top of the board rather than at the wall.
    readout(s) {
      const p = partsIn(s.zone, new Date());
      const hour = s.hour12 ? (p.h % 12 || 12) : String(p.h).padStart(2, '0');
      return {
        value: `${hour}:${String(p.m).padStart(2, '0')}`,
        caption: s.label || p.date,
      };
    },

    init(s) {
      if (!FACES.some((f) => f.key === s.face)) s.face = 'analogue';
      if (typeof s.zone !== 'string') s.zone = '';
      if (typeof s.label !== 'string') s.label = '';
      if (!COLOURS.some((c) => c.key === s.colour)) s.colour = 'accent';
      if (typeof s.numerals !== 'boolean') s.numerals = true;
      if (typeof s.seconds !== 'boolean') s.seconds = true;
      if (typeof s.hour12 !== 'boolean') s.hour12 = true;
      if (typeof s.showDate !== 'boolean') s.showDate = false;
    },

    mount(ctx) {
      const s = ctx.state;

      const face = el('div.clock-face');
      const dateLine = el('div.clock-date');
      const nameLine = el('div.clock-zone');
      const controls = el('div.clock-controls');

      ctx.root.append(el('div.clock', {}, [nameLine, face, dateLine, controls]));

      // ---------- the two faces ----------

      let hands = null;

      function buildAnalogue() {
        const marks = [];
        for (let i = 0; i < 60; i += 1) {
          const big = i % 5 === 0;
          // Ticks live in the outer ring only. They used to reach as far in as
          // the numerals sit, which drew a line straight through every number.
          marks.push(`<line class="tick${big ? ' tick--hour' : ''}" x1="50" y1="${big ? 5 : 6.5}" x2="50" y2="${big ? 10 : 8.5}" transform="rotate(${i * 6} 50 50)"/>`);
        }
        const numerals = s.numerals ? Array.from({ length: 12 }, (_, i) => {
          const n = i === 0 ? 12 : i;
          const a = (i * 30 - 90) * (Math.PI / 180);
          return `<text class="numeral" x="${50 + 31 * Math.cos(a)}" y="${50 + 31 * Math.sin(a)}">${n}</text>`;
        }).join('') : '';

        face.innerHTML = `<svg viewBox="0 0 100 100" class="clock-svg" role="img" aria-label="Clock face">
          <circle class="clock-rim" cx="50" cy="50" r="48"/>
          ${marks.join('')}${numerals}
          <line class="hand hand--hour" x1="50" y1="55" x2="50" y2="30"/>
          <line class="hand hand--minute" x1="50" y1="57" x2="50" y2="21"/>
          ${s.seconds ? '<line class="hand hand--second" x1="50" y1="60" x2="50" y2="17"/>' : ''}
          <circle class="clock-pin" cx="50" cy="50" r="2.4"/>
        </svg>`;
        hands = {
          hour: face.querySelector('.hand--hour'),
          minute: face.querySelector('.hand--minute'),
          second: face.querySelector('.hand--second'),
        };
      }

      function buildDigital() {
        face.innerHTML = '';
        hands = null;
        face.append(el('div.clock-digits'), el('div.clock-suffix'));
      }

      function build() {
        face.classList.toggle('is-analogue', s.face === 'analogue');
        face.style.setProperty('--clock-colour', cssFor(s.colour));
        if (s.face === 'analogue') buildAnalogue(); else buildDigital();
        paint();
      }

      // ---------- painting ----------

      let lastDigits = '';
      function paint() {
        const p = partsIn(s.zone, new Date());

        if (hands) {
          const sec = s.seconds ? p.s : 0;
          const min = p.m + sec / 60;
          const hr = (p.h % 12) + min / 60;
          hands.hour.setAttribute('transform', `rotate(${hr * 30} 50 50)`);
          hands.minute.setAttribute('transform', `rotate(${min * 6} 50 50)`);
          if (hands.second) hands.second.setAttribute('transform', `rotate(${sec * 6} 50 50)`);
        } else {
          const h24 = p.h;
          const h = s.hour12 ? (h24 % 12 || 12) : h24;
          const text = `${s.hour12 ? h : pad(h)}:${pad(p.m)}${s.seconds ? `:${pad(Math.floor(p.s))}` : ''}`;
          if (text !== lastDigits) {
            face.querySelector('.clock-digits').textContent = text;
            lastDigits = text;
          }
          face.querySelector('.clock-suffix').textContent = s.hour12 ? (h24 < 12 ? 'am' : 'pm') : '';
        }

        dateLine.textContent = s.showDate ? p.date : '';
        dateLine.hidden = !s.showDate;

        const zone = ZONES.find((z) => z.id === s.zone);
        const name = s.label || (s.zone ? (zone ? zone.label : s.zone.split('/').pop().replace(/_/g, ' ')) : '');
        nameLine.textContent = name;
        nameLine.hidden = !name;
      }

      // ---------- settings ----------

      function drawControls() {
        Desk.clear(controls);
        if (!ctx.expanded) return;

        const seg = (options, value, onPick) => el('div.seg', {}, options.map((o) => el('button.seg-btn', {
          text: o.label,
          class: value === o.key ? 'is-on' : '',
          onclick: () => { onPick(o.key); ctx.save(); build(); drawControls(); },
        })));

        controls.append(
          el('div.plan-row', {}, [el('span.hint', { text: 'Face' }), seg(FACES, s.face, (v) => { s.face = v; })]),
          el('div.plan-row', {}, [
            el('span.hint', { text: 'Colour' }),
            el('div.swatches', {}, COLOURS.map((c) => el('button.swatch', {
              title: c.label, 'aria-label': c.label,
              class: s.colour === c.key ? 'is-on' : '',
              style: { background: c.css },
              onclick: () => { s.colour = c.key; ctx.save(); build(); drawControls(); },
            }))),
          ]),
        );

        const zoneSelect = el('select.select', {
          onchange: (e) => { s.zone = e.target.value; ctx.save(); paint(); },
        });
        for (const z of ZONES) zoneSelect.append(el('option', { value: z.id, text: z.label, selected: s.zone === z.id }));
        controls.append(el('label.field', {}, [el('span.field-label', { text: 'Timezone' }), zoneSelect]));

        controls.append(el('label.field', {}, [
          el('span.field-label', { text: 'What to call it' }),
          el('input.input', {
            type: 'text', maxlength: 30, value: s.label,
            placeholder: s.zone ? 'e.g. Grandma in Tokyo' : 'e.g. Our classroom',
            oninput: (e) => { s.label = e.target.value; ctx.save(); paint(); },
          }),
        ]));

        const toggle = (label, key, after) => el('label.check-inline', {}, [
          el('input', {
            type: 'checkbox', checked: s[key],
            onchange: (e) => { s[key] = e.target.checked; ctx.save(); (after || build)(); },
          }),
          el('span', { text: label }),
        ]);
        controls.append(el('div.clock-toggles', {}, [
          toggle('Second hand', 'seconds'),
          s.face === 'analogue' ? toggle('Numbers', 'numerals') : toggle('12-hour', 'hour12'),
          toggle('Show the date', 'showDate', paint),
        ]));
      }

      build();
      drawControls();

      return {
        // Smooth on screen, and still right when the tab was hidden.
        frame: paint,
        tick: paint,
      };
    },
  });
}(window.Desk));
