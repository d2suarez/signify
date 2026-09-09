/* ===================================================================
   Signify — app switcher
   
   The nine-dot grid that moves someone between Signify apps. One file,
   dropped into every app, so it looks and behaves identically everywhere:
   
     <script src="/vendor/signify-switcher.js" defer></script>
   
   It mounts into the first element with [data-signify-switcher] if there is
   one, and otherwise pins itself to the top-right corner. Everything lives in
   a shadow root, so no host stylesheet can reach in and no rule of ours can
   leak out — which is the only way a shared widget stays identical across
   four apps with four different design systems.
   
   The app list comes from the app's OWN origin (/auth/apps), which proxies to
   Signify ID. A signed-out visitor gets nothing and no button appears.
   =================================================================== */

(function () {
  'use strict';

  if (window.__signifySwitcherLoaded) return;
  window.__signifySwitcherLoaded = true;

  var ENDPOINT = (window.SIGNIFY_APPS_ENDPOINT || '/auth/apps');

  // Primary colours, matching the rest of the fleet.
  var COLORS = {
    blue:   { bg: '#1D4ED8', fg: '#ffffff' },
    red:    { bg: '#C62828', fg: '#ffffff' },
    yellow: { bg: '#E0A100', fg: '#231a00' },
    green:  { bg: '#1B7F4B', fg: '#ffffff' },
    ink:    { bg: '#374151', fg: '#ffffff' }
  };

  var CSS = [
    ':host { all: initial; }',
    '*, *::before, *::after { box-sizing: border-box; }',
    '.wrap { position: relative; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }',

    '.launch {',
    '  display: inline-flex; align-items: center; justify-content: center;',
    '  width: 40px; height: 40px; padding: 0;',
    '  border: 1px solid transparent; border-radius: 6px;',
    '  background: transparent; cursor: pointer; color: #4b5563;',
    '  transition: background .12s ease, box-shadow .12s ease;',
    '}',
    '.launch:hover { background: rgba(0,0,0,.06); }',
    '.launch:focus-visible { outline: 2px solid #1D4ED8; outline-offset: 2px; }',
    '.launch[aria-expanded="true"] { background: rgba(0,0,0,.09); }',
    '.launch svg { display: block; }',

    '.panel {',
    '  position: absolute; top: calc(100% + 8px); right: 0; z-index: 2147483000;',
    '  width: 320px; padding: 14px;',
    '  background: #ffffff; color: #1F2937;',
    '  border: 1px solid #E2E0DB; border-radius: 10px;',
    // A tight contact shadow over a soft ambient one — paper on a desk.
    '  box-shadow: 0 1px 2px rgba(30,36,48,.09), 0 12px 30px rgba(30,36,48,.16);',
    '}',
    '.panel[hidden] { display: none; }',

    '.title {',
    '  margin: 0 0 10px; padding: 0 4px;',
    '  font-size: 11px; font-weight: 600; letter-spacing: .09em;',
    '  text-transform: uppercase; color: #6B7280;',
    '}',

    '.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }',

    '.app {',
    '  display: flex; flex-direction: column; align-items: center; gap: 7px;',
    '  padding: 12px 6px; border-radius: 6px;',
    '  text-decoration: none; color: inherit; text-align: center;',
    '  border: 1px solid transparent; cursor: pointer;',
    '}',
    '.app:hover { background: #F5F4F1; }',
    '.app:focus-visible { outline: 2px solid #1D4ED8; outline-offset: -2px; }',
    '.app[aria-current="true"] { background: #EEF2FD; border-color: #C9D6F6; }',

    '.tile {',
    '  width: 42px; height: 42px; border-radius: 9px;',
    '  display: flex; align-items: center; justify-content: center;',
    '  font-size: 15px; font-weight: 700; letter-spacing: .02em;',
    '  box-shadow: 0 1px 2px rgba(30,36,48,.14);',
    '}',
    '.label { font-size: 11.5px; line-height: 1.25; font-weight: 500; word-break: break-word; }',
    '.here { font-size: 10px; color: #6B7280; font-weight: 500; }',

    '.msg { padding: 14px 6px; text-align: center; font-size: 12.5px; color: #6B7280; }',

    '@media (max-width: 420px) { .panel { width: min(300px, calc(100vw - 24px)); } }',
    '@media (prefers-reduced-motion: reduce) { .launch { transition: none; } }'
  ].join('\n');

  // Nine dots, drawn rather than pulled from an icon font.
  function dotsSvg() {
    var d = '';
    for (var y = 0; y < 3; y++) {
      for (var x = 0; x < 3; x++) {
        d += '<circle cx="' + (5 + x * 5) + '" cy="' + (5 + y * 5) + '" r="1.7"/>';
      }
    }
    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' + d + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function build() {
    var host = document.querySelector('[data-signify-switcher]');
    var floating = false;
    if (!host) {
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483000;';
      document.body.appendChild(host);
      floating = true;
    }

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
    if (!root) return; // very old browser: skip rather than render something broken

    var style = document.createElement('style');
    style.textContent = CSS;

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML =
      '<button class="launch" type="button" aria-haspopup="true" aria-expanded="false"' +
      ' aria-label="Switch Signify app" title="Signify apps">' + dotsSvg() + '</button>' +
      '<div class="panel" hidden role="dialog" aria-label="Signify apps">' +
      '<p class="title">Signify apps</p><div class="body"></div></div>';

    root.appendChild(style);
    root.appendChild(wrap);

    // Hidden until we know there is something to show.
    host.style.display = 'none';

    return {
      host: host, root: root, floating: floating,
      button: wrap.querySelector('.launch'),
      panel: wrap.querySelector('.panel'),
      body: wrap.querySelector('.body')
    };
  }

  function renderApps(ui, data) {
    var apps = (data && data.apps) || [];
    if (!apps.length) {
      ui.body.innerHTML = '<p class="msg">No other apps are available to you yet.</p>';
      return;
    }
    ui.body.innerHTML =
      '<div class="grid">' + apps.map(function (a) {
        var c = COLORS[a.color] || COLORS.blue;
        return '<a class="app" href="' + esc(a.url) + '"' +
          (a.current ? ' aria-current="true"' : '') +
          ' title="' + esc(a.description || a.fullName || a.name) + '">' +
          '<span class="tile" style="background:' + c.bg + ';color:' + c.fg + '">' +
            esc(a.initials) + '</span>' +
          '<span class="label">' + esc(a.name) + '</span>' +
          (a.current ? '<span class="here">You are here</span>' : '') +
          '</a>';
      }).join('') + '</div>';
  }

  function wire(ui) {
    var open = false;

    function setOpen(next) {
      open = next;
      ui.panel.hidden = !open;
      ui.button.setAttribute('aria-expanded', String(open));
      if (open) {
        var first = ui.panel.querySelector('.app');
        if (first) first.focus();
      }
    }

    ui.button.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!open);
    });

    // Escape closes and returns focus to the button, which is what a keyboard
    // user expects and what a screen reader announces sensibly.
    ui.root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) {
        setOpen(false);
        ui.button.focus();
      }
    });

    // A click anywhere else closes it. Listening on the document works even
    // though the panel is in a shadow root, because clicks inside it are
    // retargeted to the host element.
    document.addEventListener('click', function (e) {
      if (!open) return;
      if (e.target === ui.host || ui.host.contains(e.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) setOpen(false);
    });
  }

  function start() {
    if (!document.body) return;
    var ui = build();
    if (!ui) return;
    wire(ui);

    fetch(ENDPOINT, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        // Signed out, or identity unreachable: show nothing at all rather
        // than a button that opens onto an error.
        if (!data || !data.apps || !data.apps.length) return;
        renderApps(ui, data);
        ui.host.style.display = '';
      })
      .catch(function () { /* the app itself carries on without it */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
