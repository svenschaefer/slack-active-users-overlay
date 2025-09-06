// ==UserScript==
// @name         Slack Active Users Overlay
// @version      1.0
// @author       Sven A. Schäfer
// @description  Right-side overlay with active users; 1-min DOM presence logging; hover panel with 10×24 heatmap + “last seen”. UI: wider panel, right-aligned mini-bars, fixed-width status, vacation shows 🌴 only. (en-US)
// @match        https://app.slack.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript>

(() => {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────────────────────────────────────

  /** Storage keys (bump suffix when schema changes). */
  const STORE_KEY = 'gmSlackPresence.v2';
  const PREF_KEY  = 'gmSlackPresence.prefs.v2';

  /** Slack DOM selectors. */
  const SEL = {
    anyRow: '.p-channel_sidebar__channel',
    dmRow : '.p-channel_sidebar__channel[data-qa-channel-sidebar-channel-type="im"]',
    sidebarList: '.p-channel_sidebar__list'
  };

  /** Presence thresholds and cadence (UI only; logging cadence unchanged). */
  const DEFAULT_PREFS = {
    scanIntervalMs: 60_000,
    horizonDays: 10,           // 10 rows (today first row)
    activeThresholdMin: 1,     // >=1 minute inside the hour -> active
    overlayFilter: 'all'       // 'all' | 'active' | 'inactive' | 'vacation'
  };

  /** Centralized presence constants and labels. */
  const PRES = { ACTIVE: 'active', AWAY: 'away', DND: 'dnd', OFF: 'offline', VAC: 'vac' };
  const STATUS_LABEL = {
    [PRES.ACTIVE]: 'active',
    [PRES.AWAY]  : 'away',
    [PRES.DND]   : 'DND',
    [PRES.OFF]   : 'offline',
    [PRES.VAC]   : '🌴'
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ──────────────────────────────────────────────────────────────────────────────

  const gmAvailable = typeof GM_getValue === 'function';

  /** Simple storage facade (GM_ storage preferred; localStorage fallback). */
  const Storage = {
    get(key, fallback) {
      try {
        const raw = gmAvailable ? GM_getValue(key, 'null') : localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (_) { return fallback; }
    },
    set(key, value) {
      const write = gmAvailable ? GM_setValue : (k, v) => localStorage.setItem(k, v);
      write(key, JSON.stringify(value));
    },
    del(key) {
      gmAvailable ? GM_deleteValue(key) : localStorage.removeItem(key);
    }
  };

  /** Shorthand DOM helpers. */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Time helpers (UTC-consistent for keys and pruning). */
  const now = () => new Date();

  const toUtcHourKey = (d = now()) => {
    const utc = new Date(Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      d.getUTCHours(), 0, 0, 0
    ));
    return utc.toISOString();
  };

  const utcStartOfDayMinus = (days = 0) => {
    const n = now();
    const base = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 0, 0, 0, 0);
    return new Date(base - days * 86_400_000);
  };

  const padIntlTime = (d) =>
    (d instanceof Date ? d : new Date(d)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const fmtSince = (ts) => {
    if (!ts) return '–';
    const min = Math.floor(Math.max(0, Date.now() - ts) / 60_000);
    if (min < 1)  return 'just now';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24)   return `${h} h`;
    return `${Math.floor(h / 24)} d`;
  };

  /** Throttle helper. */
  const throttle = (fn, ms) => {
    let t = 0;
    let last;
    return (...args) => {
      last = args;
      const n = Date.now();
      if (n - t > ms) { t = n; fn(...last); }
    };
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // Preferences & Store
  // ──────────────────────────────────────────────────────────────────────────────

  /** @type {typeof DEFAULT_PREFS} */
  const prefs = Object.assign({}, DEFAULT_PREFS, Storage.get(PREF_KEY, {}));
  const savePrefs = () => Storage.set(PREF_KEY, prefs);

  /** Load / save presence store. */
  const loadStore = () => Storage.get(STORE_KEY, { users: {} });
  const saveStore = (s) => Storage.set(STORE_KEY, s);

  /** Remove hourly buckets outside horizon (UTC-based). */
  const pruneOld = (store) => {
    const keep = new Set();
    for (let day = 0; day < prefs.horizonDays; day++) {
      const start = utcStartOfDayMinus(prefs.horizonDays - 1 - day);
      for (let h = 0; h < 24; h++) {
        const key = new Date(start.getTime() + h * 3_600_000).toISOString();
        keep.add(key);
      }
    }
    for (const u of Object.values(store.users)) {
      for (const k of Object.keys(u.hourly || {})) if (!keep.has(k)) delete u.hourly[k];
    }
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // Slack DOM parsing
  // ──────────────────────────────────────────────────────────────────────────────

  /** Extract display name from sidebar row. */
  const extractRowName = (row) => {
    const el = row.querySelector('.p-channel_sidebar__name');
    if (!el) return '';
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE ||
        (n.nodeType === Node.ELEMENT_NODE && !n.classList.contains('p-channel_sidebar__member_label')))
      .map((n) => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
    return text.replace(/\s+,/g, ',').trim();
  };

  /** Extract avatar URL. */
  const extractRowAvatar = (row) =>
    row.querySelector('.p-channel_sidebar__user_avatar img, .p-channel_sidebar__mpim_avatars img')?.src || '';

  /** Compute presence from row. */
  const extractRowPresence = (row) => {
    const presenceSvg = row.querySelector('.c-avatar__presence [data-qa="presence_indicator"]');
    const nameEl = row.querySelector('.p-channel_sidebar__name');
    const awayByClass = !!(nameEl && nameEl.classList.contains('p-channel_sidebar__name--away'));

    if (presenceSvg) {
      const active = presenceSvg.getAttribute('data-qa-presence-active') === 'true';
      const dnd    = presenceSvg.getAttribute('data-qa-presence-dnd') === 'true';
      if (active) return PRES.ACTIVE;
      if (dnd)    return PRES.DND;
      if (awayByClass) return PRES.AWAY;
      return PRES.OFF;
    }
    const pres = row.querySelector('.c-avatar__presence');
    if (pres?.classList.contains('c-presence--active')) return PRES.ACTIVE;
    if (awayByClass || pres?.classList.contains('c-presence--away')) return PRES.AWAY;
    return PRES.OFF;
  };

  /** Enumerate DM users visible in the sidebar. */
  const enumerateDmUsers = () => {
    const rows = $$(SEL.dmRow);
    return rows.map((row) => {
      const id = row.getAttribute('data-qa-channel-sidebar-channel-id') || extractRowName(row) || row.id;
      const csWrap = row.querySelector('.p-channel_sidebar__custom_status');
      const csImg  = csWrap?.querySelector('img');
      return {
        id,
        name: extractRowName(row),
        avatar: extractRowAvatar(row),
        presence: extractRowPresence(row),
        customStatusText: (csWrap?.textContent || '').trim(),
        customStatusEmoji: csImg?.getAttribute('alt') || '',
        customStatusEmojiShort: csImg?.getAttribute('data-stringify-emoji') || '',
        customStatusSrc: csImg?.src || '',
        row
      };
    });
  };

  /** Vacation detection (🌴 or text like “OOO”, “vacation”, “Urlaub”). */
  const isVacation = (u) => {
    const alt   = (u.customStatusEmoji || '').toLowerCase();
    const short = (u.customStatusEmojiShort || '').toLowerCase();
    const txt   = (u.customStatusText || '').toLowerCase();
    const src   = (u.customStatusSrc || '').toLowerCase();
    return (
      alt.includes('palm') || short.includes('palm') ||
      src.includes('1f334') || /\bvacation\b|\booo\b|\bout of office\b|\burlaub\b/.test(txt)
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // Presence logging
  // ──────────────────────────────────────────────────────────────────────────────

  const logPresenceOnce = () => {
    const store   = loadStore();
    const hourKey = toUtcHourKey();
    const users   = enumerateDmUsers();

    for (const u of users) {
      if (!store.users[u.id]) {
        store.users[u.id] = {
          id: u.id,
          name: u.name,
          avatar: u.avatar,
          lastSeenActive: null,
          lastStatus: PRES.OFF,
          customStatusEmoji: '',
          customStatusEmojiShort: '',
          customStatusText: '',
          customStatusSrc: '',
          hourly: {}
        };
      }
      const rec = store.users[u.id];

      rec.name   = u.name   || rec.name;
      rec.avatar = u.avatar || rec.avatar;
      rec.lastStatus = u.presence;
      if (u.presence === PRES.ACTIVE) rec.lastSeenActive = Date.now();

      rec.customStatusEmoji      = u.customStatusEmoji      || rec.customStatusEmoji;
      rec.customStatusEmojiShort = u.customStatusEmojiShort || rec.customStatusEmojiShort;
      rec.customStatusText       = u.customStatusText       || rec.customStatusText;
      rec.customStatusSrc        = u.customStatusSrc        || rec.customStatusSrc;

      rec.hourly[hourKey] = rec.hourly[hourKey] || { a: 0, w: 0, d: 0, t: 0 };
      if (u.presence === PRES.ACTIVE) rec.hourly[hourKey].a++;
      else if (u.presence === PRES.AWAY) rec.hourly[hourKey].w++;
      else if (u.presence === PRES.DND)  rec.hourly[hourKey].d++;
      rec.hourly[hourKey].t++;
    }

    pruneOld(store);
    saveStore(store);
    renderOverlay();
  };

  setInterval(logPresenceOnce, prefs.scanIntervalMs);

  // ──────────────────────────────────────────────────────────────────────────────
  // Styles (UI-only)
  // ──────────────────────────────────────────────────────────────────────────────

  const CSS = /* css */`
  :root { --gm-width: 440px; --gm-status-w: 64px; }
  #gmAU_Overlay {
    position: fixed; right: 12px; top: 50%; transform: translateY(-50%);
    width: var(--gm-width); max-height: 82vh; z-index: 999999;
    background: rgba(22,23,25,0.96); color:#e7e9ea; border:1px solid #2b2f33; border-radius:12px;
    box-shadow: 0 12px 28px rgba(0,0,0,.65); display:flex; flex-direction:column; overflow:hidden;
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans";
  }
  #gmAU_Overlay.gm--hidden{ display:none; }

  /* Header */
  #gmAU_Header{ display:flex; align-items:center; gap:8px; padding:8px 10px; background:#0f1113; border-bottom:1px solid #272a2e; }
  #gmAU_Pulse{ width:10px; height:10px; border-radius:50%; background:#27d17c; box-shadow:0 0 0 2px rgba(39,209,124,.15); }
  #gmAU_Count{ background:#233328; color:#9be5b1; border:1px solid #2f4638; font-weight:700; padding:1px 8px; border-radius:999px; }
  #gmAU_Search{ margin-left:6px; padding:5px 8px; background:#15181b; color:#d9dee3; border:1px solid #2b2f33; border-radius:8px; width:160px; }
  .gmAU_btn{ border:none; background:#1a1d20; color:#cfd3d6; width:28px; height:28px; border-radius:8px; cursor:pointer; }
  .gmAU_btn:hover{ background:#23272b; }

  /* Filters */
  #gmAU_Filters{ display:flex; gap:6px; padding:6px 10px; background:#101214; border-bottom:1px solid #272a2e; }
  .gmAU_filter{ font-size:11px; padding:4px 10px; border-radius:999px; border:1px solid #2b2f33; background:#15181b; color:#bfc5cb; cursor:pointer; }
  .gmAU_filter.active{ border-color:#2f4638; background:#233328; color:#9be5b1; }

  /* List rows */
  #gmAU_List{ overflow:auto; scrollbar-width:thin; }
  .gmAU_item{
    display:grid; grid-template-columns: 24px 1fr minmax(126px, 1fr) var(--gm-status-w);
    column-gap:12px; align-items:center; padding:8px 12px; border-bottom:1px dashed #2a2e33;
  }
  .gmAU_item:hover{ background:#15181b; }
  .gmAU_avatar{ width:24px; height:24px; border-radius:6px; object-fit:cover; }
  .gmAU_name{ min-width:0; }
  .gmAU_name_text{ display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gmAU_mini{ justify-self:end; display:inline-grid; grid-auto-flow:column; gap:1px; }
  .gmAU_mini_cell{ width:6px; height:10px; border-radius:1px; background:#2a2e33; }
  .gmAU_mini_cell.a{ background:#37c876; }
  .gmAU_mini_cell.w{ background:#b39b45; }
  .gmAU_mini_cell.d{ background:#e05a5a; }
  .gmAU_mini_cell.i{ background:#2a2e33; }

  .gmAU_status{
    width:var(--gm-status-w); justify-self:end; text-align:center;
    font-size:11px; padding:3px 0; border-radius:8px; border:1px solid #2b2f33; background:#1a1d20; color:#cfd3d6;
  }
  .gmAU_status.active{ background:#233328; color:#9be5b1; border-color:#2f4638; }
  .gmAU_status.away{ background:#2f2a18; color:#e8d28c; border-color:#5a4b1a; }
  .gmAU_status.dnd{ background:#3a2323; color:#f0a6a6; border-color:#613333; }
  .gmAU_status.offline{ background:#1c1c1c; color:#a6a6a6; border-color:#2c2c2c; }
  .gmAU_status.vac{ background:#233328; color:#9be5b1; border-color:#2f4638; }

  .gmAU_note{ grid-column: 2 / -1; color:#98a0a6; font-size:11px; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* Footer (clock only) */
  #gmAU_Footer{ display:flex; justify-content:flex-end; padding:6px 10px; color:#8a9095; background:#0f1113; border-top:1px solid #272a2e; font-size:11px; }

  /* Tooltip */
  #gmAU_Tooltip{
    position:fixed; pointer-events:none; z-index:1000000; background:rgba(12,13,15,0.98);
    color:#e7e9ea; border:1px solid #2b2f33; border-radius:10px; box-shadow:0 10px 24px rgba(0,0,0,.55);
    padding:10px; width:480px; max-width:94vw;
  }
  #gmAU_Tooltip.hidden{ display:none; }
  .gmTT_header{ display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .gmTT_avatar{ width:28px; height:28px; border-radius:6px; object-fit:cover; }
  .gmTT_name{ font-weight:700; font-size:14px; }
  .gmTT_meta{ color:#9aa0a6; font-size:12px; }
  .gmTT_status{ margin-left:auto; font-size:12px; padding:2px 6px; border-radius:6px; }
  .gmTT_status.active{ background:#233328; color:#9be5b1; border:1px solid #2f4638; }
  .gmTT_status.away{ background:#2f2a18; color:#e8d28c; border:1px solid #5a4b1a; }
  .gmTT_status.dnd{ background:#3a2323; color:#f0a6a6; border:1px solid #613333; }
  .gmTT_status.offline{ background:#1c1c1c; color:#a6a6a6; border:1px solid #2c2c2c; }
  .gmTT_grid{ display:grid; grid-template-rows: repeat(10, auto); gap:6px; }
  .gmTT_row{ display:grid; grid-template-columns: repeat(24, 1fr); gap:2px; align-items:center; }
  .gmTT_cell{ height:10px; border-radius:2px; background:#1e2125; }
  .gmTT_cell.a{ background:#37c876; } .gmTT_cell.w{ background:#b39b45; }
  .gmTT_cell.d{ background:#e05a5a; } .gmTT_cell.i{ background:#2a2e33; }
  .gmTT_hourlabels{ display:flex; justify-content:space-between; font-size:10px; color:#8a9095; margin:4px 2px 8px 42px; }
  .gmTT_leg{ display:flex; gap:10px; font-size:11px; color:#9aa0a6; margin-top:6px; }
  .gmTT_leg span{ display:inline-flex; align-items:center; gap:6px; }
  .gmTT_dot{ width:10px; height:10px; border-radius:2px; display:inline-block; }
  .gmTT_dot.a{ background:#37c876; } .gmTT_dot.w{ background:#b39b45; } .gmTT_dot.d{ background:#e05a5a; } .gmTT_dot.i{ background:#2a2e33; }
  `;

  const injectCss = () => {
    if (typeof GM_addStyle === 'function') GM_addStyle(CSS);
    else { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); }
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // Overlay UI
  // ──────────────────────────────────────────────────────────────────────────────

  const ensureOverlay = () => {
    if ($('#gmAU_Overlay')) return;

    // Overlay shell
    const wrap = document.createElement('div');
    wrap.id = 'gmAU_Overlay';
    wrap.innerHTML = `
      <div id="gmAU_Header">
        <i id="gmAU_Pulse" aria-hidden="true"></i>
        <span id="gmAU_Count" aria-live="polite">0</span>
        <input id="gmAU_Search" type="search" placeholder="Search…" aria-label="Search users" />
        <button id="gmAU_btnRefresh" class="gmAU_btn" title="Refresh now" aria-label="Refresh now">↻</button>
        <button id="gmAU_btnExport"  class="gmAU_btn" title="Export JSON" aria-label="Export JSON">⇩</button>
        <button id="gmAU_btnClear"   class="gmAU_btn" title="Clear data" aria-label="Clear data">🗑</button>
        <button id="gmAU_btnClose"   class="gmAU_btn" title="Close overlay" aria-label="Close overlay">✕</button>
      </div>

      <div id="gmAU_Filters" role="group" aria-label="Filters">
        <button class="gmAU_filter" data-filter="active"   aria-pressed="false">Active</button>
        <button class="gmAU_filter" data-filter="inactive" aria-pressed="false">Inactive</button>
        <button class="gmAU_filter" data-filter="vacation" aria-pressed="false">Vacation 🌴</button>
        <button class="gmAU_filter" data-filter="all"      aria-pressed="false">All</button>
      </div>

      <div id="gmAU_List" role="list"></div>
      <div id="gmAU_Footer"><span id="gmAU_Clock" aria-live="polite">–:–</span></div>
    `;
    document.body.appendChild(wrap);

    // Tooltip container
    const tt = document.createElement('div');
    tt.id = 'gmAU_Tooltip';
    tt.classList.add('hidden');
    document.body.appendChild(tt);

    // Header actions
    $('#gmAU_btnClose').addEventListener('click', () => wrap.classList.add('gm--hidden'));
    $('#gmAU_btnRefresh').addEventListener('click', logPresenceOnce);
    $('#gmAU_btnExport').addEventListener('click', exportStore);
    $('#gmAU_btnClear').addEventListener('click', clearStore);
    $('#gmAU_Search').addEventListener('input', throttle(renderOverlay, 150));

    // Filter buttons
    $$('#gmAU_Filters .gmAU_filter').forEach((btn) => {
      if (btn.dataset.filter === prefs.overlayFilter) btn.classList.add('active');
      btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
      btn.addEventListener('click', () => {
        $$('#gmAU_Filters .gmAU_filter').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        prefs.overlayFilter = btn.dataset.filter;
        savePrefs();
        renderOverlay();
      });
    });

    // Clock
    setInterval(() => { $('#gmAU_Clock').textContent = padIntlTime(new Date()); }, 1_000);

    // Overlay hover => tooltip (open to the left)
    $('#gmAU_List').addEventListener('mouseover', (e) => {
      const li = e.target.closest('.gmAU_item'); if (!li) return;
      showTooltip(li.dataset.uid, { x: e.clientX, y: e.clientY + 8, side: 'left' });
    });
    $('#gmAU_List').addEventListener('mousemove', throttle((e) => {
      const li = e.target.closest('.gmAU_item'); if (!li) return;
      showTooltip(li.dataset.uid, { x: e.clientX, y: e.clientY + 8, side: 'left' });
    }, 60));
    $('#gmAU_List').addEventListener('mouseleave', hideTooltip);

    // Slack left sidebar hover => tooltip left of cursor (fits viewport)
    document.addEventListener('mouseover', (e) => {
      const row = e.target.closest(SEL.anyRow); if (!row) return;
      const id  = row.getAttribute('data-qa-channel-sidebar-channel-id'); if (!id) return;
      showTooltip(id, { x: e.clientX, y: e.clientY + 6, side: 'left' });
    }, { capture: true });
    document.addEventListener('mousemove', throttle((e) => {
      const row = e.target.closest(SEL.anyRow); if (!row) return;
      const id  = row.getAttribute('data-qa-channel-sidebar-channel-id'); if (!id) return;
      showTooltip(id, { x: e.clientX, y: e.clientY + 6, side: 'left' });
    }, 60), { capture: true });
    document.addEventListener('mouseout', (e) => {
      if (e.relatedTarget && (e.relatedTarget.closest('#gmAU_Tooltip') || e.relatedTarget.closest(SEL.anyRow))) return;
      hideTooltip();
    });
  };

  /** Download current store as JSON (Windows-safe filename). */
  const exportStore = () => {
    const blob = new Blob([JSON.stringify(loadStore(), null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const ts   = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const a    = document.createElement('a');
    a.href = url;
    a.download = `slack-presence-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  /** Clear stored history. */
  const clearStore = () => {
    if (confirm('Delete stored presence history?')) {
      Storage.del(STORE_KEY);
      renderOverlay();
    }
  };

  /** Create last-12-hours micro bars for a user record (UTC based). */
  const renderMiniBars = (rec) => {
    if (!rec) return '';
    const cells = [];
    const n = now();
    const baseUTC = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), n.getUTCHours(), 0, 0, 0);
    for (let i = 11; i >= 0; i--) {
      const key = new Date(baseUTC - i * 3_600_000).toISOString();
      const hr  = rec.hourly?.[key];
      let cls = 'i';
      if (hr) {
        if ((hr.a | 0) >= prefs.activeThresholdMin) cls = 'a';
        else if ((hr.d | 0) >= prefs.activeThresholdMin) cls = 'd';
        else if ((hr.w | 0) >= prefs.activeThresholdMin) cls = 'w';
      }
      cells.push(`<i class="gmAU_mini_cell ${cls}" title="${new Date(key).toLocaleString('en-US')}"></i>`);
    }
    return `<span class="gmAU_mini">${cells.join('')}</span>`;
  };

  /** Render overlay list. */
  const renderOverlay = () => {
    ensureOverlay();

    const list    = $('#gmAU_List');
    const countEl = $('#gmAU_Count');
    const query   = ($('#gmAU_Search')?.value || '').trim().toLowerCase();

    const store   = loadStore();
    const users   = enumerateDmUsers();

    const filtered = users
      .filter((u) => {
        if (query && !u.name.toLowerCase().includes(query)) return false;
        if (prefs.overlayFilter === 'active')   return u.presence === PRES.ACTIVE;
        if (prefs.overlayFilter === 'inactive') return u.presence !== PRES.ACTIVE;
        if (prefs.overlayFilter === 'vacation') return isVacation(u);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    countEl.textContent = String(filtered.length);
    list.innerHTML = '';

    for (const u of filtered) {
      const rec   = store.users[u.id];
      const vac   = isVacation(u);
      const key   = vac ? PRES.VAC : (u.presence || PRES.OFF);
      const label = STATUS_LABEL[key];

      const note = (vac && (u.customStatusText || '').trim())
        ? `<div class="gmAU_note">Note: ${u.customStatusText.trim()}</div>` : '';

      const row = document.createElement('div');
      row.className = 'gmAU_item';
      row.dataset.uid = u.id;
      row.setAttribute('role', 'listitem');
      row.innerHTML = `
        <img class="gmAU_avatar" src="${u.avatar || ''}" alt="">
        <div class="gmAU_name" title="${u.name}">
          <span class="gmAU_name_text">${u.name}</span>
          ${note}
        </div>
        ${renderMiniBars(rec)}
        <span class="gmAU_status ${key}" title="${label}">${label}</span>
      `;
      list.appendChild(row);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // Tooltip
  // ──────────────────────────────────────────────────────────────────────────────

  /** Place tooltip next to cursor, preferring left side when requested/needed. */
  const placeTooltip = (tt, at, sidePref = 'auto') => {
    const pad = 10;
    tt.style.visibility = 'hidden';
    tt.classList.remove('hidden');
    const rect = tt.getBoundingClientRect();
    let left = at.x + 12;
    let top  = at.y;

    const vw = innerWidth;
    const vh = innerHeight;
    const needLeft = (sidePref === 'left') || (left + rect.width + pad > vw);
    if (needLeft) left = at.x - rect.width - 12;
    if (top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
    if (top < pad) top = pad;
    if (left < pad) left = pad;
    if (left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);

    tt.style.left = `${Math.round(left)}px`;
    tt.style.top  = `${Math.round(top)}px`;
    tt.style.visibility = 'visible';
  };

  /** Render tooltip for a user at a screen position (UTC-based grid). */
  const showTooltip = (userId, opts) => {
    const { x, y, side = 'auto' } = (opts || {});
    const tt = $('#gmAU_Tooltip'); if (!tt) return;

    const store = loadStore();
    const rec   = store.users[userId];
    const live  = enumerateDmUsers().find((x) => x.id === userId);

    const name   = rec?.name   || live?.name   || 'Unknown';
    const avatar = rec?.avatar || live?.avatar || '';
    const status = live?.presence || rec?.lastStatus || PRES.OFF;
    const last   = (status === PRES.ACTIVE) ? Date.now() : (rec?.lastSeenActive || null);

    // Build 10×24 grid: row 0 = today (UTC), row 9 = 10th day back
    const rows = [];
    for (let day = 0; day < prefs.horizonDays; day++) {
      const start = utcStartOfDayMinus(day);
      const row = [];
      for (let h = 0; h < 24; h++) {
        const key = new Date(start.getTime() + h * 3_600_000).toISOString();
        const hr  = rec?.hourly?.[key];
        let cls = 'i';
        if (hr) {
          if ((hr.a | 0) >= prefs.activeThresholdMin) cls = 'a';
          else if ((hr.d | 0) >= prefs.activeThresholdMin) cls = 'd';
          else if ((hr.w | 0) >= prefs.activeThresholdMin) cls = 'w';
        }
        row.push({ key, cls });
      }
      rows.push(row);
    }

    const statusText = STATUS_LABEL[status] || status;
    const hourLabels = ['00', '', '06', '', '12', '', '18', '', '23'];
    const dayLabels  = Array.from({ length: prefs.horizonDays }, (_, i) =>
      utcStartOfDayMinus(i).toLocaleDateString('en-US', { weekday: 'short', month: '2-digit', day: '2-digit' })
    );
    const vacText  = (rec?.customStatusText || live?.customStatusText || '').trim();
    const vacBadge = (isVacation(rec || live)) ? ` • 🌴${vacText ? ' – ' + vacText : ''}` : '';

    tt.innerHTML = `
      <div class="gmTT_header">
        <img class="gmTT_avatar" src="${avatar}" alt="">
        <div>
          <div class="gmTT_name">${name}</div>
          <div class="gmTT_meta">last seen: ${fmtSince(last)}${vacBadge}</div>
        </div>
        <div class="gmTT_status ${status}">${statusText}</div>
      </div>

      <div class="gmTT_hourlabels">
        ${hourLabels.map((l) => `<span style="width:calc(100%/8);flex:0 0 auto">${l}</span>`).join('')}
      </div>

      <div class="gmTT_grid">
        ${rows.map((r, i) => `
          <div class="gmTT_row" title="${dayLabels[i]}">
            ${r.map((c) => {
              const dt  = new Date(c.key);
              const lab = dt.toLocaleTimeString('en-US', { hour: '2-digit' }) + ':00';
              return `<div class="gmTT_cell ${c.cls}" title="${dayLabels[i]} • ${lab}"></div>`;
            }).join('')}
          </div>
        `).join('')}
      </div>

      <div class="gmTT_leg">
        <span><i class="gmTT_dot a"></i> active</span>
        <span><i class="gmTT_dot w"></i> away</span>
        <span><i class="gmTT_dot d"></i> DND</span>
        <span><i class="gmTT_dot i"></i> inactive</span>
      </div>
    `;
    placeTooltip(tt, { x, y }, side);
  };

  const hideTooltip = () => { $('#gmAU_Tooltip')?.classList.add('hidden'); };

  // ──────────────────────────────────────────────────────────────────────────────
  // Slack DOM observation (render on changes)
  // ──────────────────────────────────────────────────────────────────────────────

  const observeSidebar = () => {
    const list = $(SEL.sidebarList);
    if (!list) return false;
    const rerender = throttle(renderOverlay, 400);
    new MutationObserver(rerender).observe(list, { childList: true, subtree: true, attributes: true });
    return true;
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // Bootstrapping
  // ──────────────────────────────────────────────────────────────────────────────

  const init = () => {
    injectCss();
    ensureOverlay();
    logPresenceOnce();

    const tryObs = () => observeSidebar() || setTimeout(tryObs, 1_000);
    tryObs();

    document.addEventListener('visibilitychange', () => { if (!document.hidden) renderOverlay(); });
  };

  const readyInterval = setInterval(() => {
    if ($(SEL.sidebarList)) { clearInterval(readyInterval); init(); }
  }, 400);
})();
