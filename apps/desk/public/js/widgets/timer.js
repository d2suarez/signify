// ===================================================================
// Widget — Timer
//
// One countdown per card, so "five more minutes" and "back from break at
// 11:05" can sit side by side. It keeps an end *timestamp* rather than a
// number it decrements, which is what makes it survive a refresh, a laptop
// lid, and the tab being in the background for the whole of break.
//
// Past zero it keeps counting, in red. A timer that vanishes at 00:00 loses
// the one number a teacher wants at that moment: how far over they are.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, duration, clamp } = Desk;

  const DEFAULT_PRESETS = [60_000, 120_000, 300_000, 600_000, 900_000];

  function label(ms) {
    const m = ms / 60_000;
    return m >= 1 ? `${Number.isInteger(m) ? m : m.toFixed(1)} min` : `${Math.round(ms / 1000)} sec`;
  }

  function remaining(s) {
    if (s.running) return s.endsAt - Date.now();
    return s.remainingMs;
  }

  Desk.widget({
    type: 'timer',
    name: 'Timer',
    blurb: 'Count down to zero, with a sound at the end. Keeps counting past zero so you can see how far over you are.',
    icon: 'timer',
    category: 'time',
    guest: true,
    tone: 'block',
    size: { w: 4, h: 5 },
    min: { w: 3, h: 4 },

    init(s) {
      if (!Array.isArray(s.presets) || !s.presets.length) s.presets = DEFAULT_PRESETS.slice();
      if (typeof s.durationMs !== 'number') s.durationMs = 300_000;
      if (typeof s.remainingMs !== 'number') s.remainingMs = s.durationMs;
      if (typeof s.running !== 'boolean') s.running = false;
      if (typeof s.endsAt !== 'number') s.endsAt = 0;
      if (!s.sound) s.sound = 'chime';
      if (typeof s.title !== 'string') s.title = '';
      if (typeof s.fired !== 'boolean') s.fired = false;
    },

    holdsContent: (s) => (s.running ? 'It is running now.' : ''),

    // In the island a timer is worth reading only while it is actually
    // running — a stopped one is noise at the top of the board.
    readout(s) {
      if (!s.running) return null;
      const left = remaining(s);
      return {
        value: duration(Math.abs(left)),
        caption: s.title || (left < 0 ? 'Over' : 'Left'),
        progress: s.durationMs > 0 ? clamp(left / s.durationMs, 0, 1) : 0,
      };
    },

    mount(ctx) {
      const s = ctx.state;

      // Tapping the digits types a time straight in. Presets cover the four
      // lengths a teacher uses every day; this covers the fifth one they need
      // right now, without hunting for a "+3 min" button that does not exist.
      const digits = el('button.timer-digits', {
        type: 'button',
        title: 'Type a time',
        'aria-label': 'Time remaining. Activate to type a different time.',
      });
      const timeInput = el('input.timer-input', {
        type: 'text', hidden: true, inputmode: 'text', spellcheck: 'false',
        'aria-label': 'Type a time, such as 7 or 1:30',
      });
      const overtimeNote = el('div.timer-over', { text: 'over time' });
      const ring = el('div.timer-ring', {
        svg: '<svg viewBox="0 0 120 120" aria-hidden="true">'
          + '<circle class="ring-track" cx="60" cy="60" r="54"/>'
          + '<circle class="ring-value" cx="60" cy="60" r="54"/></svg>',
      });
      const ringValue = ring.querySelector('.ring-value');
      const CIRC = 2 * Math.PI * 54;
      ringValue.style.strokeDasharray = `${CIRC}`;

      const titleInput = el('input.timer-title', {
        type: 'text', placeholder: 'What is this timer for?', value: s.title, maxlength: 40,
        oninput: () => { s.title = titleInput.value; ctx.save(); },
      });

      const playBtn = el('button.btn.btn--primary.btn--wide', { onclick: toggle });
      const resetBtn = el('button.btn', { svg: icon('reset', 16), title: 'Back to the start', onclick: reset });

      const presetRow = el('div.chips');
      function drawPresets() {
        Desk.clear(presetRow);
        for (const ms of s.presets) {
          presetRow.append(el('button.chip', {
            text: label(ms),
            class: (!s.running && s.remainingMs === ms) ? 'is-on' : '',
            onclick: () => setDuration(ms),
          }));
        }
        if (ctx.expanded) presetRow.append(el('button.chip.chip--ghost', { svg: icon('plus', 14), title: 'Add a preset', onclick: addPreset }));
      }

      const adjust = el('div.timer-adjust', {}, [
        el('button.btn.btn--small', { text: '−1 min', onclick: () => nudge(-60_000) }),
        el('button.btn.btn--small', { text: '+1 min', onclick: () => nudge(60_000) }),
        el('button.btn.btn--small', { text: '+5 min', onclick: () => nudge(300_000) }),
      ]);

      // The ring is right on a card. Filling a projector it is not — the
      // digits have to be enormous, and a circle around them either swamps
      // them or hides behind them. Presenting swaps it for a bar.
      const bar = el('div.timer-bar', {}, el('div.timer-bar-fill'));
      const barFill = bar.firstChild;

      ctx.root.append(el('div.timer', {}, [
        ctx.expanded ? titleInput : (s.title ? el('div.timer-label', { text: s.title }) : null),
        el('div.timer-face', {}, [ring, el('div.timer-readout', {}, [digits, timeInput, overtimeNote])]),
        bar,
        el('div.timer-controls', {}, [playBtn, resetBtn]),
        presetRow,
        adjust,
        ctx.expanded ? soundRow() : null,
        ctx.expanded ? el('p.hint', { text: 'The timer keeps its place if you reload, close the laptop, or move to another tab.' }) : null,
      ]));

      function soundRow() {
        const select = el('select.select', { onchange: () => { s.sound = select.value; ctx.save(); Desk.sound.preview(s.sound); } });
        for (const key of Desk.sound.options) {
          select.append(el('option', { value: key, text: Desk.sound.NAMES[key], selected: s.sound === key }));
        }
        return el('label.field.field--row', {}, [
          el('span.field-label', { svg: icon('sound', 16) }, ' Sound at zero'),
          select,
        ]);
      }

      // ---------- actions ----------

      function setDuration(ms) {
        s.durationMs = ms;
        s.remainingMs = ms;
        s.running = false;
        s.endsAt = 0;
        s.fired = false;
        ctx.save(); paint(); drawPresets();
      }

      function nudge(ms) {
        Desk.sound.unlock();
        if (s.running) s.endsAt = Math.max(Date.now(), s.endsAt + ms);
        else s.remainingMs = Math.max(0, s.remainingMs + ms);
        if (remaining(s) > 0) s.fired = false;
        // Adding time to a finished timer should make it the new length, so
        // "reset" afterwards means the length the class actually got.
        s.durationMs = Math.max(s.durationMs, remaining(s));
        ctx.save(); paint(); drawPresets();
      }

      // ---------- typing a time ----------

      let editing = false;

      function beginEdit() {
        if (editing) return;
        editing = true;
        // Pre-filled with what is on the clock now, so "make it a bit longer"
        // is an edit rather than a re-type.
        timeInput.value = duration(Math.max(0, remaining(s)));
        digits.hidden = true;
        timeInput.hidden = false;
        timeInput.focus();
        timeInput.select();
      }

      function endEdit(commit) {
        if (!editing) return;
        const typed = timeInput.value;
        editing = false;
        timeInput.hidden = true;
        digits.hidden = false;

        if (!commit) { paint(); return; }

        const ms = Desk.parseDuration(typed);
        if (ms == null) {
          // Say what was wrong rather than silently keeping the old time —
          // otherwise a mistyped timer looks like one that simply ignored you.
          Desk.toast(`“${typed.trim()}” is not a length of time. Try 7, 1:30 or 45s.`, 'warn');
          paint();
          return;
        }
        setDuration(ms);
      }

      // The colon appears as they type: 2, 3, 0 reads back "2:30" without
      // anybody reaching for the punctuation. Only while the caret is at the
      // end and the field is still digits — someone who types "45s" or goes
      // back to fix a character mid-string is left alone.
      timeInput.addEventListener('input', () => {
        if (timeInput.selectionStart !== timeInput.value.length) return;
        if (!/^[\d:]*$/.test(timeInput.value)) return;
        const next = Desk.groupDigits(timeInput.value);
        if (next === timeInput.value) return;
        timeInput.value = next;
        timeInput.setSelectionRange(next.length, next.length);
      });

      digits.addEventListener('click', beginEdit);
      timeInput.addEventListener('blur', () => endEdit(true));
      timeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
      });

      function toggle() {
        Desk.sound.unlock();
        if (s.running) {
          s.remainingMs = s.endsAt - Date.now();
          s.running = false;
        } else {
          if (s.remainingMs <= 0) { s.remainingMs = s.durationMs; s.fired = false; }
          s.endsAt = Date.now() + s.remainingMs;
          s.running = true;
        }
        ctx.save(); paint();
      }

      function reset() {
        s.running = false;
        s.endsAt = 0;
        s.remainingMs = s.durationMs;
        s.fired = false;
        ctx.save(); paint(); drawPresets();
      }

      async function addPreset() {
        const input = el('input.input', { type: 'text', placeholder: 'e.g. 7 or 1:30', maxlength: 8 });
        const yes = await Desk.ask({ title: 'Add a preset', body: input, confirmLabel: 'Add' });
        if (!yes) return;
        const parts = input.value.split(':').map((p) => Number(p.trim()));
        if (parts.some((n) => !Number.isFinite(n))) { Desk.toast('That is not a length of time.', 'warn'); return; }
        const ms = parts.length > 1 ? (parts[0] * 60 + parts[1]) * 1000 : parts[0] * 60_000;
        if (!(ms > 0) || ms > 6 * 3600_000) { Desk.toast('Pick something between a second and six hours.', 'warn'); return; }
        s.presets = [...new Set([...s.presets, ms])].sort((a, b) => a - b).slice(0, 10);
        ctx.save(); drawPresets();
      }

      // ---------- painting ----------

      let lastText = '';
      function paint() {
        // While somebody is typing, the clock keeps running underneath but
        // must not rewrite what is under their cursor.
        if (editing) return;
        const left = remaining(s);
        const over = left <= 0;
        // A plus sign, because "0:01" past the end and "0:01" left look
        // identical at the back of the room otherwise.
        const text = (over ? '+' : '') + duration(over ? -left : left);
        if (text !== lastText) { digits.textContent = text; lastText = text; }
        Desk.fitText(digits, digits.closest('.timer-face'));

        digits.classList.toggle('is-over', over);
        overtimeNote.hidden = !over || (!s.running && s.remainingMs > 0);
        const fraction = clamp(over ? 0 : left / Math.max(1, s.durationMs), 0, 1);
        const low = !over && left < Math.min(60_000, s.durationMs * 0.1);

        ringValue.style.strokeDashoffset = String(CIRC * (1 - fraction));
        ringValue.classList.toggle('is-over', over);
        ringValue.classList.toggle('is-low', low);

        // On the card the time that has gone is a shadow creeping in from the
        // right, over the whole block — readable from the back of the room
        // without reading a number at all. It is set on the CARD rather than
        // on the body inside it: custom properties inherit downwards, and the
        // shadow is drawn by the card so that it covers the padding too.
        (ctx.root.closest('.card') || ctx.root).style.setProperty('--elapsed', String(1 - fraction));
        barFill.style.width = `${fraction * 100}%`;
        barFill.classList.toggle('is-over', over);
        barFill.classList.toggle('is-low', low);

        Desk.clear(playBtn).append(
          el('span', { svg: icon(s.running ? 'pause' : 'play', 16) }),
          document.createTextNode(s.running ? ' Pause' : (left <= 0 ? ' Start again' : ' Start')),
        );
        playBtn.classList.toggle('btn--danger', s.running);
      }

      drawPresets();
      paint();

      return {
        frame: paint,
        tick() {
          // Ringing lives here, not in frame(), so a backgrounded tab still
          // rings — that is the whole point of setting a timer.
          if (s.running && !s.fired && Date.now() >= s.endsAt) {
            s.fired = true;
            Desk.sound.play(s.sound, { repeat: 2 });
            ctx.save();
            if (navigator.vibrate) navigator.vibrate([180, 90, 180]);
          }
          paint();
        },
      };
    },
  });
}(window.Desk));
