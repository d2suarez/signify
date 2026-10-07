// ===================================================================
// Widget — Weather, and what recess is going to be like
//
// A forecast is only useful to a teacher at the moments they might take a
// class outside, so this is built around those moments rather than around the
// day. Add the times you go out; it tells you what it will be doing then.
//
// The verdicts are jokes with a fact attached. The joke is what gets read;
// the temperature and the chance of rain underneath it are what actually
// decide whether anyone needs a coat. They are rule-based rather than
// generated, so they cannot surprise anybody in front of a class.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, clockTime, minutesNow, toast, shuffle } = Desk;

  // WMO codes, grouped the way they matter for a playground.
  function condition(code) {
    if (code == null) return 'unknown';
    if (code === 0) return 'clear';
    if (code <= 3) return 'cloud';
    if (code <= 48) return 'fog';
    if (code <= 57) return 'drizzle';
    if (code <= 67) return 'rain';
    if (code <= 77) return 'snow';
    if (code <= 82) return 'showers';
    if (code <= 86) return 'snow';
    return 'storm';
  }

  const LOOK = {
    clear: { icon: '☀', word: 'Clear' },
    cloud: { icon: '☁', word: 'Cloudy' },
    fog: { icon: '≡', word: 'Fog' },
    drizzle: { icon: '☂', word: 'Drizzle' },
    rain: { icon: '☂', word: 'Rain' },
    showers: { icon: '☂', word: 'Showers' },
    snow: { icon: '❄', word: 'Snow' },
    storm: { icon: '⚡', word: 'Storm' },
    unknown: { icon: '?', word: '' },
  };

  /**
   * The verdict. Ordered worst-first, so the thing that would actually stop a
   * class going out wins over the thing that is merely inconvenient.
   *
   * `hot` and `cold` are in whatever units the teacher chose, so the
   * thresholds are computed rather than written down twice.
   */
  function verdict(w, imperial) {
    const C = (c) => (imperial ? c * 9 / 5 + 32 : c);
    const cond = condition(w.code);
    const wind = w.wind || 0;
    const windy = imperial ? wind > 24 : wind > 38;
    const gale = imperial ? wind > 38 : wind > 61;
    const rain = w.rain == null ? 0 : w.rain;
    const feels = w.feels == null ? w.temp : w.feels;

    if (cond === 'storm') return ['Indoors. Definitely indoors.', 'stop'];
    if (cond === 'snow') return ['Nobody is learning anything after this. Make your peace with it.', 'wow'];
    if (cond === 'rain' || rain >= 70) return ['Wet play. The playground is a puddle with ambitions.', 'stop'];
    if (gale) return ['Anything not held down is leaving. Including the small ones.', 'stop'];
    if (feels <= C(-5)) return ['Properly cold. Coats, hats, and a headcount on the way back in.', 'stop'];

    if (cond === 'showers' || rain >= 40) return ['Might get caught out. Coats on, and keep one eye on the sky.', 'warn'];
    if (feels >= C(32)) return ['Too hot to run about. Shade, water bottles, and no chasing games.', 'warn'];
    if (feels <= C(2)) return ['Cold enough for coats zipped up, and someone will still say they are not cold.', 'warn'];
    if (windy) return ['Blustery. Hold onto the hats and anything made of paper.', 'warn'];
    if (cond === 'fog') return ['Murky out there. Keep them where you can count them.', 'warn'];
    if (cond === 'drizzle') return ['That fine drizzle that soaks you without ever properly raining.', 'warn'];

    if (feels >= C(24) && cond === 'clear') return ['Glorious. Go now, before it changes its mind.', 'go'];
    if (cond === 'clear') return ['Bright and fine. No excuses.', 'go'];
    return ['Grey but perfectly fine. Out you go.', 'go'];
  }

  const MOOD_LABEL = { go: 'Good to go', warn: 'Take a coat', stop: 'Probably indoors', wow: 'Good luck' };

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAYS = [1, 2, 3, 4, 5];

  Desk.widget({
    type: 'weather',
    name: 'Weather & recess',
    blurb: 'What it is doing now, and what it will be doing at the times you take them outside.',
    icon: 'cloud',
    category: 'other',
    role: 'p3',
    guest: true,
    size: { w: 4, h: 5 },
    min: { w: 3, h: 4 },

    init(s) {
      if (!s.place || typeof s.place !== 'object') s.place = null;
      if (s.units !== 'imperial' && s.units !== 'metric') s.units = 'imperial';
      if (!Array.isArray(s.outings)) {
        s.outings = [{ id: 'o1', label: 'Recess', minutes: 10 * 60 + 30, days: WEEKDAYS.slice() }];
      }
      for (const o of s.outings) if (!Array.isArray(o.days)) o.days = WEEKDAYS.slice();
    },

    mount(ctx) {
      const s = ctx.state;
      let data = null;
      let loading = false;
      let failed = '';

      const root = el('div.weather');
      ctx.root.append(root);

      const imperial = () => s.units === 'imperial';
      const temp = (n) => (n == null ? '—' : `${Math.round(n)}°`);

      async function load() {
        if (!s.place) { draw(); return; }
        loading = true; failed = ''; draw();
        try {
          data = await Desk.api.weather(s.place.lat, s.place.lon, s.units);
        } catch (e) {
          failed = e.message || 'Could not get the forecast.';
        }
        loading = false;
        draw();
      }

      /** The forecast for a given local hour today, from the hourly series. */
      function atMinutes(minutes) {
        if (!data || !data.hourly.length) return null;
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
        const want = `${y}-${m}-${d}T${hh}:00`;
        return data.hourly.find((h) => h.t === want) || null;
      }

      // ---------------- drawing ----------------

      function draw() {
        Desk.clear(root);

        if (!s.place) { drawSetup(); return; }

        root.append(el('div.wx-head', {}, [
          el('span.wx-place', { text: s.place.name }),
          el('button.icon-btn', {
            svg: icon('settings', 15), title: 'Change the place and times',
            onclick: () => { s.place = ctx.expanded ? s.place : s.place; ctx.expanded ? drawSettings() : ctx.expand && ctx.expand(); },
          }),
        ]));

        if (loading && !data) { root.append(el('p.hint', { text: 'Looking outside…' })); return; }
        if (failed && !data) {
          root.append(el('p.hint', { text: failed }), el('button.btn.btn--small', { svg: icon('reset', 14), onclick: load }, ' Try again'));
          return;
        }
        if (!data) return;

        drawNow();
        drawOutings();
        if (ctx.expanded) drawSettings();
      }

      function drawNow() {
        const c = data.current || {};
        const look = LOOK[condition(c.weather_code)];
        root.append(el('div.wx-now', {}, [
          el('span.wx-icon', { text: look.icon }),
          el('div.wx-now-text', {}, [
            el('div.wx-temp', { text: temp(c.temperature_2m) }),
            el('div.hint', { text: `${look.word}${c.apparent_temperature != null ? ` · feels ${temp(c.apparent_temperature)}` : ''}` }),
          ]),
        ]));
      }

      function drawOutings() {
        const today = new Date().getDay();
        const now = minutesNow();
        const mine = s.outings
          .filter((o) => o.days.includes(today))
          .sort((a, b) => a.minutes - b.minutes);

        if (!mine.length) {
          root.append(el('p.hint', { text: 'Nothing outdoors scheduled today.' }));
          return;
        }

        const list = el('div.wx-outings');
        for (const o of mine) {
          const hour = atMinutes(o.minutes);
          const past = now > o.minutes + 45;
          if (!hour) {
            list.append(el('div.wx-outing', {}, [
              el('span.wx-when', { text: clockTime(o.minutes) }),
              el('span.wx-label', { text: o.label || 'Outside' }),
              el('span.hint', { text: 'No forecast for then' }),
            ]));
            continue;
          }
          const [line, mood] = verdict(hour, imperial());
          list.append(el(`div.wx-outing.wx-outing--${mood}`, { class: past ? 'is-past' : '' }, [
            el('div.wx-outing-head', {}, [
              el('span.wx-when', { text: clockTime(o.minutes) }),
              el('span.wx-label', { text: o.label || 'Outside' }),
              el('span.wx-badge', { text: MOOD_LABEL[mood] }),
            ]),
            el('div.wx-verdict', { text: line }),
            el('div.hint.wx-facts', {
              text: `${LOOK[condition(hour.code)].word} · ${temp(hour.temp)}`
                + (hour.feels != null ? ` (feels ${temp(hour.feels)})` : '')
                + ` · ${hour.rain == null ? 0 : hour.rain}% rain`
                + ` · wind ${Math.round(hour.wind)}${data.units.wind ? ` ${data.units.wind.replace('mp/h', 'mph')}` : ''}`,
            }),
          ]));
        }
        root.append(list);
      }

      // ---------------- setup and settings ----------------

      function drawSetup() {
        const input = el('input.input', { type: 'text', placeholder: 'Town, city or ZIP code', maxlength: 80 });
        const results = el('div.wx-results');

        const look = Desk.debounce(async () => {
          const q = input.value.trim();
          if (q.length < 2) { Desk.clear(results); return; }
          Desk.clear(results).append(el('p.hint', { text: 'Looking…' }));
          try {
            const { places } = await Desk.api.weatherSearch(q);
            Desk.clear(results);
            if (!places.length) { results.append(el('p.hint', { text: 'Nowhere by that name.' })); return; }
            for (const p of places) {
              results.append(el('button.btn.btn--small.btn--block', {
                onclick: () => { s.place = p; ctx.save(); load(); },
              }, `${p.name}${p.detail ? ` — ${p.detail}` : ''}`));
            }
          } catch { Desk.clear(results).append(el('p.hint', { text: 'Could not look that up.' })); }
        }, 400);

        input.addEventListener('input', look);

        root.append(el('div.wx-setup', {}, [
          el('p.hint', { text: 'Where is the school? A town, a city or a ZIP code. Only the place is stored, and only this server ever asks the weather service.' }),
          input,
          results,
        ]));
      }

      function drawSettings() {
        const box = el('div.wx-settings');

        box.append(el('h3.section-title', { text: 'Going outside' }));
        const list = el('div.alarm-list');
        for (const o of s.outings) {
          const head = el('div.alarm-head', {}, [
            el('input.alarm-time', {
              type: 'time',
              value: `${String(Math.floor(o.minutes / 60)).padStart(2, '0')}:${String(o.minutes % 60).padStart(2, '0')}`,
              // A time field fires change part-way through being typed — after
              // the hour, before the minutes — so the redraw must not take the
              // caret with it.
              onchange: (e) => {
                const [h, m] = e.target.value.split(':').map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) { o.minutes = h * 60 + m; ctx.save(); Desk.keepFocus(ctx.root, draw); }
              },
            }),
            el('input.alarm-label', {
              type: 'text', placeholder: 'What for?', value: o.label || '', maxlength: 24,
              oninput: (e) => { o.label = e.target.value; ctx.save(); },
            }),
            el('button.icon-btn.icon-btn--danger', {
              svg: icon('trash', 15), 'aria-label': 'Remove this',
              onclick: () => { s.outings = s.outings.filter((x) => x !== o); ctx.save(); draw(); },
            }),
          ]);
          const dayRow = el('div.alarm-days');
          DAYS.forEach((name, i) => dayRow.append(el('button.day', {
            text: name[0], title: name,
            class: o.days.includes(i) ? 'is-on' : '',
            onclick: () => {
              o.days = o.days.includes(i) ? o.days.filter((d) => d !== i) : [...o.days, i].sort();
              ctx.save(); Desk.keepFocus(ctx.root, draw);
            },
          })));
          list.append(el('div.alarm', {}, [head, dayRow]));
        }
        box.append(list);

        box.append(el('button.btn.btn--small.btn--block', {
          svg: icon('plus', 14),
          onclick: () => {
            s.outings.push({ id: `o${Date.now().toString(36)}`, label: '', minutes: 12 * 60, days: WEEKDAYS.slice() });
            ctx.save(); draw();
          },
        }, ' Add a time'));

        box.append(
          el('h3.section-title', { text: 'Units' }),
          el('div.seg', {}, [
            el('button.seg-btn', { text: '°F', class: imperial() ? 'is-on' : '', onclick: () => { s.units = 'imperial'; ctx.save(); load(); } }),
            el('button.seg-btn', { text: '°C', class: imperial() ? '' : 'is-on', onclick: () => { s.units = 'metric'; ctx.save(); load(); } }),
          ]),
          el('div.plan-row', {}, [
            el('span.hint', { text: s.place ? s.place.name : '' }),
            el('button.btn.btn--small', { onclick: () => { s.place = null; data = null; ctx.save(); draw(); } }, 'Change place'),
          ]),
        );
        root.append(box);
      }

      load();

      // The forecast moves slowly; asking every ten minutes is plenty, and the
      // server caches so a staffroom of desks is not thirty requests.
      let last = Date.now();
      return {
        tick() {
          if (Date.now() - last > 10 * 60 * 1000) { last = Date.now(); load(); }
        },
      };
    },
  });
}(window.Desk));
