// ===================================================================
// Teacher's Desk — icons
// One 24px stroked set, drawn inline so the page never asks another host for
// anything. No emoji anywhere in this app: they render differently on every
// board in every classroom, and half of them are unreadable at the back.
// ===================================================================

window.Desk = window.Desk || {};

(function (Desk) {
  'use strict';

  const paths = {
    timer: '<path d="M9 2h6M12 8v6l4 2"/><circle cx="12" cy="14" r="8"/>',
    stopwatch: '<path d="M9 2h6M12 7v7M19 6l1.5-1.5"/><circle cx="12" cy="14" r="8"/>',
    alarm: '<path d="M6 19h12M18 15V10a6 6 0 0 0-12 0v5l-1.5 3h15L18 15ZM10 22h4"/><path d="M3 5 6 2M21 5l-3-3"/>',
    notes: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5M8 12h8M8 16h6"/>',
    behaviour: '<path d="M4 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1"/><circle cx="10" cy="7" r="3.5"/><path d="M17 6h5M19.5 3.5v5"/>',
    randomiser: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5.5A2.5 2.5 0 0 0 8 9M16 6h2.5A2.5 2.5 0 0 1 16 9"/><path d="M12 13v4M9 21h6M10 17h4"/>',
    message: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21l4-4 4 4"/><path d="M7 9h10M7 12.5h6"/>',
    heart: '<path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9Z"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM19 19h2v2h-2zM14 19h2v2h-2zM19 14h2v3h-2z" fill="currentColor" stroke="none"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.6-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8Z"/><circle cx="7.5" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/>',
    speaker: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .3-8 6 6 0 0 0-11.5 1.6A3.5 3.5 0 0 0 7 18Z"/>',
    download: '<path d="M12 4v12M8 12l4 4 4-4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    upload: '<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    print: '<path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/><circle cx="17.5" cy="11" r=".9" fill="currentColor" stroke="none"/>',
    slides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M9 20h6"/><path d="M8 8.5h5M8 11.5h8"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17.5 9 12l4 4 3-2.5 4 4"/>',
    video: '<rect x="2.5" y="5" width="19" height="14" rx="3.5"/><path d="M10.5 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none"/>',
    seating: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="4" y="13" width="5" height="7" rx="1.5"/><rect x="9.5" y="13" width="5" height="7" rx="1.5"/><rect x="15" y="13" width="5" height="7" rx="1.5"/>',
    groups: '<circle cx="7" cy="8" r="3"/><circle cx="17" cy="8" r="3"/><path d="M2 20v-1a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v1M12 20v-1a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v1"/>',

    expand: '<path d="M9 3H3v6M15 21h6v-6M3 3l7 7M21 21l-7-7"/>',
    collapse: '<path d="M3 9h6V3M21 15h-6v6M3 3l6 6M21 21l-6-6"/>',
    close: '<path d="M5 5l14 14M19 5 5 19"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
    drag: '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 4v16M16 4v16"/>',
    reset: '<path d="M4 4v6h6"/><path d="M4.6 14a8 8 0 1 0 1.4-7"/>',
    present: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    check: '<path d="M4 12.5 9.5 18 20 6.5"/>',
    chevron: '<path d="M9 5l7 7-7 7"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    sound: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9.5a4 4 0 0 1 0 5"/>',
    muted: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7M8 14h8v7H8z"/>',
    shuffle: '<path d="M16 3h5v5M21 3l-7 7M16 21h5v-5M21 21l-6-6M3 3l6 6M3 21l7-7"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  };

  /** Icon markup. `name` is one of the keys above; unknown names draw nothing. */
  function icon(name, size = 20) {
    const d = paths[name];
    if (!d) return '';
    return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  }

  const iconEl = (name, size) => Desk.el('span.icon-wrap', { svg: icon(name, size) });

  Desk.icon = icon;
  Desk.iconEl = iconEl;
  Desk.iconNames = Object.keys(paths);
}(window.Desk));
