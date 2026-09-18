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

  Desk.widget({
    type: 'noise',
    name: 'Noise meter',
    blurb: 'How loud the room is, as a bar they can watch. Nothing is ever recorded.',
    icon: 'sound',
    category: 'calm',
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
