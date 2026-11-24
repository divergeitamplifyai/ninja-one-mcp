/* ninja-one-mcp site. Plain script, no build step. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var KINDS = ['read', 'write', 'destructive'];
  var KIND_LABEL = { read: 'Read', write: 'Write', destructive: 'Destructive' };
  var FALLBACK_COUNTS = { total: 314, read: 154, write: 105, destructive: 55 };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Theme */
  var root = document.documentElement;
  function currentTheme() {
    if (root.dataset.theme) return root.dataset.theme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function labelTheme() {
    var btn = $('#theme-toggle');
    if (!btn) return;
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    btn.title = 'Switch to ' + next + ' theme';
  }
  var toggle = $('#theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) {}
      var meta = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < meta.length; i++) meta[i].setAttribute('content', next === 'dark' ? '#0E1412' : '#EDF0EC');
      labelTheme();
    });
    labelTheme();
  }

  /* Header border once scrolled */
  var top = $('.top');
  if (top) {
    var onScroll = function () { top.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* Gate grid */
  var grid = $('#gate-grid');
  var gWrite = $('#g-write');
  var gDestructive = $('#g-destructive');
  var cells = [];
  var counts = FALLBACK_COUNTS;

  function buildGrid(tools) {
    if (!grid) return;
    var list = tools || [];
    if (!tools) {
      KINDS.forEach(function (k) { for (var i = 0; i < counts[k]; i++) list.push({ kind: k }); });
    } else {
      list = tools.slice().sort(function (a, b) { return KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind); });
    }
    var frag = document.createDocumentFragment();
    cells = list.map(function (t) {
      var c = document.createElement('span');
      c.className = 'cell ' + t.kind;
      if (t.name) c.title = t.name;
      frag.appendChild(c);
      return c;
    });
    grid.innerHTML = '';
    grid.appendChild(frag);
    updateGates(false);
  }

  function updateGates(animate) {
    var w = gWrite && gWrite.checked;
    if (gDestructive) {
      gDestructive.disabled = !w;
      if (!w) gDestructive.checked = false;
    }
    var d = w && gDestructive && gDestructive.checked;
    var on = { read: true, write: !!w, destructive: !!d };
    var changed = 0;
    cells.forEach(function (c) {
      var k = c.classList.contains('read') ? 'read' : c.classList.contains('write') ? 'write' : 'destructive';
      var want = on[k];
      if (c.classList.contains('on') !== want) {
        c.style.setProperty('--d', animate && !reduceMotion ? Math.min(changed * 4, 420) + 'ms' : '0ms');
        c.classList.toggle('on', want);
        changed++;
      }
    });
    var runnable = counts.read + (w ? counts.write : 0) + (d ? counts.destructive : 0);
    var note = !w ? 'Writes are listed but refuse.' : !d ? 'Destructive tools still refuse. Every write needs confirm: true.' : 'Every write still needs confirm: true.';
    var live = $('#gates-live');
    if (live) live.innerHTML = '<strong>' + runnable + '</strong> of ' + counts.total + ' tools can run. ' + note;
  }
  if (gWrite) gWrite.addEventListener('change', function () { updateGates(true); });
  if (gDestructive) gDestructive.addEventListener('change', function () { updateGates(true); });

  /* Catalog */
  var PAGE = 50;
  var state = { q: '', ts: '', kind: '', shown: PAGE };
  var data = null;
  var listEl = $('#catalog');
  var countEl = $('#count');
  var moreBtn = $('#more');
  var qEl = $('#q');
  var tsEl = $('#ts');

  function highlight(text, q) {
    var safe = esc(text);
    if (!q) return safe;
    var i = text.toLowerCase().indexOf(q);
    if (i < 0) return safe;
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  function descHtml(text, q) {
    var m = text.match(/^(.{40,260}?[.!?])\s+(.+)$/);
    if (!m) return '<div class="tool-desc"><p>' + highlight(text, q) + '</p></div>';
    var open = q && m[2].toLowerCase().indexOf(q) >= 0 && m[1].toLowerCase().indexOf(q) < 0;
    return '<div class="tool-desc"><p>' + highlight(m[1], q) + '</p>' +
      '<details' + (open ? ' open' : '') + '><summary>Details</summary><p>' + highlight(m[2], q) + '</p></details></div>';
  }

  function filtered() {
    var q = state.q;
    return data.tools.filter(function (t) {
      if (state.ts && t.toolset !== state.ts) return false;
      if (state.kind && t.kind !== state.kind) return false;
      if (!q) return true;
      return (t.name + ' ' + (t.title || '') + ' ' + t.description).toLowerCase().indexOf(q) >= 0;
    });
  }

  function render() {
    if (!data || !listEl) return;
    var rows = filtered();
    var visible = rows.slice(0, state.shown);
    var q = state.q;
    listEl.innerHTML = visible.map(function (t) {
      return '<li class="tool">' +
        '<div class="tool-name">' + highlight(t.name, q) + (t.title ? '<small>' + esc(t.title) + '</small>' : '') + '</div>' +
        '<div class="tool-meta"><span class="badge"><span class="dot k-' + t.kind + '"></span>' + KIND_LABEL[t.kind] + '</span><span>' + esc(t.toolset) + '</span></div>' +
        descHtml(t.description, q) +
        '</li>';
    }).join('');
    if (!rows.length) {
      listEl.innerHTML = '<li class="empty">No tools match. <button type="button" id="clear">Clear the filters</button> to see all ' + data.tools.length + '.</li>';
      var clear = $('#clear');
      if (clear) clear.addEventListener('click', resetFilters);
    }
    var byKind = { read: 0, write: 0, destructive: 0 };
    rows.forEach(function (t) { byKind[t.kind]++; });
    countEl.innerHTML = 'Showing <b>' + visible.length + '</b> of <b>' + rows.length + '</b> matching tools' +
      (rows.length !== data.tools.length ? ' (' + data.tools.length + ' in all)' : '') +
      '. ' + byKind.read + ' read, ' + byKind.write + ' write, ' + byKind.destructive + ' destructive.';
    if (moreBtn) {
      var left = rows.length - visible.length;
      moreBtn.hidden = left <= 0;
      moreBtn.textContent = 'Show ' + Math.min(PAGE, left) + ' more';
    }
  }

  function resetFilters() {
    state.q = ''; state.ts = ''; state.kind = ''; state.shown = PAGE;
    if (qEl) qEl.value = '';
    if (tsEl) tsEl.value = '';
    var all = $('input[name="kind"][value=""]');
    if (all) all.checked = true;
    render();
    if (qEl) qEl.focus();
  }

  var debounce;
  if (qEl) qEl.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () { state.q = qEl.value.trim().toLowerCase(); state.shown = PAGE; render(); }, 90);
  });
  if (tsEl) tsEl.addEventListener('change', function () { state.ts = tsEl.value; state.shown = PAGE; render(); });
  $$('input[name="kind"]').forEach(function (r) {
    r.addEventListener('change', function () { state.kind = r.value; state.shown = PAGE; render(); });
  });
  if (moreBtn) moreBtn.addEventListener('click', function () {
    var first = state.shown;
    state.shown += PAGE;
    render();
    var next = listEl.children[first];
    if (next) { next.setAttribute('tabindex', '-1'); next.focus({ preventScroll: true }); }
  });

  function renderToolsets() {
    var el = $('#toolsets');
    if (!el || !data) return;
    var defaults = data.default_toolsets || [];
    var html = Object.keys(data.toolsets).map(function (name) {
      var tools = data.tools.filter(function (t) { return t.toolset === name; });
      var k = { read: 0, write: 0, destructive: 0 };
      tools.forEach(function (t) { k[t.kind]++; });
      var bar = KINDS.map(function (kind) {
        return k[kind] ? '<span class="k-' + kind + '" style="width:' + (k[kind] / tools.length * 100) + '%"></span>' : '';
      }).join('');
      return '<li>' +
        '<div class="ts-head"><code>' + esc(name) + '</code><span class="n">' + tools.length + ' tools</span>' +
        (defaults.indexOf(name) >= 0 ? '<span class="def">Default</span>' : '') + '</div>' +
        '<p>' + esc(data.toolsets[name]) + '</p>' +
        '<div class="ts-bar" role="img" aria-label="' + k.read + ' read, ' + k.write + ' write, ' + k.destructive + ' destructive">' + bar + '</div>' +
        '</li>';
    }).join('');
    el.innerHTML = html;
  }

  function fillToolsetSelect() {
    if (!tsEl || !data) return;
    Object.keys(data.toolsets).forEach(function (name) {
      var o = document.createElement('option');
      o.value = name; o.textContent = name;
      tsEl.appendChild(o);
    });
  }

  function fail() {
    buildGrid(null);
    var link = '<a href="https://github.com/divergeitamplifyai/ninja-one-mcp/blob/main/docs/TOOLS.md">docs/TOOLS.md</a>';
    if (countEl) countEl.innerHTML = 'The catalog could not load here. Browsers block it when the page is opened as a file. Read the full list in ' + link + ' on GitHub.';
    var ts = $('#toolsets');
    if (ts) ts.innerHTML = '<li><p>The toolset list comes from the catalog. See ' + link + ' for every toolset and tool.</p></li>';
    $$('.filters input, .filters select').forEach(function (i) { i.disabled = true; });
  }

  if (window.fetch && location.protocol !== 'file:') {
    fetch('catalog.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (json) {
        if (!json || !Array.isArray(json.tools)) throw new Error('bad catalog');
        data = json;
        data.tools.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        if (json.counts) counts = json.counts;
        ['read', 'write', 'destructive'].forEach(function (k) { var n = $('#n-' + k); if (n) n.textContent = counts[k]; });
        buildGrid(data.tools);
        fillToolsetSelect();
        renderToolsets();
        render();
      })
      .catch(fail);
  } else {
    fail();
  }

  /* Tabs */
  var tabs = $$('[role="tab"]');
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      var p = document.getElementById(t.getAttribute('aria-controls'));
      if (p) p.hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { select(tab, false); });
    tab.addEventListener('keydown', function (e) {
      var n = null;
      if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') n = tabs[0];
      else if (e.key === 'End') n = tabs[tabs.length - 1];
      if (n) { e.preventDefault(); select(n, true); }
    });
  });

  /* Copy buttons */
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) resolve(); else reject();
    });
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  function selectNode(node) {
    var r = document.createRange();
    r.selectNodeContents(node);
    var sel = window.getSelection();
    sel.empty ? sel.empty() : sel.collapseToStart();
    sel.addRange(r);
  }
  $$('.copy').forEach(function (btn) {
    btn.setAttribute('aria-label', 'Copy snippet');
    btn.addEventListener('click', function () {
      var code = btn.parentNode.querySelector('code');
      copyText(code.textContent).then(function () {
        btn.textContent = 'Copied'; btn.classList.add('done');
      }, function () {
        selectNode(code);
        btn.textContent = 'Selected';
      }).then(function () {
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600);
      });
    });
  });
})();
