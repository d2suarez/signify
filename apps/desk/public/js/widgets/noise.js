// ===================================================================
// Widget — Noise meter
//
// How loud the room is, as a bar the class can watch. The single most-asked-
// for thing on any classroom tool board, and the one with the sharpest edges,
// because it needs the microphone in a room full of children.
//
// So, plainly:
//
//   * NOTHING IS RECORDED. The audio never leaves the AudioContext. There is
//     no MediaRecorder here, no buffer kept, no upload path. The only thing
//     that survives a frame is a single number: how loud it was.
//   * The microphone is off until the teacher turns it on, every session. No
//     auto-start on load, because a tool that silently opens a mic in a
//     classroom is not one anybody should trust.
//   * Turning it off releases the track, so the browser's recording indicator
//     goes out. Half-off is worse than useless — people need to see it stop.
//
// The level is a loudness-ish curve rather than raw RMS, because raw RMS
// barely moves between "working quietly" and "far too loud".
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, clamp, toast } = Desk;

  const LEVELS = [
    { key: 'silent', label: 'Silent', upto: 12 },
    { key: 'whisper', label: 'Whispers', upto: 30 },
    { key: 'work', label: 'Working voices', upto: 55 },
    { key: 'loud', label: 'Getting loud', upto: 78 },
    { key: 'over', label: 'Too loud', upto: 101 },
  ];
  const levelFor = (v) => LEVELS.find((l) => v < l.upto) || LEVELS[LEVELS.length - 1];

  /* ---------------- the colour of the room ----------------
     Green while it is quiet, yellow as it gets louder, red once it is past the
     line the teacher set — the whole card, readable from the back of the room
     without reading a word. The three are the app's own green, yellow and
     red, fixed rather than taken from the palette: a traffic light that turns
     purple under "Berry" has stopped being a traffic light.

     It fades rather than stepping, blended in OKLCH: lightness, colourfulness
     and hue each travel on their own. Blended as plain RGB — or even as
     straight-line OKLab — green into yellow passes through a dull olive,
     because the straight line between two hues cuts through grey. Turning
     the hue instead keeps the middle as vivid as the ends: green, a fresh
     yellow-green, yellow, orange, red. */
  const QUIET = '#1b7f4b';
  const RISING = '#f5c400';
  const LOUD = '#ec3013';

  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function hexToOklab(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q,
    ];
  }

  function oklabToRgb([L, A, B]) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const q = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * q,
    ].map((c) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, c))))) * 255));
  }

  const toLch = ([L, A, B]) => [L, Math.hypot(A, B), Math.atan2(B, A)];
  const fromLch = ([L, C, h]) => [L, C * Math.cos(h), C * Math.sin(h)];
  const STOPS = [QUIET, RISING, LOUD].map((hex) => toLch(hexToOklab(hex)));

  /** Along the shorter way round the colour wheel. */
  function mixLch(a, b, k) {
    let dh = b[2] - a[2];
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + dh * k];
  }

  /**
   * The card's colour and the ink that reads on it, for a level and the
   * teacher's line. Green up to a third of the way to the line, fading to
   * yellow by three-quarters of the way, and to red as the line is reached.
   */
  function noiseColour(level, limit) {
    const t = clamp(level / Math.max(1, limit), 0, 1.2);
    let from = STOPS[0]; let to = STOPS[0]; let k = 0;
    if (t <= 0.35) { from = to = STOPS[0]; }
    else if (t < 0.75) { from = STOPS[0]; to = STOPS[1]; k = (t - 0.35) / 0.4; }
    else if (t < 1) { from = STOPS[1]; to = STOPS[2]; k = (t - 0.75) / 0.25; }
    else { from = to = STOPS[2]; }
    const [r, g, b] = oklabToRgb(fromLch(mixLch(from, to, k)));
    const lum = 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);
    const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    return { background: hex, ink: lum > 0.35 ? '#201e1d' : '#ffffff' };
  }

  Desk.widget({
    type: 'noise',
    name: 'Noise meter',
    blurb: 'How loud the room is, as a bar they can watch. Nothing is ever recorded.',
    _noiseColour: noiseColour,
    icon: 'sound',
    category: 'calm',
    guest: true,
    tone: 'block',
    role: 'p3',
    fills: true,
    size: { w: 4, h: 4 },
    min: { w: 2, h: 3 },

    init(s) {
      if (typeof s.limit !== 'number') s.limit = 55;
      if (typeof s.sensitivity !== 'number') s.sensitivity = 1;
      if (typeof s.alert !== 'boolean') s.alert = false;
    },

    mount(ctx) {
      const s = ctx.state;

      let stream = null;
      let audio = null;
      let analyser = null;
      let buffer = null;
      let level = 0;            // smoothed 0..100
      let peak = 0;
      let overSince = 0;

      const bar = el('div.noise-fill');
      const marker = el('div.noise-limit');
      const track = el('div.noise-track', {}, [bar, marker]);
      const word = el('div.noise-word');
      const hint = el('p.hint.noise-hint');
      const button = el('button.btn.btn--primary.btn--wide');
      const settings = el('div.noise-settings');
      // Kept outside the redraw so their text can be updated in place.
      const limitLabel = el('span.field-label');
      const sensLabel = el('span.field-label');

      ctx.root.append(el('div.noise', {}, [word, track, button, hint, settings]));

      // ---------- the microphone ----------

      async function listen() {
        if (stream) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          toast('This browser will not give a page the microphone.', 'warn');
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              // Anything that "helps" a voice call hurts a level meter: they
              // all fight exactly the loudness we are trying to show.
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
        } catch (e) {
          const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
          toast(denied
            ? 'The microphone was blocked. Allow it in the address bar to use this.'
            : 'No microphone was available.', 'warn');
          return;
        }

        const Ctx = window.AudioContext || window.webkitAudioContext;
        audio = new Ctx();
        if (audio.state === 'suspended') await audio.resume().catch(() => {});
        analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.6;
        buffer = new Float32Array(analyser.fftSize);
        // The source is connected to the analyser and NOWHERE ELSE. Nothing
        // reaches the speakers, and nothing reaches a recorder.
        audio.createMediaStreamSource(stream).connect(analyser);
        paintChrome();
      }

      function stop() {
        if (stream) for (const t of stream.getTracks()) t.stop();
        stream = null;
        if (audio) audio.close().catch(() => {});
        audio = null;
        analyser = null;
        buffer = null;
        level = 0;
        peak = 0;
        paint();
        paintChrome();
      }

      // ---------- reading it ----------

      function sample() {
        if (!analyser) return;
        analyser.getFloatTimeDomainData(buffer);

        let sum = 0;
        for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
        const rms = Math.sqrt(sum / buffer.length);

        // RMS is tiny and bunched up at the quiet end, so it goes through a
        // decibel curve before it becomes a percentage anybody can read.
        const db = 20 * Math.log10(rms || 1e-7);
        const raw = clamp(((db + 60) / 55) * 100 * s.sensitivity, 0, 100);

        // Rises quickly so a shout registers, falls slowly so the bar is not
        // a strobe light at the front of the room.
        level += (raw - level) * (raw > level ? 0.45 : 0.08);
        peak = Math.max(peak * 0.995, level);
      }

      let lastWord = '';
      function paint() {
        const v = Math.round(level);
        const l = levelFor(v);
        bar.style.height = `${v}%`;
        bar.className = `noise-fill noise-fill--${l.key}`;
        marker.style.bottom = `${clamp(s.limit, 0, 100)}%`;

        if (l.label !== lastWord) { word.textContent = stream ? l.label : ''; lastWord = l.label; }
        track.classList.toggle('is-over', stream && v > s.limit);

        // The whole tool turns the colour of the room while it is listening,
        // and goes back to its own colour when the microphone is off.
        const holder = ctx.root.closest('.card, .stage');
        if (holder) {
          if (stream) {
            const c = noiseColour(level, s.limit);
            holder.style.setProperty('--role', c.background);
            holder.style.setProperty('--role-ink', c.ink);
            holder.classList.add('is-listening');
          } else if (holder.classList.contains('is-listening')) {
            holder.style.removeProperty('--role');
            holder.style.removeProperty('--role-ink');
            holder.classList.remove('is-listening');
          }
        }
      }

      function paintChrome() {
        Desk.clear(button).append(
          el('span', { svg: icon(stream ? 'muted' : 'sound', 16) }),
          document.createTextNode(stream ? ' Turn the microphone off' : ' Turn the microphone on'),
        );
        button.classList.toggle('btn--danger', !!stream);
        hint.textContent = stream
          ? 'Listening. Nothing is recorded or sent anywhere — only how loud it is, on this screen.'
          : 'The microphone is off. It only listens while you say so, and nothing is ever recorded.';

        Desk.clear(settings);
        if (!ctx.expanded) return;
        limitLabel.textContent = `Where the line sits — ${s.limit}`;
        sensLabel.textContent = `How sensitive — ${s.sensitivity.toFixed(1)}×`;
        settings.append(
          // Dragging a slider must not rebuild the slider. Only its own label
          // is rewritten, so the thumb stays under the finger.
          limitLabel,
          el('input.range', {
            type: 'range', min: 10, max: 95, value: s.limit,
            oninput: (e) => {
              s.limit = Number(e.target.value);
              ctx.save();
              limitLabel.textContent = `Where the line sits — ${s.limit}`;
              paint();
            },
          }),
          sensLabel,
          el('input.range', {
            type: 'range', min: 5, max: 20, value: Math.round(s.sensitivity * 10),
            oninput: (e) => {
              s.sensitivity = Number(e.target.value) / 10;
              ctx.save();
              sensLabel.textContent = `How sensitive — ${s.sensitivity.toFixed(1)}×`;
            },
          }),
          el('label.check-inline', {}, [
            el('input', {
              type: 'checkbox', checked: s.alert,
              onchange: (e) => { s.alert = e.target.checked; ctx.save(); },
            }),
            el('span', { text: 'Chime when it stays over the line' }),
          ]),
        );
      }

      button.addEventListener('click', () => { if (stream) stop(); else listen(); });

      paint();
      paintChrome();

      return {
        frame() {
          if (!analyser) return;
          sample();
          paint();
        },
        tick() {
          if (!analyser || !s.alert) { overSince = 0; return; }
          // Only a sustained overshoot, so one dropped pencil lid does not
          // set a chime off in the middle of a lesson.
          if (level > s.limit) {
            if (!overSince) overSince = Date.now();
            else if (Date.now() - overSince > 4000) { overSince = 0; Desk.sound.play('quiet'); }
          } else overSince = 0;
        },
        destroy: stop,
      };
    },
  });
}(window.Desk));
