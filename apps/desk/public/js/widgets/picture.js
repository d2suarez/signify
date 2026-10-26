// ===================================================================
// Widget — Picture
//
// A picture the teacher put there themselves: the day's learning objective
// photographed off the planner, a diagram from a textbook, the class pet.
//
// The file goes to this app's own store and comes back from this app's own
// origin — nothing is hotlinked, so no third party learns which classroom is
// looking at what, and nothing breaks when somebody else's page moves.
// Uploads are sniffed, capped and kept per teacher in server/assets.js.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  const FITS = [
    { key: 'contain', label: 'Whole picture' },
    { key: 'cover', label: 'Fill the card' },
  ];

  const srcFor = (id) => `/api/assets/${encodeURIComponent(id)}`;

  Desk.widget({
    type: 'picture',
    name: 'Picture',
    blurb: 'A picture of your own on the board — a diagram, a photo, today’s objective.',
    icon: 'image',
    category: 'board',
    students: true,
    fills: true,
    size: { w: 4, h: 4 },
    min: { w: 2, h: 2 },

    init(s) {
      if (typeof s.assetId !== 'string') s.assetId = '';
      if (typeof s.label !== 'string') s.label = '';
      if (!FITS.some((f) => f.key === s.fit)) s.fit = 'contain';
    },

    holdsContent: (s) => (s.assetId ? 'The picture goes with it.' : ''),

    mount(ctx) {
      const s = ctx.state;
      const stage = el('div.pic-stage');
      const settings = el('div.pic-settings');

      ctx.root.append(el('div.picture-widget', {}, [stage, settings]));

      function drawStage() {
        Desk.clear(stage);

        if (!s.assetId) {
          Desk.append(stage,
            el('p.hint', { text: 'No picture yet.' }),
            ctx.expanded ? null : el('button.btn.btn--small', {
              svg: icon('plus', 14),
              onclick: () => ctx.expand && ctx.expand(),
            }, ' Choose one'),
          );
          return;
        }

        stage.append(el('img.pic-img', {
          src: srcFor(s.assetId),
          alt: s.label || 'A picture on the board',
          class: s.fit === 'cover' ? 'is-cover' : '',
          // A picture that has been deleted from another card should say so
          // rather than leave a broken-image glyph on the projector.
          onerror: () => {
            Desk.clear(stage).append(el('p.hint', { text: 'That picture is no longer here. Choose another.' }));
          },
        }));

        if (s.label) stage.append(el('div.pic-caption', { text: s.label }));
      }

      async function drawSettings() {
        Desk.clear(settings);
        if (!ctx.expanded) return;

        settings.append(el('div.starter-row', {}, [
          el('button.btn.btn--small.btn--primary', { svg: icon('plus', 14), onclick: upload }, ' Upload a picture'),
          s.assetId ? el('button.btn.btn--small', {
            svg: icon('close', 14),
            onclick: () => { s.assetId = ''; ctx.save(); drawStage(); drawSettings(); },
          }, ' Take it off the card') : null,
        ].filter(Boolean)));

        settings.append(
          el('label.field', {}, [
            el('span.field-label', { text: 'A caption' }),
            el('input.input', {
              type: 'text', value: s.label, maxlength: 80, placeholder: 'e.g. Today’s objective',
              // Only the picture below. Rebuilding these settings would destroy
              // this very input and drop the caret after every keystroke.
              oninput: (e) => { s.label = e.target.value; ctx.save(); drawStage(); },
            }),
          ]),
          el('div.plan-row', {}, [
            el('span.hint', { text: 'Show it as' }),
            el('div.seg.seg--tiny', {}, FITS.map((f) => el('button.seg-btn', {
              text: f.label,
              class: s.fit === f.key ? 'is-on' : '',
              onclick: () => { s.fit = f.key; ctx.save(); drawStage(); Desk.keepFocus(ctx.root, drawSettings); },
            }))),
          ]),
        );

        // Everything this teacher has already uploaded, so the same picture can
        // go on a second card without being sent up twice.
        const gallery = el('div.pic-gallery');
        settings.append(el('span.field-label', { text: 'Your pictures' }), gallery);

        let mine = [];
        try { mine = (await Desk.api.assets('image')).assets || []; }
        catch { gallery.append(el('p.hint', { text: 'Could not list your pictures just now.' })); return; }

        if (!mine.length) {
          gallery.append(el('p.hint', { text: 'Nothing uploaded yet. They are private to you, and shared with your other cards.' }));
          return;
        }

        for (const a of mine) {
          const on = s.assetId === a.id;
          gallery.append(el('button.picture', {
            class: on ? 'is-on' : '',
            title: a.label,
            style: { backgroundImage: `url("${srcFor(a.id)}")` },
            onclick: () => {
              s.assetId = a.id;
              if (!s.label) s.label = '';
              ctx.save(); drawStage(); drawSettings();
            },
          }, el('span.picture-x', {
            svg: icon('close', 12),
            title: `Delete ${a.label}`,
            onclick: async (e) => {
              e.stopPropagation();
              // Deleting the file, not just this card's use of it — so it is
              // worth asking, because another card may be showing it too.
              const sure = await Desk.ask({
                title: `Delete “${a.label}”?`,
                body: 'It goes from your desk for good, including any other card showing it.',
                confirmLabel: 'Delete', danger: true,
              });
              if (!sure) return;
              try { await Desk.api.deleteAsset(a.id); }
              catch (err) { toast(err.message, 'warn'); return; }
              if (on) s.assetId = '';
              ctx.save(); drawStage(); drawSettings();
            },
          })));
        }
      }

      async function upload() {
        const file = await Desk.pickFile('image/*');
        if (!file) return;
        try {
          const saved = await Desk.api.uploadAsset(file);
          if (saved.kind !== 'image') { toast('That was not a picture.', 'warn'); return; }
          s.assetId = saved.id;
          if (!s.label) s.label = saved.label || '';
          ctx.save();
          drawStage(); drawSettings();
        } catch (e) { toast(e.message, 'warn'); }
      }

      drawStage();
      drawSettings();
      return {};
    },
  });
}(window.Desk));
