// ===================================================================
// Widget — Soundboard
//
// Pads a teacher taps: a chime for attention, a fanfare for a right answer,
// a sad little sax for a wrong one.
//
// Two decisions worth knowing:
//
//   * The bundled library is all CC0 from a single author (Kenney), because
//     provenance matters more than variety in a school. See public/sfx/
//     LICENCE.txt for why one source rather than a scrape of "free" sites.
//   * The teacher LABELS their own pads. The pack's jingles have no inherent
//     meaning — the same four notes are "well done" in one room and "time's
//     up" in another — so the app does not pretend to know which is which.
//
// Uploads are how anything missing gets in. They stay private to whoever
// uploaded them.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  // The bundled pack. `label` describes the SOUND, never an occasion.
  const LIBRARY = [
    { group: 'Signals', sounds: [
      { id: 'ui-chime', label: 'Chime' },
      { id: 'ui-bong', label: 'Bong' },
      { id: 'ui-ting', label: 'Ting' },
      { id: 'ui-confirm', label: 'Confirm' },
      { id: 'ui-question', label: 'Question' },
      { id: 'ui-pluck', label: 'Pluck' },
      { id: 'ui-click', label: 'Click' },
    ] },
    { group: 'Rude noises', sounds: [
      { id: 'ui-error', label: 'Error' },
      { id: 'ui-buzz', label: 'Buzz' },
      { id: 'ui-glitch', label: 'Glitch' },
      { id: 'ui-scratch', label: 'Record scratch' },
      { id: 'ui-drop', label: 'Drop' },
      { id: 'ui-swoosh-up', label: 'Swoosh up' },
      { id: 'ui-swoosh-down', label: 'Swoosh down' },
    ] },
    { group: 'Little tunes — brass', sounds: [1, 2, 3, 4, 5].map((n) => ({ id: `jingle-sax-${n}`, label: `Sax ${n}` })) },
    { group: 'Little tunes — 8-bit', sounds: [1, 2, 3, 4, 5].map((n) => ({ id: `jingle-8bit-${n}`, label: `8-bit ${n}` })) },
    { group: 'Little tunes — strings', sounds: [1, 2, 3, 4, 5].map((n) => ({ id: `jingle-pizzicato-${n}`, label: `Pizzicato ${n}` })) },
    { group: 'Little tunes — tuned percussion', sounds: [1, 2, 3, 4, 5].map((n) => ({ id: `jingle-steel-${n}`, label: `Steel ${n}` })) },
    { group: 'Little tunes — hits', sounds: [1, 2, 3, 4, 5].map((n) => ({ id: `jingle-hit-${n}`, label: `Hit ${n}` })) },
  ];

  const BUNDLED = new Map(LIBRARY.flatMap((g) => g.sounds).map((s) => [s.id, s]));

  const COLOURS = ['accent', 'green', 'red', 'yellow'];
  const srcFor = (pad) => (pad.upload ? `/api/assets/${encodeURIComponent(pad.sound)}` : `/sfx/${encodeURIComponent(pad.sound)}.m4a`);

  const STARTER = [
    { sound: 'ui-chime', label: 'Listen', colour: 'accent' },
    { sound: 'jingle-steel-2', label: 'Well done', colour: 'green' },
    { sound: 'ui-buzz', label: 'Not quite', colour: 'red' },
    { sound: 'ui-scratch', label: 'Stop', colour: 'yellow' },
  ];

  Desk.widget({
    type: 'soundboard',
    name: 'Soundboard',
    blurb: 'Pads you tap for a chime, a fanfare or a rude noise. Comes with a CC0 pack, and you can add your own.',
    icon: 'speaker',
    category: 'calm',
    size: { w: 4, h: 4 },
    min: { w: 2, h: 3 },

    init(s) {
      if (!Array.isArray(s.pads)) s.pads = STARTER.map((p) => ({ id: `p${Math.random().toString(36).slice(2, 8)}`, ...p }));
    },

    holdsContent: (s) => (s.pads.length ? `${s.pads.length} pad${s.pads.length === 1 ? '' : 's'} go with it.` : ''),

    mount(ctx) {
      const s = ctx.state;
      const grid = el('div.pads');
      const foot = el('div.pad-foot');

      // One element, reused. A soundboard that leaks an <audio> per press
      // ends up with fifty of them by lunchtime.
      const player = new Audio();
      player.preload = 'auto';

      ctx.root.append(el('div.soundboard', {}, [grid, foot]));

      function play(pad) {
        Desk.sound.unlock();
        if (Desk.sound.isMuted()) {
          toast('Sounds are muted. Turn them back on in the top bar.', 'warn');
          return;
        }
        player.pause();
        player.currentTime = 0;
        player.src = srcFor(pad);
        player.play().catch((e) => {
          // An upload the teacher has since deleted, or a codec the browser
          // will not take. Say which, rather than failing silently.
          toast(pad.upload ? 'That sound is no longer here.' : `That sound would not play (${e.name}).`, 'warn');
        });
      }

      function draw() {
        Desk.clear(grid);
        for (const pad of s.pads) {
          const node = el(`button.pad.pad--${pad.colour || 'accent'}`, {
            title: ctx.expanded ? 'Tap to play, or use the pencil to change it' : 'Tap to play',
            onclick: () => play(pad),
          }, [
            el('span.pad-label', { text: pad.label || BUNDLED.get(pad.sound)?.label || 'Sound' }),
          ]);

          if (ctx.expanded) {
            node.append(el('span.pad-edit', {
              svg: icon('settings', 13), title: 'Change this pad',
              onclick: (e) => { e.stopPropagation(); editPad(pad); },
            }));
          }
          grid.append(node);
        }

        if (ctx.expanded) {
          grid.append(el('button.pad.pad--add', { onclick: () => editPad(null) }, [
            el('span', { svg: icon('plus', 18) }),
            el('span.pad-label', { text: 'Add a pad' }),
          ]));
        }

        Desk.clear(foot);
        if (!ctx.expanded) {
          foot.append(el('button.btn.btn--small', { svg: icon('expand', 14), onclick: () => ctx.expand && ctx.expand() }, ' Change the pads'));
        }
      }

      // ---------------- editing a pad ----------------

      async function editPad(existing) {
        const draft = existing
          ? { ...existing }
          : { id: `p${Math.random().toString(36).slice(2, 8)}`, sound: 'ui-chime', label: '', colour: 'accent', upload: false };

        const labelInput = el('input.input', {
          type: 'text', maxlength: 24, value: draft.label,
          placeholder: 'What is this pad for?',
        });

        const chosen = el('div.hint');
        const paintChosen = () => {
          const name = draft.upload ? (uploads.find((u) => u.id === draft.sound) || {}).label : (BUNDLED.get(draft.sound) || {}).label;
          chosen.textContent = name ? `Playing: ${name}` : 'Pick a sound below';
        };

        let uploads = [];
        try { uploads = (await Desk.api.assets('audio')).assets || []; } catch { uploads = []; }

        const list = el('div.sound-list');
        function drawList() {
          Desk.clear(list);

          if (uploads.length) {
            list.append(el('h3.section-title', { text: 'Yours' }));
            const row = el('div.sound-row');
            for (const u of uploads) {
              row.append(soundChip({ id: u.id, label: u.label }, true));
            }
            list.append(row);
          }

          for (const g of LIBRARY) {
            list.append(el('h3.section-title', { text: g.group }));
            const row = el('div.sound-row');
            for (const snd of g.sounds) row.append(soundChip(snd, false));
            list.append(row);
          }
        }

        function soundChip(snd, isUpload) {
          const on = draft.sound === snd.id && !!draft.upload === isUpload;
          const chip = el('button.chip.sound-chip', {
            class: on ? 'is-on' : '',
            onclick: () => {
              draft.sound = snd.id;
              draft.upload = isUpload;
              paintChosen();
              drawList();
              play(draft);              // audition on pick — that is the point
            },
          }, [el('span', { text: snd.label })]);

          if (isUpload) {
            chip.append(el('span.sound-x', {
              svg: icon('close', 11), title: `Delete ${snd.label}`,
              onclick: async (e) => {
                e.stopPropagation();
                if (!await Desk.ask({
                  title: `Delete “${snd.label}”?`,
                  body: 'Any pad using it will stop working. This cannot be undone.',
                  confirmLabel: 'Delete', danger: true,
                })) return;
                await Desk.api.deleteAsset(snd.id);
                uploads = uploads.filter((u) => u.id !== snd.id);
                drawList();
              },
            }));
          }
          return chip;
        }

        const colours = el('div.swatches', {}, COLOURS.map((c) => el('button.swatch', {
          'data-pad-colour': c, title: c,
          class: draft.colour === c ? 'is-on' : '',
          onclick: (e) => {
            e.preventDefault();
            draft.colour = c;
            for (const b of colours.children) b.classList.toggle('is-on', b.dataset.padColour === c);
          },
        })));

        const uploadBtn = el('button.btn.btn--small', {
          svg: icon('upload', 14),
          onclick: async (e) => {
            e.preventDefault();
            const file = await Desk.pickFile('audio/*');
            if (!file) return;
            try {
              const saved = await Desk.api.uploadAsset(file);
              if (saved.kind !== 'audio') { toast('That was not a sound.', 'warn'); return; }
              uploads = [saved, ...uploads];
              draft.sound = saved.id;
              draft.upload = true;
              if (!draft.label) labelInput.value = saved.label;
              paintChosen();
              drawList();
            } catch (err) { toast(err.message, 'warn'); }
          },
        }, ' Upload a sound');

        paintChosen();
        drawList();

        const keep = await Desk.ask({
          title: existing ? 'Change this pad' : 'Add a pad',
          confirmLabel: existing ? 'Save' : 'Add',
          body: el('div.pad-editor', {}, [
            el('label.field', {}, [el('span.field-label', { text: 'Label' }), labelInput]),
            el('div.plan-row', {}, [el('span.hint', { text: 'Colour' }), colours]),
            chosen,
            uploadBtn,
            list,
            existing ? el('button.btn.btn--small.btn--danger', {
              svg: icon('trash', 14),
              onclick: (e) => {
                e.preventDefault();
                s.pads = s.pads.filter((p) => p.id !== existing.id);
                ctx.save();
                draw();
                document.querySelector('.scrim')?.remove();
              },
            }, ' Remove this pad') : null,
          ]),
        });

        if (!keep) return;
        draft.label = labelInput.value.trim() || (draft.upload
          ? (uploads.find((u) => u.id === draft.sound) || {}).label
          : (BUNDLED.get(draft.sound) || {}).label) || 'Sound';

        if (existing) Object.assign(existing, draft);
        else s.pads.push(draft);
        if (s.pads.length > 24) s.pads.length = 24;
        ctx.save();
        draw();
      }

      draw();
      return { destroy() { player.pause(); player.src = ''; } };
    },
  });
}(window.Desk));
