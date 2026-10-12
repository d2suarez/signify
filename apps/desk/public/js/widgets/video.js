// ===================================================================
// Widget — YouTube video
//
// The clip that goes with the lesson, ready on the board instead of being
// hunted for in a browser tab with the class watching.
//
// Two deliberate choices, both about what a class ends up looking at:
//
//   * The embed is youtube-nocookie.com, and it is not put on the page until
//     the teacher presses play. Until then YouTube is not contacted at all,
//     so a desk left open on the projector is not quietly reporting a
//     classroom's browsing to anyone.
//   * `rel=0`, which keeps the end-of-video suggestions to the same channel.
//     It no longer removes them altogether — YouTube stopped allowing that —
//     and the card says so, because a teacher planning to walk away from the
//     board deserves to know that.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  // Eleven characters of YouTube's own alphabet, and nothing else goes into
  // the URL. Whatever the teacher pastes, only an id ever reaches the embed.
  const ID = /^[A-Za-z0-9_-]{11}$/;

  /**
   * The video id in whatever a teacher pasted: a watch link, a share link, an
   * embed, a Short, or the bare id itself.
   */
  function videoId(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    if (ID.test(raw)) return raw;

    let u;
    try { u = new URL(raw.includes('://') ? raw : `https://${raw}`); }
    catch { return ''; }

    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return ID.test(id) ? id : '';
    }
    if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtube-nocookie.com') return '';

    const v = u.searchParams.get('v');
    if (v && ID.test(v)) return v;

    const parts = u.pathname.split('/').filter(Boolean);
    if (['embed', 'shorts', 'v', 'live'].includes(parts[0]) && ID.test(parts[1] || '')) return parts[1];
    return '';
  }

  /** The start time in a pasted link, in whole seconds, or 0. */
  function startAt(input) {
    const raw = String(input || '').trim();
    let u;
    try { u = new URL(raw.includes('://') ? raw : `https://${raw}`); }
    catch { return 0; }
    const t = u.searchParams.get('t') || u.searchParams.get('start') || '';
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
    if (!m || !(m[1] || m[2] || m[3])) return 0;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  const mmss = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  Desk.widget({
    type: 'video',
    name: 'YouTube video',
    blurb: 'The clip that goes with the lesson, on the board — nothing loads until you press play.',
    icon: 'video',
    category: 'board',
    guest: true,
    fills: true,
    size: { w: 5, h: 4 },
    min: { w: 3, h: 3 },

    // Pure, and the part where a mistake would put an arbitrary URL in an
    // iframe on this origin — so both are exported and tested directly.
    _videoId: videoId,
    _startAt: startAt,

    init(s) {
      if (typeof s.id !== 'string' || !ID.test(s.id)) s.id = '';
      // Two names, on purpose: `title` is what YouTube calls it, `label` is
      // what the teacher decided to call it instead. Keeping them apart means
      // a re-fetch never overwrites somebody's own wording, and clearing the
      // box falls back to YouTube's rather than to nothing.
      if (typeof s.title !== 'string') s.title = '';
      if (typeof s.label !== 'string') s.label = '';
      if (typeof s.start !== 'number' || !Number.isFinite(s.start) || s.start < 0) s.start = 0;
      s.start = Math.floor(s.start);
      delete s.url;                        // only ever a way in, never stored
    },

    holdsContent: (s) => (s.id ? 'The video goes with it.' : ''),

    mount(ctx) {
      const s = ctx.state;
      // Playing is where the teacher is, not part of the board: a desk opened
      // on another machine should not start a video by itself.
      let playing = false;
      let looking = false;                 // a title lookup is in flight

      const shownName = () => s.label || s.title;

      /**
       * Asks the server what YouTube calls this video.
       *
       * Failure is silent by design: no title is the state the card was built
       * to cope with, and a video that plays perfectly well should not carry
       * an error message because oEmbed was unreachable for a moment.
       */
      async function fetchTitle(id) {
        if (!id) return;
        looking = true;
        drawStage();
        try {
          const found = await Desk.api.videoTitle(id);
          if (s.id !== id) return;         // they pasted another one meanwhile
          s.title = (found && found.title) || '';
          ctx.save();
        } catch { /* the card works without it */ }
        finally {
          looking = false;
          drawStage();
          drawSettings();
        }
      }

      const stage = el('div.vid-stage');
      const settings = el('div.vid-settings');
      ctx.root.append(el('div.video', {}, [stage, settings]));

      function embedUrl() {
        const p = new URLSearchParams();
        p.set('rel', '0');                 // suggestions stay on the same channel
        p.set('modestbranding', '1');
        p.set('playsinline', '1');
        p.set('autoplay', '1');            // only ever built after a real click
        if (s.start > 0) p.set('start', String(s.start));
        return `https://www.youtube-nocookie.com/embed/${s.id}?${p}`;
      }

      function drawStage() {
        Desk.clear(stage);

        if (!s.id) {
          Desk.append(stage,
            el('p.hint', { text: 'Paste a YouTube link, and it waits here until you press play.' }),
            ctx.expanded ? null : el('button.btn.btn--small', {
              svg: icon('settings', 13),
              onclick: () => ctx.expand && ctx.expand(),
            }, ' Choose a video'),
          );
          return;
        }

        if (!playing) {
          const name = shownName();
          Desk.append(stage,
            el('button.vid-poster', {
              'aria-label': `Play ${name || 'the video'}`,
              onclick: () => { playing = true; drawStage(); },
            }, [
              el('span.vid-play', { svg: icon('play', 30) }),
              el('span.vid-title', { text: name || (looking ? 'Getting the title\u2026' : 'Ready to play') }),
              s.start > 0 ? el('span.vid-from', { text: `Starts at ${mmss(s.start)}` }) : null,
            ].filter(Boolean)),
            el('p.hint', { text: 'Nothing has been sent to YouTube yet.' }),
          );
          return;
        }

        stage.append(el('iframe.vid-frame', {
          src: embedUrl(),
          title: shownName() || 'YouTube video',
          allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
          allowfullscreen: 'true',
          referrerpolicy: 'strict-origin',
        }));
        stage.append(el('div.starter-row', {}, [
          el('button.btn.btn--small', {
            svg: icon('reset', 14),
            onclick: () => { playing = false; drawStage(); },
          }, ' Stop and clear'),
          el('button.btn.btn--small', {
            svg: icon('external', 14),
            onclick: () => window.open(`https://www.youtube.com/watch?v=${s.id}`, '_blank', 'noopener,noreferrer'),
          }, ' Open on YouTube'),
        ]));
      }

      function drawSettings() {
        Desk.clear(settings);
        if (!ctx.expanded && s.id) return;

        const paste = el('input.input', {
          type: 'text', maxlength: 300, value: s.id ? `https://youtu.be/${s.id}` : '',
          placeholder: 'https://www.youtube.com/watch?v=…',
          // On leaving the field rather than on every keystroke: a link is
          // pasted whole, and re-parsing mid-type would fight the teacher.
          onchange: (e) => {
            const text = e.target.value;
            const id = videoId(text);
            if (!id) {
              if (text.trim()) toast('That did not look like a YouTube link.', 'warn');
              return;
            }
            const at = startAt(text);
            const changed = id !== s.id;
            s.id = id;
            if (changed) {
              // A different video: its name is not the old one's, and neither
              // is the point three minutes in that the last clip started at.
              s.title = '';
              s.start = at || 0;
            } else if (at) {
              s.start = at;
            }
            playing = false;
            ctx.save();
            Desk.keepFocus(ctx.root, () => { drawStage(); drawSettings(); });
            if (changed) fetchTitle(id);
          },
        });

        settings.append(el('label.field', {}, [
          el('span.field-label', { text: 'The link' }),
          paste,
        ]));

        if (!ctx.expanded) return;

        // Desk.append, not the DOM's: one of these children is null when
        // there is no video yet, and node.append() renders that as the word
        // "null" on the card.
        Desk.append(settings,
          el('label.field', {}, [
            el('span.field-label', { text: 'Call it something else' }),
            el('input.input', {
              type: 'text', value: s.label, maxlength: 80,
              // Empty means "whatever YouTube calls it", and the placeholder
              // says so by being that title, so nobody has to guess what
              // clearing the box will do.
              placeholder: s.title || (looking ? 'Getting the title\u2026' : 'e.g. How volcanoes form'),
              // Only the poster. Rebuilding these settings would destroy this
              // very input and drop the caret after every keystroke.
              oninput: (e) => { s.label = e.target.value; ctx.save(); if (!playing) drawStage(); },
            }),
          ]),
          el('label.field', {}, [
            el('span.field-label', { text: 'Start at (m:ss)' }),
            el('input.input', {
              type: 'text', value: s.start ? mmss(s.start) : '', maxlength: 8, placeholder: '0:00',
              onchange: (e) => {
                // parseDuration answers in milliseconds, and reads "230" the
                // way the timer field does — two minutes thirty.
                const ms = Desk.parseDuration(e.target.value);
                s.start = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
                ctx.save();
                Desk.keepFocus(ctx.root, () => { drawStage(); drawSettings(); });
              },
            }),
          ]),
          s.id ? el('div.starter-row', {}, [
            el('button.btn.btn--small', {
              svg: icon('close', 14),
              onclick: () => { s.id = ''; s.title = ''; s.start = 0; playing = false; ctx.save(); drawStage(); drawSettings(); },
            }, ' Take it off the card'),
          ]) : null,
          el('p.hint', {
            text: 'Played through youtube-nocookie.com, and only once you press play. YouTube still shows suggestions when a video ends — they are kept to the same channel, but they are not gone, so it is worth stopping the clip yourself.',
          }),
        );
      }

      drawStage();
      drawSettings();
      // A card made before titles were fetched, or one whose lookup failed
      // last time, quietly picks one up now.
      if (s.id && !s.title) fetchTitle(s.id);

      return {};
    },
  });
}(window.Desk));
