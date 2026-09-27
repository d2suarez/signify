// ===================================================================
// Widget — Music
//
// Tidy-up music, a playlist for silent reading, the song for the dance in
// assembly. Paste a link from Spotify, Apple Music, SoundCloud or YouTube and
// it is on the board.
//
// Each service's own embed, so there is no OAuth, no API key and no token
// this app holds. Two consequences, both said on the card rather than left to
// be discovered in front of a class:
//
//   * Nothing is sent anywhere until Play is pressed. A desk sitting open on
//     a projector all afternoon has told Spotify nothing.
//   * How much you get depends on being signed in to that service IN THIS
//     BROWSER. Signed in, Spotify and Apple Music play in full; signed out,
//     they play a preview. That is the service's rule, not this app's.
//
// Whatever is pasted is parsed down to a service, a kind and an id, and the
// embed URL is built from those. No pasted string is ever put in the iframe.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  const SPOTIFY_KINDS = ['track', 'album', 'playlist', 'artist', 'episode', 'show'];
  const APPLE_KINDS = ['album', 'playlist', 'song', 'music-video'];
  const ID = /^[A-Za-z0-9._-]{4,80}$/;
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  const YT_LIST = /^[A-Za-z0-9_-]{12,64}$/;

  const SERVICES = {
    spotify: { label: 'Spotify', tall: 352 },
    apple: { label: 'Apple Music', tall: 450 },
    soundcloud: { label: 'SoundCloud', tall: 166 },
    youtube: { label: 'YouTube', tall: 0 },        // 0 = fill the card
  };

  /**
   * What was pasted, as `{ service, kind, id, extra }` — or null.
   *
   * Every branch validates the HOST first and the id shape second, so the
   * only thing that reaches an embed URL is a known service and a string of
   * safe characters.
   */
  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    // Spotify's own URI form, which is what its desktop app copies.
    const uri = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(raw);
    if (uri && SPOTIFY_KINDS.includes(uri[1])) return { service: 'spotify', kind: uri[1], id: uri[2] };

    let u;
    try { u = new URL(raw.includes('://') ? raw : `https://${raw}`); }
    catch { return null; }
    const host = u.hostname.replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);

    if (host === 'open.spotify.com') {
      // /intl-de/playlist/xxxx — a locale can sit in front of the kind.
      const at = SPOTIFY_KINDS.includes(parts[0]) ? 0 : 1;
      const kind = parts[at];
      const id = parts[at + 1];
      if (SPOTIFY_KINDS.includes(kind) && ID.test(id || '')) return { service: 'spotify', kind, id };
      return null;
    }

    if (host === 'music.apple.com' || host === 'embed.music.apple.com') {
      // /us/playlist/slug/pl.u-xxxx
      const country = /^[a-z]{2}$/i.test(parts[0] || '') ? parts[0].toLowerCase() : '';
      const rest = country ? parts.slice(1) : parts;
      const [kind, slug, id] = rest;
      if (!APPLE_KINDS.includes(kind) || !ID.test(id || '')) return null;
      return { service: 'apple', kind, id, extra: { country: country || 'us', slug: slug || 'a' } };
    }

    if (host === 'soundcloud.com' || host === 'm.soundcloud.com') {
      // SoundCloud's player resolves a permalink, so the path is what matters
      // — but it is rebuilt here from validated segments rather than passed
      // through, so nothing else can ride along in a query string.
      const clean = parts.filter((p) => /^[A-Za-z0-9._-]{1,80}$/.test(p));
      if (clean.length !== parts.length || clean.length < 1 || clean.length > 3) return null;
      return { service: 'soundcloud', kind: 'permalink', id: clean.join('/') };
    }

    if (host === 'music.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
      const list = u.searchParams.get('list');
      if (list && YT_LIST.test(list)) return { service: 'youtube', kind: 'playlist', id: list };
      const v = host === 'youtu.be' ? parts[0] : u.searchParams.get('v');
      if (v && YT_ID.test(v)) return { service: 'youtube', kind: 'video', id: v };
      if (parts[0] === 'playlist') return null;
      return null;
    }

    return null;
  }

  /** The embed URL for a parsed link. Built from parts, never from the paste. */
  function embedUrl(found) {
    if (!found) return '';
    const { service, kind, id, extra } = found;

    if (service === 'spotify') return `https://open.spotify.com/embed/${kind}/${encodeURIComponent(id)}`;
    if (service === 'apple') {
      const c = encodeURIComponent(extra.country);
      const slug = encodeURIComponent(extra.slug);
      return `https://embed.music.apple.com/${c}/${kind}/${slug}/${encodeURIComponent(id)}`;
    }
    if (service === 'soundcloud') {
      const permalink = `https://soundcloud.com/${id}`;
      const p = new URLSearchParams({
        url: permalink,
        auto_play: 'false',
        show_comments: 'false',
        show_teaser: 'false',
        visual: 'false',
      });
      return `https://w.soundcloud.com/player/?${p}`;
    }
    if (service === 'youtube') {
      const p = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1', autoplay: '1' });
      if (kind === 'playlist') {
        p.set('list', id);
        return `https://www.youtube-nocookie.com/embed/videoseries?${p}`;
      }
      return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${p}`;
    }
    return '';
  }

  Desk.widget({
    type: 'music',
    name: 'Music',
    blurb: 'Tidy-up music or a playlist for reading — Spotify, Apple Music, SoundCloud or YouTube.',
    icon: 'speaker',
    category: 'calm',
    guest: true,
    fills: true,
    size: { w: 4, h: 3 },
    min: { w: 3, h: 2 },

    init(s) {
      if (typeof s.service !== 'string' || !SERVICES[s.service]) s.service = '';
      if (typeof s.kind !== 'string') s.kind = '';
      if (typeof s.id !== 'string') s.id = '';
      if (!s.extra || typeof s.extra !== 'object') s.extra = {};
      if (typeof s.label !== 'string') s.label = '';
    },

    holdsContent: (s) => (s.id ? 'The playlist goes with it.' : ''),

    mount(ctx) {
      const s = ctx.state;
      // Playing is where the teacher is, not part of the board: a desk opened
      // on another machine must not start playing music by itself.
      let playing = false;

      const stage = el('div.music-stage');
      const settings = el('div.music-settings');
      ctx.root.append(el('div.music', {}, [stage, settings]));

      const found = () => (s.id ? { service: s.service, kind: s.kind, id: s.id, extra: s.extra } : null);
      const serviceName = () => (SERVICES[s.service] || {}).label || '';

      function drawStage() {
        Desk.clear(stage);

        if (!s.id) {
          Desk.append(stage,
            el('p.hint', { text: 'Paste a link from Spotify, Apple Music, SoundCloud or YouTube.' }),
            ctx.expanded ? null : el('button.btn.btn--small', {
              svg: icon('settings', 13),
              onclick: () => ctx.expand && ctx.expand(),
            }, ' Choose something'),
          );
          return;
        }

        if (!playing) {
          Desk.append(stage,
            el('button.music-poster', {
              'aria-label': `Play ${s.label || serviceName()}`,
              onclick: () => { playing = true; drawStage(); },
            }, [
              el('span.music-play', { svg: icon('play', 26) }),
              el('span.music-title', { text: s.label || serviceName() }),
              el('span.music-where', { text: serviceName() }),
            ]),
            el('p.hint', { text: `Nothing has been sent to ${serviceName()} yet.` }),
          );
          return;
        }

        const tall = (SERVICES[s.service] || {}).tall;
        stage.append(el('iframe.music-frame', {
          src: embedUrl(found()),
          title: s.label || `${serviceName()} player`,
          allow: 'autoplay; encrypted-media; clipboard-write; picture-in-picture',
          loading: 'lazy',
          referrerpolicy: 'strict-origin',
          class: tall ? '' : 'is-fill',
          style: tall ? { height: `${tall}px` } : {},
        }));
        stage.append(el('div.starter-row.no-print', {}, [
          el('button.btn.btn--small', {
            svg: icon('reset', 14),
            onclick: () => { playing = false; drawStage(); },
          }, ' Stop and clear'),
        ]));
      }

      function drawSettings() {
        Desk.clear(settings);
        if (!ctx.expanded && s.id) return;

        settings.append(el('label.field', {}, [
          el('span.field-label', { text: 'The link' }),
          el('input.input', {
            type: 'text', maxlength: 400,
            value: s.id ? originalUrl() : '',
            placeholder: 'https://open.spotify.com/playlist/…',
            // On leaving the field: a link is pasted whole, and re-parsing on
            // every keystroke would fight the teacher mid-paste.
            onchange: (e) => {
              const text = e.target.value;
              const got = parse(text);
              if (!got) {
                if (text.trim()) toast('That did not look like a Spotify, Apple Music, SoundCloud or YouTube link.', 'warn');
                return;
              }
              s.service = got.service;
              s.kind = got.kind;
              s.id = got.id;
              s.extra = got.extra || {};
              playing = false;
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
              type: 'text', value: s.label, maxlength: 80, placeholder: 'e.g. Tidy-up music',
              // Only the poster. Rebuilding the settings would destroy this
              // very input and drop the caret after every keystroke.
              oninput: (e) => { s.label = e.target.value; ctx.save(); if (!playing) drawStage(); },
            }),
          ]),
          s.id ? el('div.starter-row', {}, [
            el('button.btn.btn--small', {
              svg: icon('close', 14),
              onclick: () => { s.id = ''; s.service = ''; s.kind = ''; s.extra = {}; playing = false; ctx.save(); drawStage(); drawSettings(); },
            }, ' Take it off the card'),
          ]) : null,
          el('p.hint', {
            text: 'How much plays depends on being signed in to that service in this browser: signed in, Spotify and Apple Music play in full; signed out, they play a short preview. SoundCloud and YouTube play whatever is public.',
          }),
          el('p.hint', {
            text: 'Worth a thought before assembly: playing commercial music to a room is a public performance, and schools usually cover that through a licence. Royalty-free or a school-licensed source avoids the question entirely.',
          }),
        );
      }

      /** The link as the teacher would recognise it, for the box. */
      function originalUrl() {
        if (s.service === 'spotify') return `https://open.spotify.com/${s.kind}/${s.id}`;
        if (s.service === 'apple') return `https://music.apple.com/${s.extra.country || 'us'}/${s.kind}/${s.extra.slug || 'a'}/${s.id}`;
        if (s.service === 'soundcloud') return `https://soundcloud.com/${s.id}`;
        if (s.service === 'youtube') {
          return s.kind === 'playlist'
            ? `https://music.youtube.com/playlist?list=${s.id}`
            : `https://music.youtube.com/watch?v=${s.id}`;
        }
        return '';
      }

      drawStage();
      drawSettings();
      return {};
    },

    // Pure, and the part where a mistake would put an arbitrary URL in an
    // iframe on this origin — so both are exported and tested directly.
    _parse: parse,
    _embedUrl: embedUrl,
  });
}(window.Desk));
