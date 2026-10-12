// ===================================================================
// Widget — Google Slides
//
// The deck for the lesson, on the board, without leaving the desk to find a
// browser tab with the class watching.
//
// Google's own embed, so there is no OAuth and no token this app ever holds.
// The same catch as the calendar applies and is said out loud on the card:
// the embed reads Google's cookies from inside an iframe on another site, so
// a deck that is not shared will show "you need permission" rather than
// slides. The fix for that is in Google, not here.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  // A deck is identified either by its file id, or — when it has been
  // published to the web — by a much longer id that lives after /d/e/. They
  // embed at different paths, so which one it is has to be remembered.
  const FILE_ID = /^[A-Za-z0-9_-]{10,120}$/;

  /** `{ id, published }` for whatever was pasted, or null. */
  function deckFrom(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    // A bare id, which is what somebody copies out of the middle of a URL.
    if (FILE_ID.test(raw) && !raw.includes('/')) return { id: raw, published: false };

    let u;
    try { u = new URL(raw.includes('://') ? raw : `https://${raw}`); }
    catch { return null; }
    if (u.hostname.replace(/^www\./, '') !== 'docs.google.com') return null;

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'presentation') return { id: '', wrongKind: parts[0] || '' };

    // /presentation/d/e/<published id>/pub  — published to the web
    if (parts[1] === 'd' && parts[2] === 'e' && FILE_ID.test(parts[3] || '')) {
      return { id: parts[3], published: true };
    }
    // /presentation/d/<file id>/edit
    if (parts[1] === 'd' && FILE_ID.test(parts[2] || '')) {
      return { id: parts[2], published: false };
    }
    return null;
  }

  const KINDS = { document: 'a Google Doc', spreadsheets: 'a Google Sheet', forms: 'a Google Form', file: 'a Drive file' };

  Desk.widget({
    type: 'slides',
    name: 'Google Slides',
    blurb: 'The deck for the lesson, on the board — paste the link and it is there.',
    icon: 'slides',
    category: 'board',
    guest: true,
    fills: true,
    size: { w: 6, h: 5 },
    min: { w: 3, h: 3 },

    init(s) {
      if (typeof s.id !== 'string') s.id = '';
      if (typeof s.published !== 'boolean') s.published = false;
      if (typeof s.label !== 'string') s.label = '';
      if (typeof s.slide !== 'number' || !Number.isFinite(s.slide) || s.slide < 1) s.slide = 1;
      if (typeof s.loop !== 'boolean') s.loop = false;
    },

    holdsContent: (s) => (s.id ? 'The deck goes with it.' : ''),

    mount(ctx) {
      const s = ctx.state;
      const stage = el('div.slides-stage');
      const settings = el('div.slides-settings');
      ctx.root.append(el('div.slides', {}, [stage, settings]));

      function embedUrl() {
        const base = s.published
          ? `https://docs.google.com/presentation/d/e/${s.id}/embed`
          : `https://docs.google.com/presentation/d/${s.id}/embed`;
        const p = new URLSearchParams();
        p.set('start', 'false');           // never auto-advance in front of a class
        p.set('loop', s.loop ? 'true' : 'false');
        p.set('delayms', '60000');
        // Slide numbers are 1-based for a teacher and 0-based for Google.
        if (s.slide > 1) p.set('slide', String(s.slide - 1));
        p.set('rm', 'minimal');
        return `${base}?${p}`;
      }

      function drawStage() {
        Desk.clear(stage);

        if (!s.id) {
          Desk.append(stage,
            el('p.hint', { text: 'Paste the link to a Google Slides deck.' }),
            ctx.expanded ? null : el('button.btn.btn--small', {
              svg: icon('settings', 13),
              onclick: () => ctx.expand && ctx.expand(),
            }, ' Choose a deck'),
          );
          return;
        }

        stage.append(el('iframe.slides-frame', {
          src: embedUrl(),
          title: s.label || 'Google Slides',
          loading: 'lazy',
          allowfullscreen: 'true',
          referrerpolicy: 'strict-origin',
        }));

        if (s.label) stage.append(el('div.slides-caption', { text: s.label }));
      }

      function drawSettings() {
        Desk.clear(settings);
        if (!ctx.expanded && s.id) return;

        settings.append(el('label.field', {}, [
          el('span.field-label', { text: 'The link' }),
          el('input.input', {
            type: 'text', maxlength: 400,
            value: s.id ? (s.published
              ? `https://docs.google.com/presentation/d/e/${s.id}/pub`
              : `https://docs.google.com/presentation/d/${s.id}/edit`) : '',
            placeholder: 'https://docs.google.com/presentation/d/…',
            // On leaving the field: a link is pasted whole, and re-parsing on
            // every keystroke would fight the teacher mid-paste.
            onchange: (e) => {
              const text = e.target.value;
              const deck = deckFrom(text);
              if (deck && deck.wrongKind) {
                toast(`That is ${KINDS[deck.wrongKind] || 'not a slide deck'}, not a Slides deck.`, 'warn');
                return;
              }
              if (!deck || !deck.id) {
                if (text.trim()) toast('That did not look like a Google Slides link.', 'warn');
                return;
              }
              const changed = deck.id !== s.id;
              s.id = deck.id;
              s.published = deck.published;
              if (changed) s.slide = 1;    // a different deck starts at its own beginning
              ctx.save();
              Desk.keepFocus(ctx.root, () => { drawStage(); drawSettings(); });
            },
          }),
        ]));

        if (!ctx.expanded) return;

        Desk.append(settings,
          el('label.field', {}, [
            el('span.field-label', { text: 'What to call it' }),
            el('input.input', {
              type: 'text', value: s.label, maxlength: 80, placeholder: 'e.g. Monday’s starter',
              // Only the caption. Rebuilding the settings would destroy this
              // very input and drop the caret after every keystroke.
              oninput: (e) => { s.label = e.target.value; ctx.save(); drawStage(); },
            }),
          ]),
          el('div.plan-row', {}, [
            el('span.hint', { text: 'Open at slide' }),
            el('div.stepper', {}, [
              el('button.icon-btn', {
                svg: icon('minus', 15), 'aria-label': 'Earlier slide',
                onclick: () => { s.slide = Math.max(1, s.slide - 1); ctx.save(); drawStage(); drawSettings(); },
              }),
              el('span.stepper-value', { text: String(s.slide) }),
              el('button.icon-btn', {
                svg: icon('plus', 15), 'aria-label': 'Later slide',
                onclick: () => { s.slide = Math.min(200, s.slide + 1); ctx.save(); drawStage(); drawSettings(); },
              }),
            ]),
          ]),
          s.id ? el('div.starter-row', {}, [
            el('button.btn.btn--small', {
              svg: icon('external', 14),
              onclick: () => window.open(
                s.published
                  ? `https://docs.google.com/presentation/d/e/${s.id}/pub`
                  : `https://docs.google.com/presentation/d/${s.id}/edit`,
                '_blank', 'noopener,noreferrer'),
            }, ' Open in Google Slides'),
            el('button.btn.btn--small', {
              svg: icon('close', 14),
              onclick: () => { s.id = ''; s.slide = 1; ctx.save(); drawStage(); drawSettings(); },
            }, ' Take it off the card'),
          ]) : null,
          el('p.hint', {
            text: 'Shows the deck to whichever Google account this browser is signed into. If it says you need permission, share the deck — “Anyone with the link · Viewer” — or publish it to the web from File → Share.',
          }),
        );
      }

      drawStage();
      drawSettings();
      return {};
    },

    // Pure, and the part where a mistake would put an arbitrary URL in an
    // iframe on this origin — so it is exported and tested directly.
    _deckFrom: deckFrom,
  });
}(window.Desk));
