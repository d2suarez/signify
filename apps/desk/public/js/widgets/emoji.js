// ===================================================================
// Widget — Emoji picker
//
// Rolls an emoji and puts it on the clipboard, for the teacher pasting a
// reaction onto a piece of marked work.
//
// Copying is the whole point, so it happens on the tap that picks — not
// behind a second "copy" button. Tapping any emoji in the tray copies that
// one instead, because a random pick you cannot override is a novelty rather
// than a tool.
//
// The set is deliberately curated: skin-tone and gesture emoji are left out,
// not because anything is wrong with them, but because a random picker that
// lands on a hand sign nobody vetted is a conversation no teacher wants.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, shuffle, toast } = Desk;

  const GROUPS = [
    {
      key: 'praise',
      label: 'Well done',
      list: ['🌟', '⭐', '🏆', '🥇', '🎉', '🎊', '👏', '💯', '✅', '🔥', '💪', '🚀', '🌈', '✨', '🦄', '🎯'],
    },
    {
      key: 'faces',
      label: 'Faces',
      list: ['😀', '😄', '😁', '🙂', '😊', '😃', '🤩', '😎', '🤓', '🧐', '🤔', '😮', '😴', '🥳', '😇', '🙃'],
    },
    {
      key: 'animals',
      label: 'Animals',
      list: ['🐶', '🐱', '🦊', '🐼', '🐨', '🦁', '🐸', '🐵', '🐙', '🦉', '🦋', '🐝', '🐢', '🦕', '🐧', '🦥'],
    },
    {
      key: 'school',
      label: 'School',
      list: ['📚', '✏️', '📝', '📖', '🔬', '🧪', '🧮', '🖍️', '📐', '🎒', '🗺️', '🔭', '🧲', '⚗️', '📊', '🖇️'],
    },
    {
      key: 'nature',
      label: 'Nature',
      list: ['🌳', '🌻', '🌺', '🍀', '🌙', '☀️', '⛅', '❄️', '🌊', '🍁', '🌵', '🍄', '🌷', '⚡', '🌋', '🪐'],
    },
    {
      key: 'food',
      label: 'Food',
      list: ['🍎', '🍌', '🍓', '🥕', '🍕', '🥪', '🍪', '🧁', '🍩', '🥨', '🍿', '🧃', '🍇', '🥦', '🍊', '🥐'],
    },
  ];

  const all = () => GROUPS.flatMap((g) => g.list);

  Desk.widget({
    type: 'emoji',
    name: 'Emoji picker',
    blurb: 'Roll one and it is on your clipboard, ready to paste onto a piece of work.',
    icon: 'smile',
    category: 'other',
    size: { w: 3, h: 4 },
    min: { w: 2, h: 3 },

    init(s) {
      if (typeof s.group !== 'string') s.group = 'praise';
      if (typeof s.current !== 'string') s.current = '';
      if (!Array.isArray(s.recent)) s.recent = [];
    },

    mount(ctx) {
      const s = ctx.state;

      const big = el('button.emoji-big', { type: 'button', title: 'Tap to copy again' });
      const status = el('div.emoji-status');
      const tray = el('div.emoji-tray');
      const recentRow = el('div.emoji-recent');
      const tabs = el('div.chips.emoji-tabs');

      const pool = () => (s.group === 'all' ? all() : (GROUPS.find((g) => g.key === s.group) || GROUPS[0]).list);

      /**
       * Copies, and says so. navigator.clipboard needs a secure context and a
       * gesture; the textarea fallback is what keeps this working on the
       * older locked-down browsers a school laptop trolley tends to have.
       */
      async function copy(ch) {
        let ok = false;
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(ch);
            ok = true;
          }
        } catch { ok = false; }

        if (!ok) {
          try {
            const box = el('textarea', { value: ch, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
            document.body.append(box);
            box.select();
            ok = document.execCommand('copy');
            box.remove();
          } catch { ok = false; }
        }

        status.textContent = ok ? `${ch} copied — paste it anywhere` : `${ch} — press ⌘C or Ctrl+C to copy`;
        status.classList.toggle('is-warn', !ok);
        if (!ok) {
          // Nothing was copied, so at least leave it selected for them.
          const range = document.createRange();
          range.selectNodeContents(big);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return ok;
      }

      function remember(ch) {
        s.recent = [ch, ...s.recent.filter((x) => x !== ch)].slice(0, 12);
        s.current = ch;
        ctx.save();
      }

      async function pick(ch) {
        const chosen = ch || (() => {
          const options = pool().filter((x) => x !== s.current);
          return shuffle(options.length ? options : pool())[0];
        })();
        big.textContent = chosen;
        big.classList.remove('is-new');
        void big.offsetWidth;                       // restart the animation
        big.classList.add('is-new');
        remember(chosen);
        await copy(chosen);
        drawRecent();
      }

      function drawTabs() {
        Desk.clear(tabs);
        for (const g of [...GROUPS, { key: 'all', label: 'Everything' }]) {
          tabs.append(el('button.chip', {
            text: g.label,
            class: s.group === g.key ? 'is-on' : '',
            onclick: () => { s.group = g.key; ctx.save(); drawTabs(); drawTray(); },
          }));
        }
      }

      function drawTray() {
        Desk.clear(tray);
        for (const ch of pool()) {
          tray.append(el('button.emoji-cell', { text: ch, title: 'Copy', onclick: () => pick(ch) }));
        }
      }

      function drawRecent() {
        Desk.clear(recentRow);
        if (!s.recent.length) return;
        recentRow.append(el('span.hint', { text: 'Just used' }));
        for (const ch of s.recent) {
          recentRow.append(el('button.emoji-cell.emoji-cell--small', { text: ch, title: 'Copy', onclick: () => pick(ch) }));
        }
      }

      big.addEventListener('click', () => { if (s.current) { copy(s.current); } else { pick(); } });

      ctx.root.append(el('div.emoji', {}, [
        el('div.emoji-face', {}, [big, status]),
        el('button.btn.btn--primary.btn--wide', { svg: icon('shuffle', 16), onclick: () => pick() }, ' Roll one'),
        recentRow,
        ctx.expanded ? tabs : null,
        ctx.expanded ? tray : null,
      ]));

      big.textContent = s.current || '🎲';
      status.textContent = s.current ? 'Tap it to copy again' : 'Roll one to copy it';
      drawTabs();
      drawTray();
      drawRecent();

      return {};
    },
  });
}(window.Desk));
