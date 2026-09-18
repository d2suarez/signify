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

   It also carries "Report a problem": a link at the foot of the panel that
   opens a short form and sends it, through the app's own /auth/report, to one
   list every Signify app shares. An app can open the same form from its own
   help menu with SignifyReport.open() — or open('bug'), open('mistake').

   Configuration, all optional, on the script tag or as globals:
     data-apps-endpoint    / SIGNIFY_APPS_ENDPOINT     "" for no app grid
     data-report-endpoint  / SIGNIFY_REPORT_ENDPOINT   where reports are posted
   =================================================================== */

(function () {
  'use strict';

  if (window.__signifySwitcherLoaded) return;
  window.__signifySwitcherLoaded = true;

  var SCRIPT = document.currentScript;
  function setting(attr, global, fallback) {
    if (SCRIPT && SCRIPT.hasAttribute(attr)) return SCRIPT.getAttribute(attr);
    if (global in window) return String(window[global] == null ? '' : window[global]);
    return fallback;
  }
  // An empty apps endpoint means "report button only, no grid" — which is how
  // the identity console itself uses this file.
  var ENDPOINT = setting('data-apps-endpoint', 'SIGNIFY_APPS_ENDPOINT', '/auth/apps');
  var REPORT_ENDPOINT = setting('data-report-endpoint', 'SIGNIFY_REPORT_ENDPOINT', '/auth/report');

  // The last few script errors on this page, so a "this button does nothing"
  // report can arrive with the reason attached. Held in memory only, and only
  // ever sent if the person sends a report with details included.
  var recentErrors = [];
  function remember(message, source, line, col) {
    if (!message) return;
    recentErrors.push({
      message: String(message).slice(0, 300),
      source: source ? String(source).slice(0, 500) : undefined,
      line: typeof line === 'number' ? line : undefined,
      col: typeof col === 'number' ? col : undefined,
      at: new Date().toISOString(),
    });
    if (recentErrors.length > 10) recentErrors.shift();
  }
  window.addEventListener('error', function (e) {
    if (e && e.message) remember(e.message, e.filename, e.lineno, e.colno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    remember('Unhandled promise rejection: ' + (r && r.message ? r.message : String(r)));
  });

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

    '.foot { margin: 10px -14px -14px; padding: 6px 8px; border-top: 1px solid #EEECE8; }',
    '.report {',
    '  display: flex; align-items: center; gap: 8px; width: 100%;',
    '  padding: 8px 8px; border: 0; border-radius: 6px; background: transparent;',
    '  font: inherit; font-size: 12.5px; font-weight: 500; color: #374151; cursor: pointer; text-align: left;',
    '}',
    '.report:hover { background: #F5F4F1; }',
    '.report:focus-visible { outline: 2px solid #1D4ED8; outline-offset: -2px; }',
    '.report svg { flex: none; color: #6B7280; }',

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

  function flagSvg() {
    return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
      ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3.5 14V2.5"/><path d="M3.5 3h8.2l-1.6 2.9 1.6 2.9H3.5"/></svg>';
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
      '<p class="title">Signify apps</p><div class="body"></div>' +
      '<div class="foot"><button class="report" type="button">' + flagSvg() +
      'Report a problem</button></div></div>';

    root.appendChild(style);
    root.appendChild(wrap);

    // Hidden until we know there is something to show.
    host.style.display = 'none';

    return {
      host: host, root: root, floating: floating,
      button: wrap.querySelector('.launch'),
      panel: wrap.querySelector('.panel'),
      body: wrap.querySelector('.body'),
      report: wrap.querySelector('.report')
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

    // Whatever the person had highlighted is usually the mistake itself. Read
    // it on the way in, before clicking around the panel can clear it.
    ui.button.addEventListener('pointerdown', captureSelection);

    ui.report.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(false);
      report.open(null, ui.button);
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

  // =================================================================
  // Report a problem
  // =================================================================

  var KINDS = [
    { key: 'bug', label: 'Something isn’t working',
      hint: 'A button does nothing, a page won’t load, something froze.',
      prompt: 'What were you doing, and what happened instead?' },
    { key: 'mistake', label: 'Something is wrong',
      hint: 'A wrong answer or fact, something in the wrong place, a typo.',
      prompt: 'What is wrong, and what should it be?' },
    { key: 'other', label: 'Something else',
      hint: 'Anything that doesn’t fit the other two.',
      prompt: 'Tell us what you noticed.' }
  ];

  var selectedText = '';
  function captureSelection() {
    try {
      var sel = window.getSelection && window.getSelection();
      var t = sel ? String(sel).replace(/\s+/g, ' ').trim() : '';
      selectedText = t.slice(0, 500);
    } catch (e) { selectedText = ''; }
  }

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function details() {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* older browser */ }
    return {
      userAgent: navigator.userAgent,
      language: navigator.language || '',
      timezone: tz,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      screen: (window.screen ? screen.width + 'x' + screen.height : ''),
      selection: selectedText || undefined,
      errors: recentErrors.slice()
    };
  }

  var REPORT_CSS = [
    ':host { all: initial; }',
    '*, *::before, *::after { box-sizing: border-box; }',
    '.back {',
    '  position: fixed; inset: 0; z-index: 2147483001;',
    '  display: flex; align-items: center; justify-content: center; padding: 12px;',
    '  background: rgba(17, 24, 39, .38);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;',
    '  color: #1F2937; font-size: 14px; line-height: 1.45;',
    '}',
    '.dlg {',
    '  width: min(460px, 100%); max-height: calc(100vh - 24px); overflow: auto;',
    '  background: #fff; border: 1px solid #E2E0DB; border-radius: 12px;',
    '  box-shadow: 0 1px 2px rgba(30,36,48,.09), 0 18px 44px rgba(30,36,48,.22);',
    '  padding: 20px 20px 16px;',
    '}',
    'h2 { margin: 0 0 4px; font-size: 17px; font-weight: 650; letter-spacing: -.005em; }',
    '.sub { margin: 0 0 16px; color: #6B7280; font-size: 13px; }',
    'fieldset { border: 0; margin: 0 0 14px; padding: 0; }',
    'legend, .lbl { display: block; margin: 0 0 6px; font-size: 12.5px; font-weight: 600; color: #374151; }',
    '.kinds { display: grid; gap: 6px; }',
    '.kind {',
    '  display: grid; grid-template-columns: 18px 1fr; gap: 2px 10px; align-items: start;',
    '  padding: 9px 11px; border: 1px solid #E2E0DB; border-radius: 8px; cursor: pointer;',
    '}',
    '.kind:hover { background: #FAFAF8; }',
    '.kind:has(input:checked) { border-color: #1D4ED8; background: #F3F6FE; }',
    '.kind input { grid-row: span 2; margin: 2px 0 0; accent-color: #1D4ED8; }',
    '.kind b { font-weight: 600; font-size: 13.5px; }',
    '.kind span { font-size: 12px; color: #6B7280; }',
    'textarea {',
    '  display: block; width: 100%; min-height: 104px; resize: vertical;',
    '  padding: 9px 11px; border: 1px solid #D1CFC9; border-radius: 8px;',
    '  font: inherit; color: inherit; background: #fff;',
    '}',
    'textarea:focus, .kind:focus-within { outline: 2px solid #1D4ED8; outline-offset: 1px; }',
    '.count { margin-top: 4px; text-align: right; font-size: 11.5px; color: #9CA3AF; }',
    '.quote {',
    '  display: flex; gap: 8px; align-items: flex-start; margin: 12px 0 0;',
    '  padding: 8px 10px; background: #F5F4F1; border-radius: 8px; font-size: 12.5px;',
    '}',
    '.quote q { flex: 1; color: #374151; font-style: italic; overflow-wrap: anywhere; }',
    '.x { border: 0; background: transparent; color: #6B7280; cursor: pointer; font: inherit; font-size: 12px; padding: 0 2px; text-decoration: underline; }',
    '.tech { margin: 14px 0 0; font-size: 12.5px; color: #374151; }',
    '.tech label { display: flex; gap: 8px; align-items: center; cursor: pointer; }',
    '.tech input { accent-color: #1D4ED8; margin: 0; }',
    '.tech details { margin: 4px 0 0 24px; color: #6B7280; font-size: 12px; }',
    '.tech summary { cursor: pointer; width: max-content; }',
    '.tech ul { margin: 6px 0 0; padding-left: 18px; }',
    '.status { min-height: 18px; margin: 12px 0 0; font-size: 12.5px; color: #B42318; }',
    '.foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }',
    'button.b {',
    '  padding: 8px 14px; border-radius: 7px; border: 1px solid #D1CFC9; background: #fff;',
    '  font: inherit; font-size: 13.5px; font-weight: 550; color: #1F2937; cursor: pointer;',
    '}',
    'button.b:hover { background: #F5F4F1; }',
    'button.b:focus-visible { outline: 2px solid #1D4ED8; outline-offset: 2px; }',
    'button.primary { background: #1D4ED8; border-color: #1D4ED8; color: #fff; }',
    'button.primary:hover { background: #1A43C0; }',
    'button.b[disabled] { opacity: .6; cursor: default; }',
    '.done { text-align: center; padding: 10px 4px 4px; }',
    '.tick {',
    '  width: 44px; height: 44px; margin: 0 auto 10px; border-radius: 50%;',
    '  display: flex; align-items: center; justify-content: center; background: #E7F4EC; color: #1B7F4B;',
    '}',
    '.ref {',
    '  display: inline-block; margin: 10px 0 4px; padding: 5px 10px; border-radius: 6px;',
    '  background: #F5F4F1; font: 600 15px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em;',
    '}',
    '@media (prefers-reduced-motion: no-preference) {',
    '  .dlg { animation: rise .14s ease-out; }',
    '  @keyframes rise { from { transform: translateY(6px); opacity: 0; } }',
    '}'
  ].join('\n');

  var report = (function () {
    var host = null;
    var returnTo = null;

    function close() {
      if (!host) return;
      host.remove();
      host = null;
      document.removeEventListener('keydown', onKey, true);
      // isConnected, not document.contains(): the switcher's own button lives
      // in a shadow root, where contains() always answers false.
      if (returnTo && returnTo.isConnected) { try { returnTo.focus(); } catch (e) { /* gone */ } }
      returnTo = null;
    }

    function onKey(e) {
      if (!host) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      // aria-modal promises the page behind is out of reach, so Tab has to
      // stay inside the dialog rather than wander off into it.
      if (e.key !== 'Tab') return;
      // A radio group is one tab stop: the checked one, or the first if none is.
      var anyChecked = !!host.shadowRoot.querySelector('input[type="radio"]:checked');
      var items = Array.prototype.filter.call(
        host.shadowRoot.querySelectorAll('button, textarea, input, summary'),
        function (el, i, all) {
          if (el.disabled || el.offsetParent === null) return false;
          if (el.type !== 'radio') return true;
          return anyChecked ? el.checked : el === host.shadowRoot.querySelector('input[type="radio"]');
        });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      var active = host.shadowRoot.activeElement;
      if (e.shiftKey && (active === first || !active)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !active)) { e.preventDefault(); first.focus(); }
    }

    function formHtml(kind) {
      return '<div class="back" data-back><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="rp-title">' +
        '<h2 id="rp-title">Report a problem</h2>' +
        '<p class="sub">It goes to the people who look after Signify apps, and to your school’s administrators.</p>' +
        '<form novalidate>' +
          '<fieldset><legend>What kind of problem?</legend><div class="kinds">' +
          KINDS.map(function (k) {
            return '<label class="kind"><input type="radio" name="kind" value="' + k.key + '"' +
              (k.key === kind ? ' checked' : '') + '>' +
              '<b>' + esc(k.label) + '</b><span>' + esc(k.hint) + '</span></label>';
          }).join('') +
          '</div></fieldset>' +
          '<label class="lbl" for="rp-msg">What happened?</label>' +
          '<textarea id="rp-msg" name="message" maxlength="4000" placeholder="' +
            esc((KINDS.filter(function (k) { return k.key === kind; })[0] || KINDS[0]).prompt) + '"></textarea>' +
          '<div class="count" aria-hidden="true"><span data-count>0</span> / 4000</div>' +
          (selectedText
            ? '<div class="quote" data-quote><q>' + esc(selectedText) + '</q>' +
              '<button type="button" class="x" data-drop-quote>Leave out</button></div>'
            : '') +
          '<div class="tech">' +
            '<label><input type="checkbox" name="details" checked> Include technical details</label>' +
            '<details><summary>What’s included?</summary><ul>' +
              '<li>The address of this page, without anything after a “?”</li>' +
              '<li>Your browser, screen size, language and time zone</li>' +
              (selectedText ? '<li>The text you had highlighted</li>' : '') +
              '<li>' + (recentErrors.length
                ? recentErrors.length + ' recent error message' + (recentErrors.length === 1 ? '' : 's') + ' from this page'
                : 'Any error messages from this page (there are none right now)') + '</li>' +
            '</ul></details>' +
          '</div>' +
          '<p class="status" role="alert" data-status></p>' +
          '<div class="foot">' +
            '<button type="button" class="b" data-cancel>Cancel</button>' +
            '<button type="submit" class="b primary" data-send>Send report</button>' +
          '</div>' +
        '</form></div></div>';
    }

    function doneHtml(ref) {
      return '<div class="back" data-back><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="rp-title">' +
        '<div class="done" role="status">' +
          '<div class="tick"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
            ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>' +
          '<h2 id="rp-title">Thanks — it’s been sent</h2>' +
          '<p class="sub" style="margin:0">If you need to mention it to anyone, quote this reference:</p>' +
          '<div class="ref">' + esc(ref) + '</div>' +
          '<div class="foot" style="justify-content:center"><button type="button" class="b primary" data-cancel>Done</button></div>' +
        '</div></div></div>';
    }

    function render(html) {
      host.shadowRoot.innerHTML = '<style>' + REPORT_CSS + '</style>' + html;
      var root = host.shadowRoot;
      root.querySelector('[data-back]').addEventListener('mousedown', function (e) {
        if (e.target === this) close();
      });
      Array.prototype.forEach.call(root.querySelectorAll('[data-cancel]'), function (b) {
        b.addEventListener('click', close);
      });
      return root;
    }

    function wireForm(root) {
      var form = root.querySelector('form');
      var msg = root.querySelector('textarea');
      var count = root.querySelector('[data-count]');
      var status = root.querySelector('[data-status]');
      var send = root.querySelector('[data-send]');

      msg.addEventListener('input', function () { count.textContent = msg.value.length; });
      Array.prototype.forEach.call(root.querySelectorAll('input[name="kind"]'), function (r) {
        r.addEventListener('change', function () {
          var k = KINDS.filter(function (x) { return x.key === r.value; })[0];
          if (k) msg.placeholder = k.prompt;
        });
      });
      var drop = root.querySelector('[data-drop-quote]');
      if (drop) drop.addEventListener('click', function () {
        selectedText = '';
        root.querySelector('[data-quote]').remove();
        msg.focus();
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var picked = root.querySelector('input[name="kind"]:checked');
        status.textContent = '';
        if (!picked) { status.textContent = 'Choose what kind of problem it is.'; root.querySelector('input[name="kind"]').focus(); return; }
        if (msg.value.trim().length < 3) { status.textContent = 'Say a little about what went wrong.'; msg.focus(); return; }

        var includeDetails = root.querySelector('input[name="details"]').checked;
        var body = {
          kind: picked.value,
          message: msg.value.trim(),
          pageUrl: location.origin + location.pathname,
          includeDetails: includeDetails,
          context: includeDetails ? details() : undefined
        };
        var headers = { 'content-type': 'application/json' };
        // The identity console guards writes with a double-submit token; the
        // apps have no such cookie and send nothing.
        var csrf = cookie('csrf');
        if (csrf) headers['x-csrf-token'] = csrf;

        send.disabled = true;
        send.textContent = 'Sending…';
        fetch(REPORT_ENDPOINT, {
          method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify(body)
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) { return { r: r, data: data }; });
        }).then(function (x) {
          if (x.r.ok && x.data.ref) {
            selectedText = '';
            var done = render(doneHtml(x.data.ref));
            done.querySelector('[data-cancel]').focus();
            return;
          }
          status.textContent = x.r.status === 401
            ? 'You’ve been signed out. Sign in again, then send it — what you wrote is still here.'
            : (x.data.error || 'That didn’t send. Please try again.');
          send.disabled = false;
          send.textContent = 'Send report';
        }).catch(function () {
          status.textContent = 'That didn’t send — check your connection and try again. What you wrote is still here.';
          send.disabled = false;
          send.textContent = 'Send report';
        });
      });

      // Focus the first thing that still needs an answer.
      (root.querySelector('input[name="kind"]:checked') ? msg : root.querySelector('input[name="kind"]')).focus();
    }

    function open(kind, from) {
      if (host) { var f = host.shadowRoot.querySelector('textarea'); if (f) f.focus(); return; }
      if (!document.body || !document.body.attachShadow) return;
      // Called directly by an app rather than from the panel: the selection is
      // still intact, so read it now.
      if (!from) captureSelection();
      returnTo = from || document.activeElement;
      host = document.createElement('div');
      host.setAttribute('data-signify-report', '');
      host.attachShadow({ mode: 'open' });
      document.body.appendChild(host);
      document.addEventListener('keydown', onKey, true);
      var k = KINDS.some(function (x) { return x.key === kind; }) ? kind : null;
      wireForm(render(formHtml(k)));
    }

    return { open: open, close: close };
  })();

  // For an app's own help menu or error screen:
  //   SignifyReport.open()            let the person choose
  //   SignifyReport.open('mistake')   start on "Something is wrong"
  window.SignifyReport = { open: function (kind) { report.open(kind || null, null); } };

  function start() {
    if (!document.body) return;
    if (!ENDPOINT) return; // report-only: the form still opens via SignifyReport.open()
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
        // Lets a host app move its own controls out of the way only when the
        // switcher is actually there — a signed-out visitor should not see a
        // gap where a button isn't.
        document.documentElement.setAttribute('data-signify-switcher-ready', '');
      })
      .catch(function () { /* the app itself carries on without it */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
