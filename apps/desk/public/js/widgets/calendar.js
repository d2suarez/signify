// ===================================================================
// Widget — Google Calendar
//
// Google's own embed, which shows the calendar of whoever is signed in to
// Google in this browser. No OAuth, no scopes, no token this app ever holds
// — which is exactly why it was chosen over asking for calendar.readonly.
//
// The catch, stated plainly because it will bite eventually: the embed reads
// Google's cookies from inside an iframe on another site. Browsers are in the
// middle of removing third-party cookies, and when that finishes here the
// embed will show "not available" rather than the calendar. Nothing in this
// app can fix that; it would need a real OAuth flow. The widget says so
// itself rather than looking broken.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon } = Desk;

  const VIEWS = [
    { key: 'AGENDA', label: 'Agenda' },
    { key: 'DAY', label: 'Day' },
    { key: 'WEEK', label: 'Week' },
    { key: 'MONTH', label: 'Month' },
  ];

  const MODES = [
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' },
  ];

  // Google's embed takes a colour per calendar, given as its own parameter
  // straight after that calendar's src. A fixed palette rather than a free
  // picker: these are the ones that stay legible against the embed's white
  // background and apart from each other on a projector.
  const COLOURS = [
    '#1D4ED8', '#0F766E', '#B45309', '#BE185D',
    '#6D28D9', '#15803D', '#B91C1C', '#475569',
  ];

  Desk.widget({
    type: 'calendar',
    name: 'Google Calendar',
    blurb: 'Your own Google calendar, embedded. No sign-in beyond the one your browser already has.',
    icon: 'calendar',
    size: { w: 5, h: 5 },
    min: { w: 3, h: 4 },

    init(s) {
      if (!Array.isArray(s.sources)) s.sources = [];
      // Boards made before this widget took more than one calendar.
      if (typeof s.src === 'string' && s.src && !s.sources.length) {
        s.sources = [{ id: s.src, colour: COLOURS[0] }];
      }
      delete s.src;
      if (!VIEWS.some((v) => v.key === s.view)) s.view = 'AGENDA';
      if (typeof s.showList !== 'boolean') s.showList = true;
      if (typeof s.mode !== 'string') s.mode = 'light';
    },

    mount(ctx) {
      const s = ctx.state;
      const root = el('div.calendar');
      ctx.root.append(root);

      // Nothing configured yet: start them on the account they are signed into
      // this desk with, which is almost always the one they want.
      const calendars = () => (s.sources.length
        ? s.sources
        : [{ id: ((ctx.me && ctx.me.email) || '').trim(), colour: COLOURS[0] }]
      ).filter((c) => c.id);

      /**
       * The embed URL.
       *
       * Order matters: Google pairs each `color` with the `src` immediately
       * before it, so they have to be appended alternately rather than
       * grouped. URLSearchParams keeps insertion order, which is what makes
       * this work at all.
       */
      function url() {
        const p = new URLSearchParams();
        for (const cal of calendars()) {
          p.append('src', cal.id);
          if (cal.colour) p.append('color', cal.colour);
        }
        p.append('mode', s.view);
        p.append('showTitle', '0');
        p.append('showNav', '1');
        p.append('showPrint', '0');
        p.append('showTabs', '0');
        // The list down the side is how somebody ticks a calendar off for a
        // moment without deleting it here.
        p.append('showCalendars', s.showList && calendars().length > 1 ? '1' : '0');
        p.append('showTz', '0');
        p.append('wkst', '1');
        p.append('bgcolor', '#ffffff');
        return `https://calendar.google.com/calendar/embed?${p}`;
      }

      function draw() {
        Desk.clear(root);

        if (!calendars().length) {
          root.append(el('p.hint', { text: 'Which calendars? Add the address of each one you want to see.' }));
          drawSettings();
          return;
        }

        root.append(el('iframe.cal-frame', {
          src: url(),
          title: 'Google Calendar',
          loading: 'lazy',
          class: s.mode === 'dark' ? 'is-dark' : '',
        }));

        root.append(el('p.hint.cal-note', {
          text: 'Shows the calendar of whichever Google account this browser is signed into. If it says it is unavailable, sign in to Google in this browser — or your browser may be blocking third-party cookies, which this embed needs.',
        }));

        if (ctx.expanded) drawSettings();
        else {
          root.append(el('button.btn.btn--small', {
            svg: icon('settings', 13),
            onclick: () => ctx.expand && ctx.expand(),
          }, ' Choose calendars'));
        }
      }

      function drawSettings() {
        const box = el('div.cal-settings');
        root.append(box);

        box.append(el('h3.section-title', { text: 'Calendars' }));

        const rows = el('div.cal-rows');
        s.sources.forEach((cal, i) => {
          const swatches = el('div.swatches.swatches--tiny');
          for (const c of COLOURS) {
            swatches.append(el('button.swatch', {
              'data-c': c, title: c, style: { background: c },
              class: cal.colour === c ? 'is-on' : '',
              onclick: (e) => {
                e.preventDefault();
                cal.colour = c;
                ctx.save();
                for (const b of swatches.children) b.classList.toggle('is-on', b.dataset.c === c);
                draw();
              },
            }));
          }

          rows.append(el('div.cal-row', {}, [
            el('input.input', {
              type: 'text', value: cal.id, maxlength: 160,
              placeholder: 'name@group.calendar.google.com',
              oninput: (e) => { cal.id = e.target.value.trim(); ctx.save(); },
              // Only once they leave the field, and the caret is put back.
              onchange: () => Desk.keepFocus(ctx.root, draw),
            }),
            swatches,
            el('button.icon-btn.icon-btn--danger', {
              svg: icon('trash', 14), 'aria-label': `Remove calendar ${i + 1}`,
              onclick: () => { s.sources.splice(i, 1); ctx.save(); draw(); },
            }),
          ]));
        });
        box.append(rows);

        box.append(el('div.starter-row', {}, [
          el('button.btn.btn--small', {
            svg: icon('plus', 14),
            onclick: () => {
              if (s.sources.length >= 10) return;
              // First one added defaults to their own address, since that is
              // what was showing before they started adding others.
              const first = !s.sources.length;
              s.sources.push({
                id: first ? ((ctx.me && ctx.me.email) || '') : '',
                colour: COLOURS[s.sources.length % COLOURS.length],
              });
              ctx.save(); draw();
            },
          }, ' Add a calendar'),
        ]));

        box.append(el('p.hint', {
          text: 'A calendar\u2019s address is in Google Calendar under Settings \u2192 that calendar \u2192 Integrate calendar \u2192 Calendar ID. Your own is just your email address; a school or shared one usually ends in @group.calendar.google.com.',
        }));
        box.append(el('p.hint', {
          text: 'Only calendars the signed-in Google account can already see will appear. Adding one here does not grant access to it.',
        }));

        box.append(
          el('div.plan-row', {}, [
            el('span.hint', { text: 'View' }),
            el('div.seg.seg--tiny', {}, VIEWS.map((v) => el('button.seg-btn', {
              text: v.label,
              class: s.view === v.key ? 'is-on' : '',
              onclick: () => { s.view = v.key; ctx.save(); draw(); },
            }))),
          ]),
          el('div.plan-row', {}, [
            el('span.hint', { text: 'Look' }),
            el('div.seg.seg--tiny', {}, MODES.map((m) => el('button.seg-btn', {
              text: m.label,
              class: s.mode === m.key ? 'is-on' : '',
              onclick: () => { s.mode = m.key; ctx.save(); draw(); },
            }))),
          ]),
        );

        if (s.sources.length > 1) {
          box.append(el('label.check-inline', {}, [
            el('input', {
              type: 'checkbox', checked: s.showList,
              onchange: (e) => { s.showList = e.target.checked; ctx.save(); Desk.keepFocus(ctx.root, draw); },
            }),
            el('span', { text: 'Show the list, so they can be ticked on and off' }),
          ]));
        }
      }

      draw();
      return {};
    },
  });
}(window.Desk));
