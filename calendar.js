/*
 * Crunchyroll Release Calendar (Unofficial) — calendar.js
 *
 * Runs in the page's MAIN world on www.crunchyroll.com at document_start.
 *
 * What it does:
 *  1. Hooks XMLHttpRequest/fetch so we can reuse the bearer token the site's own
 *     code sends to its API. The token never leaves this page.
 *  2. Intercepts clicks on "Release Calendar" links (/simulcastcalendar) and
 *     opens the calendar in place, instead of letting the server redirect you
 *     to the seasonal Simulcasts page. Direct URL / bookmark loads are redirected
 *     by rules.json to /videos/new#crcal, which this script also picks up.
 *  3. Fetches newly-added episodes from /content/v2/discover/browse
 *     (type=episode, sort_by=newly_added), groups them Mon–Sun by the time they
 *     actually became available, and draws them in a shadow-DOM overlay.
 */
(() => {
  'use strict';
  if (window.__crcal) return;

  const VERSION = '0.2.2';
  const API_PATH = '/content/v2/discover/browse';
  const PAGE_SIZE = 100;
  const MAX_PAGES = 40;              // 4,000 rows ≈ 10 weeks at Oct-2026 volume
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const PREFS_KEY = 'crcal.prefs.v1';
  const RELOAD_FLAG = 'crcal.reloaded';
  const NEVER_FREE_YEAR = 9000;      // the API uses year 9998 for "never free"
  const CATALOG_GAP_DAYS = 180;      // aired this long before release => catalog add
  const PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?simulcastcalendar\/?$/i;

  const AUDIO_NAMES = {
    'ja-JP': 'Japanese', 'en-US': 'English', 'en-IN': 'English (India)',
    'es-419': 'Spanish (Latin America)', 'es-ES': 'Spanish (Spain)',
    'pt-BR': 'Portuguese (Brazil)', 'pt-PT': 'Portuguese (Portugal)',
    'fr-FR': 'French', 'de-DE': 'German', 'it-IT': 'Italian', 'ar-SA': 'Arabic',
    'ru-RU': 'Russian', 'hi-IN': 'Hindi', 'ta-IN': 'Tamil', 'te-IN': 'Telugu',
    'th-TH': 'Thai', 'id-ID': 'Indonesian', 'ko-KR': 'Korean',
    'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)',
    'pl-PL': 'Polish', 'tl-PH': 'Tagalog', 'ms-MY': 'Malay', 'vi-VN': 'Vietnamese',
    'ca-ES': 'Catalan', 'tr-TR': 'Turkish'
  };
  const PATH_LOCALES = {
    '': 'en-US', 'es': 'es-419', 'es-es': 'es-ES', 'pt-br': 'pt-BR', 'pt-pt': 'pt-PT',
    'fr': 'fr-FR', 'de': 'de-DE', 'ar': 'ar-SA', 'it': 'it-IT', 'ru': 'ru-RU',
    'hi': 'hi-IN', 'pl': 'pl-PL', 'zh-tw': 'zh-TW', 'th': 'th-TH', 'tl-ph': 'tl-PH',
    'id': 'id-ID', 'ko': 'ko-KR'
  };

  /* ------------------------------------------------------------------ */
  /* Token capture                                                       */
  /* ------------------------------------------------------------------ */
  let token = null;
  let tokenWaiters = [];
  const noteToken = (v) => {
    if (typeof v !== 'string' || !/^Bearer\s+\S+/i.test(v)) return;
    token = v;
    const w = tokenWaiters; tokenWaiters = [];
    w.forEach((fn) => fn(v));
  };
  // The account id appears in the site's own content-API URLs
  // (/content/v2/<account>/watchlist, .../playheads, ...). We need it only to
  // ask for watch progress; it is never sent anywhere else.
  const ACCOUNT_KEY = 'crcal.account.v1';
  let accountId = null;
  try { accountId = localStorage.getItem(ACCOUNT_KEY) || null; } catch (e) { /* ignore */ }
  let onAccountChange = null; // set once the UI exists
  const ACCOUNT_RE = /\/content\/v2\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;
  const setAccount = (id) => {
    if (id === accountId) return;
    accountId = id;
    try { if (id) localStorage.setItem(ACCOUNT_KEY, id); else localStorage.removeItem(ACCOUNT_KEY); } catch (e) { /* ignore */ }
    if (onAccountChange) onAccountChange();
  };
  const noteUrl = (u) => { try { const m = ACCOUNT_RE.exec(String(u)); if (m) setAccount(m[1].toLowerCase()); } catch (e) { /* ignore */ } };
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    noteUrl(url);
    return xhrOpen.apply(this, arguments);
  };
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (typeof k === 'string' && /^authorization$/i.test(k)) noteToken(v);
    return xhrSetHeader.apply(this, arguments);
  };
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        noteUrl(typeof input === 'string' ? input : (input && input.url));
        let h = null;
        if (init && init.headers) {
          h = init.headers instanceof Headers
            ? init.headers.get('authorization')
            : (init.headers.authorization || init.headers.Authorization);
        } else if (input instanceof Request) {
          h = input.headers.get('authorization');
        }
        if (h) noteToken(h);
      } catch (e) { /* ignore */ }
      return origFetch.apply(this, arguments);
    };
  }
  const waitForToken = (ms) => {
    if (token) return Promise.resolve(token);
    return new Promise((resolve, reject) => {
      const fn = (v) => { clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => {
        tokenWaiters = tokenWaiters.filter((f) => f !== fn);
        reject(Object.assign(new Error('Couldn\'t get a session token from this page. Reload the page and open the calendar again.'), { code: 'no-token' }));
      }, ms);
      tokenWaiters.push(fn);
    });
  };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const parseDate = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d; };
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDayHead = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const fmtMD = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' });
  const fmtRange = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const tzName = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'local time'; } })();

  const pageLocale = () => {
    const m = location.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//i);
    const key = m ? m[1].toLowerCase() : '';
    return PATH_LOCALES[key] || 'en-US';
  };
  const audioName = (code) => {
    if (AUDIO_NAMES[code]) return AUDIO_NAMES[code];
    try { return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) || code; } catch (e) { return code; }
  };
  const pickThumb = (images) => {
    try {
      const arr = (images && images.thumbnail && images.thumbnail[0]) || [];
      let best = null;
      for (const im of arr) {
        if (!im || !im.source) continue;
        if (!best) { best = im; continue; }
        const bestOk = best.width >= 240, imOk = im.width >= 240;
        if ((imOk && !bestOk) || (imOk && bestOk && im.width < best.width) || (!imOk && !bestOk && im.width > best.width)) best = im;
      }
      return best ? best.source : '';
    } catch (e) { return ''; }
  };

  const normalize = (it) => {
    const m = it && it.episode_metadata;
    if (!m) return null;
    const premium = parseDate(m.premium_available_date) || parseDate(m.available_date) || parseDate(m.availability_starts);
    if (!premium) return null;
    const freeRaw = parseDate(m.free_available_date);
    const free = freeRaw && freeRaw.getFullYear() < NEVER_FREE_YEAR ? freeRaw : null;
    const air = parseDate(m.episode_air_date) || parseDate(m.upload_date);
    const audio = m.audio_locale || '';
    let original = null;
    if (Array.isArray(m.versions)) {
      const mine = m.versions.find((v) => v && v.guid === it.id);
      if (mine && typeof mine.original === 'boolean') original = mine.original;
    }
    if (original === null) original = audio === 'ja-JP' || (!Array.isArray(m.versions) && /^(zh|ko)-/.test(audio));
    return {
      id: it.id,
      key: `${it.id}|${audio}`,
      title: it.title || '',
      slug: it.slug_title || '',
      series: m.series_title || '',
      seriesId: m.series_id || '',
      seriesSlug: m.series_slug_title || '',
      season: m.season_display_number || '',
      ep: m.episode || (m.episode_number != null ? String(m.episode_number) : ''),
      audio,
      original,
      premiumOnly: !!m.is_premium_only,
      premium,
      free,
      air,
      catalog: !!(air && (premium - air) / 86400000 > CATALOG_GAP_DAYS),
      duration: m.duration_ms || 0,
      thumb: pickThumb(it.images),
      mature: !!m.is_mature
    };
  };

  /* ------------------------------------------------------------------ */
  /* Data loading (with a short-lived cache)                             */
  /* ------------------------------------------------------------------ */
  const pageCache = new Map(); // start -> { at, promise } (in-flight requests are shared)
  const fetchPage = (start) => {
    const cached = pageCache.get(start);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.promise;
    const promise = (async () => {
      const tk = await waitForToken(15000);
      const url = `${API_PATH}?type=episode&sort_by=newly_added&n=${PAGE_SIZE}&start=${start}&locale=${encodeURIComponent(pageLocale())}`;
      const res = await origFetch(url, { headers: { authorization: tk }, credentials: 'include' });
      if (res.status === 401) throw Object.assign(new Error('Crunchyroll rejected the session token (401).'), { code: 401 });
      if (!res.ok) throw new Error(`Crunchyroll API answered HTTP ${res.status}.`);
      const json = await res.json();
      return (json.data || []).map(normalize).filter(Boolean);
    })();
    pageCache.set(start, { at: Date.now(), promise });
    promise.catch(() => { if (pageCache.get(start) && pageCache.get(start).promise === promise) pageCache.delete(start); });
    return promise;
  };

  // Load every row released on/after `since`. The feed is newest-first, so we
  // page until a page's oldest row is older than `since`.
  const loadSince = async (since, onProgress) => {
    const out = new Map();
    for (let i = 0; i < MAX_PAGES; i++) {
      if (onProgress) onProgress(i + 1);
      const rows = await fetchPage(i * PAGE_SIZE);
      for (const r of rows) if (!out.has(r.key)) out.set(r.key, r);
      if (rows.length < PAGE_SIZE) return { rows: [...out.values()], complete: true, pages: i + 1 };
      const oldest = rows.reduce((a, r) => (r.premium < a ? r.premium : a), rows[0].premium);
      if (oldest < since) return { rows: [...out.values()], complete: true, pages: i + 1 };
    }
    return { rows: [...out.values()], complete: false, pages: MAX_PAGES };
  };

  /* ------------------------------------------------------------------ */
  /* Watch progress (playheads)                                          */
  /* ------------------------------------------------------------------ */
  const playheads = new Map(); // episode id -> { playhead (s), fullyWatched } | null (queried, nothing)
  let playheadsError = null;
  const loadPlayheads = async (ids) => {
    const tk = await waitForToken(15000);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const url = `/content/v2/${accountId}/playheads?content_ids=${chunk.map(encodeURIComponent).join(',')}&locale=${encodeURIComponent(pageLocale())}`;
      const res = await origFetch(url, { headers: { authorization: tk }, credentials: 'include' });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        // a remembered id that no longer matches this session (logged out, switched profile):
        // forget it and let the page's next account-scoped call supply the right one
        setAccount(null);
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      chunk.forEach((id) => { if (!playheads.has(id)) playheads.set(id, null); });
      for (const d of (json.data || [])) {
        const id = d && (d.content_id || d.id);
        if (!id) continue;
        playheads.set(id, { playhead: Number(d.playhead) || 0, fullyWatched: !!d.fully_watched });
      }
    }
  };
  let phBusy = false, phQueued = false;
  // Fetch progress for whatever is on screen and not yet known, then re-render.
  const ensurePlayheads = () => {
    if (!accountId || !state.open || playheadsError) return;
    const ids = [...new Set(visibleRows().map((r) => r.id))].filter((id) => !playheads.has(id));
    if (!ids.length) return;
    if (phBusy) { phQueued = true; return; }
    phBusy = true;
    loadPlayheads(ids)
      .catch((err) => { playheadsError = (err && err.message) || String(err); })
      .finally(() => { phBusy = false; render(); if (phQueued) { phQueued = false; ensurePlayheads(); } });
  };
  const progressOf = (r) => {
    const ph = playheads.get(r.id);
    if (!ph) return null;
    if (ph.fullyWatched) return { pct: 100, done: true };
    if (!(ph.playhead > 0)) return null;
    const pct = r.duration ? Math.min(100, Math.round((ph.playhead * 1000 / r.duration) * 100)) : 0;
    return pct > 0 ? { pct, done: false } : null;
  };

  /* ------------------------------------------------------------------ */
  /* Preferences                                                         */
  /* ------------------------------------------------------------------ */
  const defaultPrefs = () => ({ subs: true, dubs: {}, freeOnly: false, hideCatalog: false, hideMature: false, hideWatched: false });
  const loadPrefs = () => {
    try { return Object.assign(defaultPrefs(), JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { return defaultPrefs(); }
  };
  const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } };

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  const state = {
    open: false,
    openedAt: 0,
    pushed: false,          // we pushed /simulcastcalendar onto history ourselves
    weekStart: mondayOf(new Date()),
    rows: [],
    loading: false,
    progress: 0,
    complete: true,
    error: null,
    prefs: loadPrefs()
  };

  /* ------------------------------------------------------------------ */
  /* Styles                                                              */
  /* ------------------------------------------------------------------ */
  const CSS = `
    :host { display: block; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; inset: 0; z-index: 2147483647; background: #0e0f12; color: #e8e9ec;
      font: 14px/1.4 Lato, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: auto; }
    a { color: inherit; text-decoration: none; }
    a:hover { text-decoration: underline; }
    button { font: inherit; }
    .top { position: sticky; top: 0; z-index: 2; background: #141519; border-bottom: 1px solid #262930; }
    .bar { display: flex; align-items: center; gap: 12px; padding: 12px 20px; flex-wrap: wrap; }
    .brand { display: flex; align-items: baseline; gap: 8px; margin-right: auto; }
    .brand h1 { font-size: 18px; font-weight: 700; margin: 0; }
    .brand small { color: #9aa0a6; font-size: 12px; }
    .nav { display: flex; align-items: center; gap: 6px; }
    .btn { background: #23252b; color: #e8e9ec; border: 1px solid #33363e; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
    .btn:hover { background: #2c2f36; }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.accent { background: #f47521; border-color: #f47521; color: #111; font-weight: 700; }
    .btn.accent:hover { background: #ff8a3d; }
    .btn.icon { padding: 6px 9px; }
    .range { font-weight: 700; min-width: 170px; text-align: center; }
    .filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 20px 12px; }
    .filters .label { color: #9aa0a6; font-size: 12px; margin-right: 4px; }
    .chip { background: #1c1e24; color: #c9ccd1; border: 1px solid #33363e; border-radius: 999px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
    .chip.on { background: #2b1b10; border-color: #f47521; color: #ffb27d; }
    .chip .n { opacity: .6; margin-left: 4px; }
    .chip.quiet { border-style: dashed; }
    .sep { width: 1px; height: 18px; background: #33363e; margin: 0 4px; }
    .grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; padding: 16px 20px 40px; }
    @media (max-width: 1250px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    @media (max-width: 820px)  { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 520px)  { .grid { grid-template-columns: 1fr; } }
    .day { background: #15171c; border: 1px solid #262930; border-radius: 10px; min-height: 120px; display: flex; flex-direction: column; }
    .day.today { border-color: #f47521; box-shadow: 0 0 0 1px #f47521 inset; }
    .day.future { opacity: .7; }
    .dh { display: flex; align-items: baseline; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #262930; }
    .dh b { font-size: 15px; }
    .dh span { color: #9aa0a6; font-size: 12px; }
    .day.today .dh b { color: #f47521; }
    .list { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
    .empty { color: #6d737a; font-size: 13px; padding: 14px 12px; }
    .card { display: grid; grid-template-columns: 88px 1fr; gap: 10px; background: #1c1e24; border: 1px solid #2a2d35; border-radius: 8px; padding: 8px; }
    .card.upcoming { border-style: dashed; opacity: .8; }
    .card .th { position: relative; display: block; width: 88px; height: 50px; border-radius: 4px; overflow: hidden; background: #000; }
    .card img { width: 88px; height: 50px; object-fit: cover; display: block; }
    .card .pbar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; padding: 0; margin: 0; background: rgba(0,0,0,.65); }
    .card .pfill { height: 4px; background: #f47521; }
    .card .pfill.done { background: #9be29b; }
    .card .t { font-weight: 700; color: #fff; font-size: 13px; }
    .card .s { font-weight: 700; margin-top: 2px; }
    .card .e { color: #c9ccd1; font-size: 13px; }
    .card .meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .tag { font-size: 10.5px; letter-spacing: .02em; text-transform: uppercase; border-radius: 4px; padding: 1px 6px; background: #2a2d35; color: #c9ccd1; }
    .tag.sub { background: #1f2d1f; color: #9be29b; }
    .tag.dub { background: #1f2538; color: #a9bbff; }
    .tag.free { background: #23321f; color: #b6f0a1; }
    .tag.prem { background: #3a2410; color: #ffb27d; }
    .tag.cat { background: #33302a; color: #e2d1a6; }
    .tag.mature { background: #3a1f1f; color: #ff9c9c; }
    .tag.watched { background: #1f2d1f; color: #9be29b; }
    .tag.progress { background: #3a2410; color: #ffb27d; }
    .status { padding: 10px 20px; color: #9aa0a6; font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap; }
    .status .err { color: #ff8a80; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #555; border-top-color: #f47521; border-radius: 50%; animation: s 0.8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes s { to { transform: rotate(360deg); } }
    .foot { padding: 0 20px 30px; color: #6d737a; font-size: 12px; }
  `;

  /* ------------------------------------------------------------------ */
  /* UI                                                                  */
  /* ------------------------------------------------------------------ */
  let host = null, root = null, wrap = null, prevOverflow = null;

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v); // CSSOM, so a strict CSP can't block it
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };

  const ensureUI = () => {
    if (host) return;
    host = document.createElement('div');
    host.id = 'crcal-host';
    host.style.display = 'none';
    root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      root.append(h('style', { text: CSS }));
    }
    wrap = h('div', { class: 'wrap', role: 'dialog', 'aria-label': 'Release Calendar' });
    root.append(wrap);
    (document.body || document.documentElement).append(host);
  };

  const visibleRows = () => {
    const p = state.prefs;
    const ws = state.weekStart, we = addDays(ws, 7);
    return state.rows.filter((r) => {
      const when = p.freeOnly ? r.free : r.premium;
      if (!when || when < ws || when >= we) return false;
      if (r.original ? !p.subs : !p.dubs[r.audio]) return false;
      if (p.hideCatalog && r.catalog) return false;
      if (p.hideMature && r.mature) return false;
      if (p.hideWatched) { const ph = playheads.get(r.id); if (ph && ph.fullyWatched) return false; }
      return true;
    });
  };

  const render = () => {
    if (!wrap) return;
    const p = state.prefs;
    const now = new Date();
    const ws = state.weekStart, we = addDays(ws, 7);
    const thisMonday = mondayOf(now);
    const inWeek = state.rows.filter((r) => { const w = p.freeOnly ? r.free : r.premium; return w && w >= ws && w < we; });
    const rows = visibleRows();

    // audio chips: original-audio count + dub languages ordered by frequency
    const dubCounts = new Map();
    let subCount = 0;
    for (const r of inWeek) { if (r.original) subCount++; else dubCounts.set(r.audio, (dubCounts.get(r.audio) || 0) + 1); }
    const dubLangs = [...dubCounts.entries()].sort((a, b) => (a[0] === 'en-US' ? -1 : b[0] === 'en-US' ? 1 : b[1] - a[1]));

    const setPref = (fn) => { fn(p); savePrefs(p); render(); };

    const top = h('div', { class: 'top' },
      h('div', { class: 'bar' },
        h('div', { class: 'brand' }, h('h1', { text: 'Release Calendar' }), h('small', { text: 'unofficial · v' + VERSION })),
        h('div', { class: 'nav' },
          h('button', { class: 'btn', title: 'Previous week', onclick: () => gotoWeek(addDays(ws, -7)) }, '‹ Last week'),
          h('div', { class: 'range', text: `${fmtRange.format(ws)} – ${fmtRange.format(addDays(ws, 6))}, ${addDays(ws, 6).getFullYear()}` }),
          h('button', { class: 'btn', title: 'Next week', disabled: ws >= thisMonday, onclick: () => gotoWeek(addDays(ws, 7)) }, 'Next week ›'),
          h('button', { class: 'btn', disabled: sameDay(ws, thisMonday), onclick: () => gotoWeek(thisMonday) }, 'Today')
        ),
        h('button', { class: 'btn icon', title: 'Reload from Crunchyroll', onclick: () => refresh() }, '↻'),
        h('button', { class: 'btn icon', title: 'Close (Esc)', onclick: () => close() }, '✕')
      ),
      h('div', { class: 'filters' },
        h('span', { class: 'label', text: 'Audio' }),
        h('button', { class: 'chip' + (p.subs ? ' on' : ''), onclick: () => setPref((x) => { x.subs = !x.subs; }) }, 'Subtitled (original audio)', h('span', { class: 'n', text: String(subCount) })),
        dubLangs.map(([code, n]) => h('button', { class: 'chip' + (p.dubs[code] ? ' on' : ''), onclick: () => setPref((x) => { x.dubs[code] = !x.dubs[code]; }) }, `${audioName(code)} dub`, h('span', { class: 'n', text: String(n) }))),
        dubLangs.length ? h('button', { class: 'chip quiet', onclick: () => setPref((x) => { const all = dubLangs.every(([c]) => x.dubs[c]); dubLangs.forEach(([c]) => { x.dubs[c] = !all; }); }) }, dubLangs.every(([c]) => p.dubs[c]) ? 'No dubs' : 'All dubs') : null,
        h('span', { class: 'sep' }),
        h('button', { class: 'chip' + (p.freeOnly ? ' on' : ''), title: 'Show only episodes available to free accounts, placed on the day they became free', onclick: () => setPref((x) => { x.freeOnly = !x.freeOnly; }) }, 'Free episodes'),
        h('button', { class: 'chip' + (p.hideCatalog ? ' on' : ''), title: 'Hide older titles being added to the catalog (aired 6+ months before release)', onclick: () => setPref((x) => { x.hideCatalog = !x.hideCatalog; }) }, 'Hide catalog adds'),
        h('button', { class: 'chip' + (p.hideMature ? ' on' : ''), onclick: () => setPref((x) => { x.hideMature = !x.hideMature; }) }, 'Hide mature'),
        accountId ? h('button', { class: 'chip' + (p.hideWatched ? ' on' : ''), title: 'Hide episodes you have fully watched', onclick: () => setPref((x) => { x.hideWatched = !x.hideWatched; }) }, 'Hide watched') : null
      )
    );

    const status = h('div', { class: 'status' },
      state.loading ? h('span', {}, h('span', { class: 'spin' }), `Loading… (request ${state.progress})`) : null,
      state.error ? h('span', { class: 'err', text: state.error }) : null,
      !state.loading && !state.error ? h('span', { text: `${rows.length} of ${inWeek.length} releases this week shown` }) : null,
      !state.complete ? h('span', { class: 'err', text: 'Stopped early: this week is further back than the feed window this extension reads.' }) : null,
      playheadsError && accountId ? h('span', { class: 'err', text: `Watch progress unavailable (${playheadsError})` }) : null,
      // give the page a few seconds to make its first account-scoped call before concluding there is no session
      !state.loading && !accountId ? h('span', { text: Date.now() - state.openedAt > 8000 ? 'Watch progress needs a signed-in session' : 'Looking for your session for watch progress…' }) : null,
      h('span', { text: `Times in ${tzName}` })
    );

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i), dn = addDays(d, 1);
      const items = rows.filter((r) => { const w = p.freeOnly ? r.free : r.premium; return w >= d && w < dn; })
        .sort((a, b) => (p.freeOnly ? a.free - b.free : a.premium - b.premium) || a.series.localeCompare(b.series));
      const isToday = sameDay(d, now), isFuture = d > now;
      days.push(h('div', { class: 'day' + (isToday ? ' today' : '') + (isFuture ? ' future' : '') },
        h('div', { class: 'dh' }, h('b', { text: isToday ? 'Today' : fmtDayHead.format(d) }), h('span', { text: `${fmtMD.format(d)} · ${items.length}` })),
        items.length
          ? h('div', { class: 'list' }, items.map((r) => card(r, p.freeOnly ? r.free : r.premium, now)))
          : h('div', { class: 'empty', text: state.loading ? '…' : (isFuture ? 'Nothing scheduled yet' : 'Nothing released') })
      ));
    }

    wrap.replaceChildren(top, status, h('div', { class: 'grid' }, days),
      h('div', { class: 'foot', text: 'Data comes from Crunchyroll\'s own "newly added" feed, reusing the session this page already has. Not affiliated with Crunchyroll.' }));
    if (!state.loading) ensurePlayheads();
  };

  const card = (r, when, now) => {
    const watch = `/watch/${encodeURIComponent(r.id)}/${r.slug}`;
    const series = r.seriesId ? `/series/${encodeURIComponent(r.seriesId)}/${r.seriesSlug}` : null;
    const epLabel = [r.season ? `S${r.season}` : null, r.ep ? `Ep ${r.ep}` : null].filter(Boolean).join(' ');
    const prog = progressOf(r);
    return h('div', { class: 'card' + (when > now ? ' upcoming' : '') },
      h('a', { href: watch, class: 'th', title: prog ? (prog.done ? 'Watched' : `${prog.pct}% watched`) : null },
        r.thumb ? h('img', { src: r.thumb, loading: 'lazy', alt: '' }) : null,
        prog ? h('div', { class: 'pbar' }, h('div', { class: 'pfill' + (prog.done ? ' done' : ''), style: { width: prog.pct + '%' } })) : null
      ),
      h('div', {},
        h('div', { class: 't', text: fmtTime.format(when) + (when > now ? ' · upcoming' : '') }),
        h('div', { class: 's' }, series ? h('a', { href: series, text: r.series }) : r.series),
        h('div', { class: 'e' }, h('a', { href: watch, text: [epLabel, r.title].filter(Boolean).join(' · ') })),
        h('div', { class: 'meta' },
          r.original ? h('span', { class: 'tag sub', text: 'Sub' }) : h('span', { class: 'tag dub', text: audioName(r.audio) + ' dub' }),
          prog ? (prog.done ? h('span', { class: 'tag watched', text: 'Watched' }) : h('span', { class: 'tag progress', text: `${prog.pct}%` })) : null,
          r.free && r.free <= now ? h('span', { class: 'tag free', text: 'Free' }) : null,
          r.catalog && r.air ? h('span', { class: 'tag cat', text: 'Catalog · ' + r.air.getFullYear() }) : null,
          r.mature ? h('span', { class: 'tag mature', text: '18+' }) : null
        )
      )
    );
  };

  /* ------------------------------------------------------------------ */
  /* Loading / navigation                                                */
  /* ------------------------------------------------------------------ */
  let loadSeq = 0;
  const load = async () => {
    const seq = ++loadSeq;
    state.loading = true; state.error = null; state.progress = 0;
    render();
    // free dates can trail the premium date, so look a week further back in that mode
    const since = addDays(state.weekStart, state.prefs.freeOnly ? -7 : 0);
    try {
      const res = await loadSince(since, (n) => { if (seq === loadSeq) { state.progress = n; render(); } });
      if (seq !== loadSeq) return;
      state.rows = res.rows; state.complete = res.complete;
      try { sessionStorage.removeItem(RELOAD_FLAG); } catch (e) { /* ignore */ }
    } catch (err) {
      if (seq !== loadSeq) return;
      if (err && err.code === 401) {
        let reloaded = false;
        try { reloaded = !!sessionStorage.getItem(RELOAD_FLAG); } catch (e) { /* ignore */ }
        if (!reloaded) {
          try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch (e) { /* ignore */ }
          location.reload();
          return;
        }
      }
      state.error = (err && err.message) || String(err);
    } finally {
      if (seq === loadSeq) { state.loading = false; render(); }
    }
  };

  const syncUrl = () => {
    const date = sameDay(state.weekStart, mondayOf(new Date())) ? '' : `?date=${ymd(state.weekStart)}`;
    try {
      if (PATH_RE.test(location.pathname)) history.replaceState(history.state, '', location.pathname + date);
      else if (/^#crcal/.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search + '#crcal' + date);
    } catch (e) { /* ignore */ }
  };

  const gotoWeek = (monday) => {
    state.weekStart = mondayOf(monday);
    syncUrl();
    // only refetch when the cache doesn't already cover the week
    const since = addDays(state.weekStart, state.prefs.freeOnly ? -7 : 0);
    const oldest = state.rows.reduce((a, r) => (r.premium < a ? r.premium : a), new Date());
    if (oldest > since || !state.complete) load(); else render();
  };

  const dateFromUrl = () => {
    const q = PATH_RE.test(location.pathname) ? location.search : (location.hash.match(/^#crcal(\?.*)?$/) || [])[1] || '';
    const m = /(?:\?|&)date=(\d{4}-\d{2}-\d{2})/.exec(q);
    return m ? new Date(m[1] + 'T12:00:00') : null;
  };

  const refresh = () => { pageCache.clear(); playheads.clear(); playheadsError = null; load(); };

  const open = (opts = {}) => {
    ensureUI();
    const d = opts.date instanceof Date && !isNaN(opts.date) ? opts.date : new Date();
    state.weekStart = mondayOf(d);
    state.pushed = !!opts.pushed;
    if (!state.open) {
      state.open = true;
      state.openedAt = Date.now();
      prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      host.style.display = '';
      if (!accountId) setTimeout(() => { if (state.open && !accountId) render(); }, 8500); // flip the status line if still nothing
    }
    syncUrl();
    // progress may have changed since the last open (you watched something), so re-ask
    playheads.clear(); playheadsError = null;
    load();
  };
  // When the page's own code reveals (or changes) the account id while the calendar is
  // open, re-render: ensurePlayheads() then fetches progress for what is on screen.
  onAccountChange = () => { playheadsError = null; playheads.clear(); if (state.open && !state.loading) render(); };

  const hide = () => {
    if (!state.open) return;
    state.open = false;
    host.style.display = 'none';
    document.documentElement.style.overflow = prevOverflow || '';
  };

  const close = () => {
    if (!state.open) return;
    if (state.pushed) { hide(); history.back(); return; }
    // opened via the #crcal hash (redirect from rules.json): drop the hash, stay here
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    hide();
  };

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */
  // 1) Clicking any "Release Calendar" link opens the overlay in place.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    let u; try { u = new URL(a.getAttribute('href'), location.href); } catch (err) { return; }
    if (u.origin !== location.origin || !PATH_RE.test(u.pathname)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const date = u.searchParams.get('date');
    try { history.pushState({ crcal: true }, '', u.pathname + (date ? `?date=${date}` : '')); } catch (err) { /* ignore */ }
    open({ date: date ? new Date(date + 'T12:00:00') : null, pushed: true });
  }, true);

  // 2) Back/forward.
  window.addEventListener('popstate', () => {
    if (PATH_RE.test(location.pathname)) open({ date: dateFromUrl(), pushed: true });
    else if (/^#crcal/.test(location.hash)) open({ date: dateFromUrl(), pushed: false });
    else if (state.open) hide();
  });

  // 3) Esc closes.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) close(); }, true);

  // 4) Direct loads: /videos/new#crcal (from rules.json) or a bare /simulcastcalendar
  //    that somehow escaped the redirect.
  const boot = () => {
    if (/^#crcal/.test(location.hash)) open({ date: dateFromUrl(), pushed: false });
    else if (PATH_RE.test(location.pathname)) open({ date: dateFromUrl(), pushed: false });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__crcal = { version: VERSION, open: () => open({}), close, reload: refresh };
})();
