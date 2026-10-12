// ===================================================================
// Teacher's Desk — sound
//
// Synthesised rather than sampled: no audio files to ship, no request to
// another host, and nothing to go missing. Browsers refuse to make noise
// until the page has been clicked, so the context is created on the first
// gesture and reused.
// ===================================================================

window.Desk = window.Desk || {};

(function (Desk) {
  'use strict';

  let ctx = null;
  let unlocked = false;

  function context() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    context();
  }
  ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, unlock, { once: true, passive: true }));

  function tone(freq, startAt, length, gain = 0.22, type = 'sine') {
    const c = context();
    if (!c) return;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startAt);
    // A hard edge on a square-ish tone clicks through classroom speakers, so
    // every note gets a short ramp in and a longer one out.
    amp.gain.setValueAtTime(0.0001, startAt);
    amp.gain.exponentialRampToValueAtTime(gain, startAt + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, startAt + length);
    osc.connect(amp).connect(c.destination);
    osc.start(startAt);
    osc.stop(startAt + length + 0.05);
  }

  // Each sound is a short melody: [semitone offset, start beat, length].
  const VOICES = {
    chime:  { root: 587.33, notes: [[0, 0, 0.5], [7, 0.16, 0.6]], repeat: 1 },
    bell:   { root: 880.00, notes: [[0, 0, 0.7], [0, 0.28, 0.7], [0, 0.56, 1.1]], repeat: 1 },
    rise:   { root: 440.00, notes: [[0, 0, 0.3], [4, 0.12, 0.3], [7, 0.24, 0.3], [12, 0.36, 0.6]], repeat: 1 },
    alert:  { root: 659.25, notes: [[0, 0, 0.18], [0, 0.26, 0.18], [0, 0.52, 0.18]], repeat: 2 },
    tick:   { root: 1046.5, notes: [[0, 0, 0.06]], repeat: 1, gain: 0.1 },
    quiet:  { root: 392.00, notes: [[0, 0, 0.9], [-5, 0.5, 1.2]], repeat: 1, gain: 0.16 },
  };

  const NAMES = { chime: 'Chime', bell: 'Bell', rise: 'Rising', alert: 'Alert', quiet: 'Soft', none: 'Silent' };

  // ---------- muting ----------
  //
  // One switch over every sound in the app: a test is on, or the class next
  // door can hear you, and hunting through six widgets turning each one off
  // is not something anybody does mid-lesson.
  //
  // Kept per device rather than on the teacher's board, because that is what
  // it actually means — the laptop on the desk and the machine driving the
  // projector have different speakers in different rooms, and muting one
  // should not silence the other. It survives a reload; it does not follow
  // the teacher to another computer.

  const STORE_KEY = 'desk.muted';
  const watchers = new Set();
  let muted = false;

  try { muted = window.localStorage.getItem(STORE_KEY) === '1'; }
  catch { /* private windows and blocked site data both land here */ }

  const isMuted = () => muted;

  function setMuted(value) {
    const next = !!value;
    if (next === muted) return muted;
    muted = next;
    try { window.localStorage.setItem(STORE_KEY, muted ? '1' : '0'); } catch { /* not worth failing over */ }
    for (const fn of watchers) { try { fn(muted); } catch (e) { console.error(e); } }
    return muted;
  }

  const onChange = (fn) => { watchers.add(fn); return () => watchers.delete(fn); };

  function play(name, { repeat } = {}) {
    if (muted) return;
    if (!name || name === 'none') return;
    const voice = VOICES[name] || VOICES.chime;
    const c = context();
    if (!c) return;
    const rounds = Math.min(6, repeat || voice.repeat || 1);
    const span = Math.max(...voice.notes.map((n) => n[1] + n[2])) + 0.25;
    for (let r = 0; r < rounds; r += 1) {
      for (const [semis, beat, len] of voice.notes) {
        tone(voice.root * Math.pow(2, semis / 12), c.currentTime + r * span + beat, len, voice.gain || 0.22);
      }
    }
  }

  /**
   * Plays a sound the teacher asked to hear — the preview when they pick one
   * from a menu. Muted, it says so instead of doing nothing, because silence
   * in answer to "what does this sound like?" reads as a broken app.
   */
  function preview(name) {
    if (muted) { Desk.toast('Sounds are muted. Turn them back on in the top bar to hear this.', 'warn'); return; }
    play(name);
  }

  Desk.sound = { play, preview, unlock, isMuted, setMuted, onChange, NAMES, options: Object.keys(NAMES) };
}(window.Desk));
