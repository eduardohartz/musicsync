/* musicsync panel — no-build vanilla SPA */
'use strict';

// ---------------------------------------------------------------- utilities
const $app = document.getElementById('app');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const icon = (name, cls = 'icon') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
};
const logoMark = (size = 26, cls = '') => {
  const svg = icon('logo-mark', cls);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.classList.add('mark');
  return svg;
};

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    state.authed = false;
    render();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `request failed (${res.status})`), { data });
  return data;
}

const fmtRel = (iso) => {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const fmtNext = (iso) => {
  if (!iso) return null;
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s <= 0) return 'due now';
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleString();
};
const PLATFORM_LABEL = { spotify: 'Spotify', tidal: 'TIDAL' };

// ---------------------------------------------------------------- state
const state = {
  authed: false,
  authDisabled: false,
  overview: null,
  settings: null,
  settingsDraft: null, // survives re-renders; cleared on save
  unmatchedOpen: false,
  bootError: null,
  playlistCache: {},
  pollTimer: null,
  lastRoute: null,
};

const WIZ_KEY = 'musicsync-wizard';
const wizDefault = () => ({
  step: 1,
  creds: { spotify: { clientId: '', clientSecret: '' }, tidal: { clientId: '', clientSecret: '' } },
  mode: 'one-way',
  source: 'spotify',
  all: false,
  picks: [],
  preset: '6h',
  cron: '0 */6 * * *',
  periodic: true,
  runNow: true,
  likedSongs: false,
  likedName: 'Spotify Liked Songs',
  manualUrl: '',
  manualOpen: false,
});
const loadWiz = () => {
  try {
    return { ...wizDefault(), ...JSON.parse(localStorage.getItem(WIZ_KEY) || '{}') };
  } catch {
    return wizDefault();
  }
};
const saveWiz = (w) => localStorage.setItem(WIZ_KEY, JSON.stringify(w));
let wiz = loadWiz();

// ---------------------------------------------------------------- data flow
async function refreshOverview() {
  state.overview = await api('/api/overview');
  return state.overview;
}
async function refreshSettings() {
  state.settings = await api('/api/settings');
  return state.settings;
}

const isEditing = () =>
  document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.authed) return;
  const busy = state.overview?.syncing || (location.hash === '#/setup' && wiz.step === 2);
  state.pollTimer = setTimeout(async () => {
    try {
      const before = JSON.stringify(state.overview);
      await refreshOverview();
      // Re-render only when data actually changed, and never while the user
      // is mid-keystroke in a form control — a repaint would eat the input.
      if (JSON.stringify(state.overview) !== before && !isEditing()) render();
      else schedulePoll();
    } catch { /* rendered by api() on 401 */ }
  }, busy ? 3500 : 20000);
}

// ---------------------------------------------------------------- views
function connectionDot(conn) {
  if (!conn.connected) return h('span', { class: 'dot err' });
  if (conn.warn) return h('span', { class: 'dot warn' });
  return h('span', { class: 'dot ok' });
}

function topbar(active) {
  const o = state.overview;
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, logoMark(26), 'musicsync'),
    h('nav', { class: 'topnav' },
      h('a', { href: '#/', class: active === 'dashboard' ? 'active' : '' }, icon('i-home'), 'Dashboard'),
      h('a', { href: '#/settings', class: active === 'settings' ? 'active' : '' }, icon('i-settings'), 'Settings'),
    ),
    h('div', { class: 'spacer' }),
    o?.syncing
      ? h('button', { class: 'btn', disabled: true }, logoMark(16, 'spin'), 'Syncing…')
      : h('button', {
        class: 'btn primary', onclick: async () => {
          try {
            await api('/api/sync', { method: 'POST' });
            toast('Sync started', 'ok');
            await refreshOverview();
            render();
          } catch (err) { toast(err.message, 'err'); }
        },
      }, icon('i-refresh'), 'Sync now'),
    !state.authDisabled && h('button', {
      class: 'btn ghost icon-only', title: 'Log out',
      onclick: async () => { await api('/api/logout', { method: 'POST' }); state.authed = false; render(); },
    }, icon('i-logout')),
  );
}

// ---- login ----
function loginView() {
  const input = h('input', { type: 'password', placeholder: 'Panel password', autofocus: true, 'aria-label': 'Panel password' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { password: input.value } });
      state.authed = true;
      await boot(false);
    } catch (err) {
      toast(err.message === 'unauthorized' ? 'Wrong password' : err.message, 'err');
      input.value = '';
      input.focus();
    }
  };
  return h('div', { class: 'login' },
    h('div', { class: 'card' },
      logoMark(52),
      h('h1', {}, 'musicsync'),
      h('p', { class: 'muted' }, 'Enter the panel password to continue.'),
      h('form', { onsubmit: submit },
        h('label', { class: 'field' }, input),
        h('button', { class: 'btn primary', style: 'width:100%' }, 'Log in'),
      ),
    ),
  );
}

// ---- dashboard ----
function connCard(platform) {
  const conn = state.overview.connections[platform];
  const bits = [];
  if (!conn.connected) {
    bits.push(h('p', { class: 'small muted' }, 'Not connected'));
    bits.push(h('a', { class: 'btn', href: `/auth/${platform}` }, 'Connect'));
  } else {
    if (platform === 'spotify' && conn.daysLeft !== null && conn.daysLeft !== undefined) {
      bits.push(h('p', { class: conn.warn ? 'small' : 'small muted', style: conn.warn ? 'color:var(--warn)' : '' },
        `Authorization renews in ${conn.daysLeft} days`, conn.warn ? ' — reconnect soon' : ''));
    } else {
      bits.push(h('p', { class: 'small muted' }, 'Connected'));
    }
    // Always offer re-auth: fixes expired/revoked tokens and grants newly
    // required permissions (e.g. Liked Songs needs the library scope).
    bits.push(h('a', {
      class: conn.warn ? 'btn' : 'btn ghost',
      href: `/auth/${platform}`,
      title: 'Re-authorize this account — use after permission changes (like enabling Liked Songs) or when access expires',
    }, icon('i-refresh'), 'Reconnect'));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'conn' }, connectionDot(conn), h('span', { class: 'name' }, PLATFORM_LABEL[platform])),
    ...bits,
  );
}

function scheduleCard() {
  const o = state.overview;
  const modeLabel = o.mode === 'two-way'
    ? 'Two-way sync'
    : `One-way · ${PLATFORM_LABEL[o.source] ?? '?'} → ${PLATFORM_LABEL[o.source === 'spotify' ? 'tidal' : 'spotify']}`;
  return h('div', { class: 'card' },
    h('div', { class: 'eyebrow' }, 'schedule'),
    h('h3', { style: 'margin:6px 0 2px' }, o.periodic ? (fmtNext(o.nextRun) ? `Next sync ${fmtNext(o.nextRun)}` : 'Scheduled') : 'Manual only'),
    h('p', { class: 'small muted' }, modeLabel, o.dryRun ? ' · dry-run' : ''),
  );
}

/**
 * One dashboard entry per playlist, merged from three sources so every
 * selected playlist is visible from the moment setup finishes:
 *   configured selection (names from the wizard) <- state pairs (history)
 *   <- live run overlay (queued / syncing with growing counts).
 */
function buildPairList(o) {
  const map = new Map();
  for (const p of o.configuredList ?? []) {
    map.set(p.primaryId, { primaryId: p.primaryId, name: p.name ?? null });
  }
  for (const p of o.pairs) {
    const existing = map.get(p.primaryId) ?? { primaryId: p.primaryId };
    map.set(p.primaryId, { ...existing, ...p, name: p.name ?? existing.name ?? null });
  }
  if (o.likedSongs?.enabled) {
    const id = 'spotify-liked-songs';
    const existing = map.get(id) ?? { primaryId: id };
    map.set(id, { ...existing, name: o.likedSongs.name ?? existing.name ?? 'Spotify Liked Songs', liked: true });
  }
  for (const lp of o.liveSync?.pairs ?? []) {
    const existing = map.get(lp.primaryId) ?? { primaryId: lp.primaryId };
    map.set(lp.primaryId, { ...existing, name: lp.name ?? existing.name ?? null, live: lp });
  }
  return [...map.values()];
}

function progressCells(matched, total, unmatched, { done = true, status = 'synced' } = {}) {
  const pct = !total ? (done ? 100 : 0) : Math.min(100, Math.round((matched / total) * 100));
  const progress = h('div', { class: 'progresswrap' },
    h('span', { class: 'small num' }, `${matched} / ${total ?? '\u2026'}`),
    h('div', { class: 'bar', role: 'img', 'aria-label': `${matched} of ${total ?? 'unknown'} tracks synced` },
      h('i', { class: done && pct === 100 ? 'full' : '', style: `width:${pct}%` })),
  );
  let chip;
  if (!done) chip = h('span', { class: 'chip' }, logoMark(12, 'spin'), ' syncing');
  else if (unmatched > 0) chip = h('span', { class: 'chip err num' }, `${unmatched} unmatched`);
  else chip = h('span', { class: 'chip' }, status === 'dry-run' ? 'dry-run' : 'in sync');
  return { progress, chip };
}

function pairRow(pair) {
  const live = pair.live;
  const r = pair.lastResult;
  const liked = pair.liked || pair.primaryId === 'spotify-liked-songs';
  const dir = state.overview.mode === 'two-way' && !liked ? icon('i-both') : icon('i-arrow');
  let progress = h('span', { class: 'small muted' }, 'not synced yet');
  let chip = null;
  let when = fmtRel(pair.lastSyncedAt);

  if (live?.status === 'queued') {
    chip = h('span', { class: 'chip' }, 'queued');
    progress = h('span', { class: 'small muted' }, 'waiting\u2026');
  } else if (live?.status === 'syncing') {
    ({ progress, chip } = progressCells(live.matched, live.total, live.unmatched, { done: false }));
    when = 'now';
  } else if (live?.status === 'failed') {
    chip = h('span', { class: 'chip err', title: r?.error ?? '' }, 'failed');
    progress = h('span', { class: 'small muted' }, 'see logs');
  } else if (live && live.status !== 'skipped') {
    // Finished earlier in the still-running batch — show its fresh result.
    ({ progress, chip } = progressCells(live.matched, live.total, live.unmatched, { status: live.status }));
    when = 'just now';
  } else if (r?.status === 'failed') {
    chip = h('span', { class: 'chip err', title: r.error ?? '' }, 'failed');
    progress = h('span', { class: 'small muted' }, 'see logs');
  } else if (r) {
    ({ progress, chip } = progressCells(r.matched, r.total || 0, r.unmatched, { status: r.status }));
  }

  return h('div', { class: 'row' },
    h('div', { class: 'title' }, icon(liked ? 'i-heart' : 'i-music'), h('span', { class: 'nm' }, pair.name ?? pair.primaryId), dir),
    progress,
    h('div', {}, chip, h('div', { class: 'small muted', style: 'text-align:right' }, when)),
  );
}

function unmatchedSection() {
  const wrap = h('div', { class: 'card' });
  const body = h('div', {}, h('p', { class: 'small muted' }, 'Loading…'));
  async function load() {
    try {
      const report = await api('/api/unmatched');
      const rows = report.unmatched.length === 0
        ? [h('p', { class: 'small muted' }, 'Nothing here — every track found a home.')]
        : report.unmatched.map((u) => h('div', { class: 'unmatched-item' },
          h('div', {},
            h('div', {}, u.title ?? u.trackId),
            h('div', { class: 'small muted' }, (u.artists ?? []).join(', '), u.playlist ? ` · ${u.playlist}` : '')),
          h('span', { class: 'chip' }, u.reason ?? 'unmatched'),
        ));
      body.replaceChildren(...rows);
    } catch (err) { body.replaceChildren(h('p', { class: 'small muted' }, err.message)); }
  }
  const details = h('details', { class: 'unmatched', open: state.unmatchedOpen, ontoggle: () => {
    state.unmatchedOpen = details.open; // survive poll re-renders
    if (details.open) load();
  } },
  h('summary', {}, `Unmatched tracks (${state.overview.unmatchedTotal})`), body);
  // Rebuilt on every poll render, so an open list refreshes live mid-sync.
  if (state.unmatchedOpen) load();
  wrap.append(details);
  return wrap;
}

function dashboardView() {
  const o = state.overview;
  const banners = [];
  if (o.phase === 'auth_required') {
    banners.push(h('div', { class: 'banner err' }, icon('i-alert'),
      h('span', {}, 'Authorization expired — reconnect the affected account below, syncs are paused.')));
  }
  if (o.lastRunError) {
    banners.push(h('div', { class: 'banner err' }, icon('i-alert'), h('span', {}, `Last run failed: ${o.lastRunError}`)));
  }
  const pairs = buildPairList(o);
  const container = h('div', { class: 'shell' },
    topbar('dashboard'),
    ...banners,
    h('div', { class: 'cardgrid' }, connCard('spotify'), connCard('tidal'), scheduleCard()),
    h('div', { class: 'sectionhead' },
      h('h2', {}, 'Playlists'),
      h('span', { class: 'small muted num' },
        o.configuredPairs === 'all' ? 'syncing all playlists' : `${o.configuredPairs} configured`),
    ),
    h('div', { class: 'card' },
      pairs.length === 0
        ? h('p', { class: 'muted', style: 'padding:8px 0' },
          o.configuredPairs === 'all'
            ? 'Playlists appear here when the first sync starts.'
            : 'No playlists selected yet.')
        : h('div', { class: 'rows' }, pairs.map(pairRow)),
    ),
    unmatchedSection(),
  );
  return container;
}

// ---- wizard ----
const PRESETS = [
  ['15m', 'Every 15 minutes', '*/15 * * * *'],
  ['1h', 'Every hour', '0 * * * *'],
  ['6h', 'Every 6 hours', '0 */6 * * *'],
  ['daily', 'Once a day (4:00)', '0 4 * * *'],
  ['custom', 'Custom cron expression', null],
  ['manual', 'No schedule — I’ll sync manually', null],
];

function wizardShell(stepNo, content, footer) {
  const steps = [];
  for (let i = 1; i <= 5; i++) {
    steps.push(h('div', { class: `step ${i < stepNo ? 'done' : i === stepNo ? 'now' : ''}` },
      i < stepNo ? icon('i-check') : String(i)));
    if (i < 5) steps.push(h('div', { class: `rail ${i < stepNo ? 'done' : ''}` }));
  }
  return h('div', { class: 'wizard' },
    h('div', { style: 'display:flex;justify-content:center;margin-bottom:18px' }, logoMark(44)),
    h('div', { class: 'card' }, h('div', { class: 'steps' }, ...steps), content, footer),
  );
}

// Inputs update wiz state WITHOUT re-rendering (a repaint would eat focus),
// so the Next button recomputes its own disabled state via updateWizNext().
let wizNextRef = { btn: null, compute: null };
const updateWizNext = () => {
  if (wizNextRef.btn && wizNextRef.compute) wizNextRef.btn.disabled = Boolean(wizNextRef.compute());
};

function wizNav({ back = true, nextLabel = 'Continue', nextDisabled = false, computeDisabled = null, onNext }) {
  const btn = h('button', {
    class: 'btn primary',
    disabled: computeDisabled ? Boolean(computeDisabled()) : nextDisabled,
    onclick: onNext,
  }, nextLabel, icon('i-arrow'));
  wizNextRef = { btn, compute: computeDisabled };
  return h('div', { class: 'wizfoot' },
    back
      ? h('button', { class: 'btn ghost', onclick: () => { wiz.step -= 1; saveWiz(wiz); render(); } }, 'Back')
      : h('span'),
    btn,
  );
}

function credsFields(platform, uri) {
  const c = wiz.creds[platform];
  // ENV-seeded or previously saved credentials pre-fill the wizard, so a
  // pre-provisioned install (or a resumed session) isn't blocked on retyping.
  if (!c.clientId && state.settings?.[platform]?.clientId) c.clientId = state.settings[platform].clientId;
  return h('div', {},
    h('h3', { style: 'margin:14px 0 8px' }, PLATFORM_LABEL[platform]),
    h('div', { class: 'formrow' },
      h('label', { class: 'field' }, h('span', {}, 'Client ID'),
        h('input', { type: 'text', value: c.clientId, oninput: (e) => { c.clientId = e.target.value.trim(); saveWiz(wiz); updateWizNext(); } })),
      h('label', { class: 'field' }, h('span', {}, 'Client secret'),
        h('input', { type: 'password', value: c.clientSecret, oninput: (e) => { c.clientSecret = e.target.value.trim(); saveWiz(wiz); updateWizNext(); } })),
    ),
    h('div', { class: 'small muted' }, 'Redirect URI to add in the app settings:'),
    h('div', { class: 'codebox' }, uri,
      h('button', { class: 'btn ghost icon-only', title: 'Copy', onclick: async (e) => {
        await navigator.clipboard.writeText(uri);
        toast('Copied', 'ok');
        e.preventDefault();
      } }, icon('i-copy'))),
  );
}

function wizStep1() {
  const uris = state.settings?.redirectUris ?? { spotify: '…', tidal: '…' };
  const filled = () => ['spotify', 'tidal'].every((p) => (wiz.creds[p].clientId || state.settings?.[p]?.clientId)
    && (wiz.creds[p].clientSecret || state.settings?.[p]?.clientSecretSet));
  return wizardShell(1,
    h('div', {},
      h('h1', {}, 'Welcome'),
      h('p', { class: 'lead' },
        'musicsync keeps playlists in step between Spotify and TIDAL. First, it needs API credentials — create one app on each platform (free, ~5 minutes) and paste the keys here. ',
        h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noreferrer' }, 'Spotify dashboard'), ' · ',
        h('a', { href: 'https://developer.tidal.com/dashboard', target: '_blank', rel: 'noreferrer' }, 'TIDAL dashboard')),
      credsFields('spotify', uris.spotify),
      h('p', { class: 'small muted', style: 'margin-top:4px' },
        'Heads-up: Spotify requires the app owner to have Premium, and TIDAL needs the scopes playlists.read, playlists.write and user.read enabled.'),
      credsFields('tidal', uris.tidal),
    ),
    wizNav({
      back: false,
      computeDisabled: () => !filled(),
      onNext: async () => {
        try {
          await api('/api/settings', { method: 'PUT', body: {
            spotify: { clientId: wiz.creds.spotify.clientId, clientSecret: wiz.creds.spotify.clientSecret },
            tidal: { clientId: wiz.creds.tidal.clientId, clientSecret: wiz.creds.tidal.clientSecret },
          } });
          wiz.step = 2;
          saveWiz(wiz);
          await refreshOverview();
          render();
        } catch (err) { toast(err.data?.problems?.join('; ') ?? err.message, 'err'); }
      },
    }));
}

function wizStep2() {
  const conns = state.overview.connections;
  const card = (platform) => {
    const c = conns[platform];
    return h('div', { class: `platformcard ${c.connected ? 'connected' : ''}` },
      h('div', { class: 'conn' }, connectionDot(c), h('span', { class: 'name' }, PLATFORM_LABEL[platform])),
      c.connected
        ? h('span', { class: 'small', style: 'color:var(--ok);display:flex;align-items:center;gap:5px' }, icon('i-check'), 'Connected')
        : h('a', { class: 'btn primary', href: `/auth/${platform}` }, 'Connect'),
    );
  };
  // Persisted in wiz so the 3.5s connect-status poll can't wipe a pasted URL.
  const manualInput = h('input', {
    type: 'text',
    placeholder: 'http://127.0.0.1:…/callback/…?code=…',
    value: wiz.manualUrl,
    oninput: (e) => { wiz.manualUrl = e.target.value; saveWiz(wiz); },
  });
  const both = conns.spotify.connected && conns.tidal.connected;
  return wizardShell(2,
    h('div', {},
      h('h1', {}, 'Connect your accounts'),
      h('p', { class: 'lead' }, 'Approve access on both platforms. You’ll be sent back here after each one.'),
      h('div', { class: 'connectpair' }, card('spotify'), h('div', { class: 'loop' }, logoMark(26)), card('tidal')),
      h('details', { class: 'small', open: wiz.manualOpen, ontoggle: (e) => { wiz.manualOpen = e.target.open; saveWiz(wiz); } },
        h('summary', { class: 'muted' }, 'Browser can’t reach this server? Paste the redirect URL instead'),
        h('div', { style: 'display:flex;gap:8px;margin-top:8px' },
          manualInput,
          h('button', { class: 'btn', onclick: async () => {
            try {
              const res = await api('/api/auth/manual', { method: 'POST', body: { url: manualInput.value } });
              toast(`${PLATFORM_LABEL[res.platform]} connected`, 'ok');
              wiz.manualUrl = '';
              saveWiz(wiz);
              await refreshOverview();
              render();
            } catch (err) { toast(err.message, 'err'); }
          } }, 'Submit')),
      ),
    ),
    wizNav({ nextDisabled: !both, onNext: () => { wiz.step = 3; saveWiz(wiz); render(); } }));
}

function wizStep3() {
  const radio = (value, title, desc, extra) => h('label', { class: `radioline ${wiz.mode === value ? 'selected' : ''}` },
    h('input', { type: 'radio', name: 'mode', checked: wiz.mode === value, onchange: () => { wiz.mode = value; saveWiz(wiz); render(); } }),
    h('div', {}, h('div', { style: 'font-weight:560' }, title), h('div', { class: 'small muted' }, desc), extra ?? null));
  const sourceSelect = h('div', { style: 'margin-top:8px' },
    h('label', { class: 'field' }, h('span', {}, 'Source of truth'),
      h('select', { onchange: (e) => { wiz.source = e.target.value; saveWiz(wiz); } },
        h('option', { value: 'spotify', selected: wiz.source === 'spotify' }, 'Spotify → TIDAL'),
        h('option', { value: 'tidal', selected: wiz.source === 'tidal' }, 'TIDAL → Spotify'))));
  return wizardShell(3,
    h('div', {},
      h('h1', {}, 'How should syncing work?'),
      h('p', { class: 'lead' }, 'You can change this later in Settings.'),
      radio('one-way', 'One-way mirror',
        'One platform is the source of truth; musicsync keeps an exact, ordered copy on the other. Edits to the mirror are overwritten.',
        wiz.mode === 'one-way' ? sourceSelect : null),
      radio('two-way', 'Two-way sync',
        'Add or remove a track on either platform and it happens on the other too. Track sets stay equal; each platform keeps its own ordering.'),
    ),
    wizNav({ onNext: () => { wiz.step = 4; saveWiz(wiz); render(); } }));
}

function wizStep4() {
  const platform = wiz.mode === 'two-way' ? 'spotify' : wiz.source;
  const listBox = h('div', { class: 'listpick' }, h('p', { class: 'small muted' }, 'Loading playlists…'));
  if (!wiz.all) {
    api(`/api/playlists/${platform}`).then(({ playlists }) => {
      listBox.replaceChildren(
        playlists.length === 0 ? h('p', { class: 'small muted' }, 'No playlists found on this account.') : '',
        ...playlists.map((p) => h('label', { class: 'checkline' },
          h('input', {
            type: 'checkbox',
            checked: wiz.picks.some((x) => x.primaryId === p.id),
            onchange: (e) => {
              if (e.target.checked) wiz.picks.push({ primaryId: p.id, secondaryId: null, name: p.name });
              else wiz.picks = wiz.picks.filter((x) => x.primaryId !== p.id);
              saveWiz(wiz);
              updateWizNext();
            },
          }),
          h('span', {}, p.name),
          p.count !== null && h('span', { class: 'small muted num' }, `${p.count} tracks`),
        )),
      );
    }).catch((err) => listBox.replaceChildren(h('p', { class: 'small muted' }, err.message)));
  }
  return wizardShell(4,
    h('div', {},
      h('h1', {}, 'Pick playlists'),
      h('p', { class: 'lead' },
        wiz.mode === 'two-way'
          ? 'Choose the Spotify playlists to link. A linked TIDAL playlist is created (or reused) for each.'
          : `Choose which ${PLATFORM_LABEL[platform]} playlists to mirror.`),
      h('label', { class: 'checkline' },
        h('input', { type: 'checkbox', checked: wiz.all, onchange: (e) => { wiz.all = e.target.checked; saveWiz(wiz); render(); } }),
        h('span', {}, `All playlists owned by the ${PLATFORM_LABEL[platform]} account (including future ones)`)),
      wiz.all ? null : listBox,
      h('div', { style: 'margin-top:14px;border-top:1px solid var(--border);padding-top:10px' },
        h('label', { class: 'checkline' },
          h('input', { type: 'checkbox', checked: wiz.likedSongs, onchange: (e) => { wiz.likedSongs = e.target.checked; saveWiz(wiz); render(); } }),
          h('span', {}, 'Also sync your Spotify Liked Songs to a TIDAL playlist')),
        wiz.likedSongs ? h('label', { class: 'field', style: 'margin-top:6px' },
          h('span', {}, 'TIDAL playlist name'),
          h('input', { type: 'text', value: wiz.likedName, oninput: (e) => { wiz.likedName = e.target.value; saveWiz(wiz); } })) : null,
      ),
    ),
    wizNav({
      computeDisabled: () => !wiz.all && wiz.picks.length === 0 && !wiz.likedSongs,
      onNext: () => { wiz.step = 5; saveWiz(wiz); render(); },
    }));
}

function wizStep5() {
  const cronInput = h('input', { type: 'text', value: wiz.cron, oninput: (e) => { wiz.cron = e.target.value; saveWiz(wiz); } });
  const rows = PRESETS.map(([key, title, cron]) => h('label', { class: `radioline ${wiz.preset === key ? 'selected' : ''}` },
    h('input', { type: 'radio', name: 'sched', checked: wiz.preset === key, onchange: () => {
      wiz.preset = key;
      wiz.periodic = key !== 'manual';
      if (cron) wiz.cron = cron;
      saveWiz(wiz);
      render();
    } }),
    h('div', { style: 'flex:1' },
      h('div', { style: 'font-weight:560' }, title),
      key === 'custom' && wiz.preset === 'custom' ? h('div', { style: 'margin-top:6px' }, cronInput) : null,
      key === 'manual' ? h('div', { class: 'small muted' }, 'Run syncs from the dashboard whenever you like — nothing happens automatically.') : null,
    )));
  const runNow = h('label', { class: 'checkline', style: 'margin-top:14px' },
    h('input', { type: 'checkbox', checked: wiz.runNow, onchange: (e) => { wiz.runNow = e.target.checked; saveWiz(wiz); } }),
    h('span', {}, 'Run the first sync right away'));
  return wizardShell(5,
    h('div', {},
      h('h1', {}, 'When should it sync?'),
      h('p', { class: 'lead' }, 'Periodic syncing is optional — “manual only” is a perfectly good way to live.'),
      ...rows, runNow,
    ),
    wizNav({
      nextLabel: 'Finish setup',
      onNext: async () => {
        try {
          const ranNow = wiz.runNow;
          await api('/api/settings', { method: 'PUT', body: { sync: {
            mode: wiz.mode,
            source: wiz.mode === 'one-way' ? wiz.source : null,
            pairs: wiz.all ? 'all' : wiz.picks,
            likedSongs: wiz.likedSongs,
            likedSongsName: wiz.likedName.trim() || 'Spotify Liked Songs',
            periodic: wiz.periodic,
            cron: wiz.cron,
            onStart: wiz.periodic,
          } } });
          await api('/api/setup/complete', { method: 'POST', body: { runNow: ranNow } });
          localStorage.removeItem(WIZ_KEY);
          wiz = wizDefault();
          toast(ranNow ? 'Setup complete — first sync started' : 'Setup complete', 'ok');
          await refreshOverview();
          location.hash = '#/';
          render();
        } catch (err) { toast(err.data?.problems?.join('; ') ?? err.message, 'err'); }
      },
    }));
}

function setupView() {
  const steps = { 1: wizStep1, 2: wizStep2, 3: wizStep3, 4: wizStep4, 5: wizStep5 };
  return (steps[wiz.step] ?? wizStep1)();
}

// ---- settings ----
let pairsBeforeAll = null; // remembers the explicit selection while "all" is toggled on

function settingsPlaylistPicker(draft) {
  const platform = draft.sync.mode === 'two-way' ? 'spotify' : (draft.sync.source ?? 'spotify');
  const isAll = draft.sync.pairs === 'all';
  const picks = () => (Array.isArray(draft.sync.pairs) ? draft.sync.pairs : []);

  const listBox = h('div', { class: 'listpick' }, h('p', { class: 'small muted' }, 'Loading playlists…'));
  const fill = (playlists) => {
    listBox.replaceChildren(
      ...(playlists.length === 0 ? [h('p', { class: 'small muted' }, 'No playlists found on this account.')] : []),
      ...playlists.map((p) => h('label', { class: 'checkline' },
        h('input', {
          type: 'checkbox',
          checked: picks().some((x) => x.primaryId === p.id),
          onchange: (e) => {
            // secondaryId stays null: the engine reuses the counterpart it
            // already created for this playlist (tracked in state by id).
            const current = picks();
            draft.sync.pairs = e.target.checked
              ? [...current, { primaryId: p.id, secondaryId: null, name: p.name }]
              : current.filter((x) => x.primaryId !== p.id);
          },
        }),
        h('span', {}, p.name),
        p.count !== null && h('span', { class: 'small muted num' }, `${p.count} tracks`),
      )),
    );
  };
  if (!isAll) {
    const cached = state.playlistCache[platform];
    if (cached) fill(cached);
    else {
      api(`/api/playlists/${platform}`)
        .then(({ playlists }) => {
          state.playlistCache[platform] = playlists;
          fill(playlists);
        })
        .catch((err) => listBox.replaceChildren(h('p', { class: 'small muted' }, err.message)));
    }
  }

  return h('div', { style: 'margin-top:4px' },
    h('label', { class: 'field' }, h('span', {}, 'Playlists'),
      h('span', { class: 'hint' }, `Synced from the ${PLATFORM_LABEL[platform]} account. Unselecting stops syncing a playlist; already-created counterparts stay where they are.`)),
    h('label', { class: 'checkline' },
      h('input', {
        type: 'checkbox',
        checked: isAll,
        onchange: (e) => {
          if (e.target.checked) {
            pairsBeforeAll = picks();
            draft.sync.pairs = 'all';
          } else {
            draft.sync.pairs = pairsBeforeAll ?? [];
            pairsBeforeAll = null;
          }
          render();
        },
      }),
      h('span', {}, `All playlists owned by the ${PLATFORM_LABEL[platform]} account (including future ones)`)),
    isAll ? null : listBox,
  );
}

function settingsView() {
  const s = state.settings;
  if (!s) {
    refreshSettings().then(render).catch((err) => toast(err.message, 'err'));
    return h('div', { class: 'shell' }, topbar('settings'), h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading…')));
  }
  // The draft lives in module state so poll-triggered re-renders can't wipe
  // in-progress edits; it is rebuilt only after a successful save.
  state.settingsDraft ??= {
    spotify: { clientId: s.spotify.clientId, clientSecret: '', market: s.spotify.market, playlistPublic: s.spotify.playlistPublic },
    tidal: { clientId: s.tidal.clientId, clientSecret: '', accessType: s.tidal.accessType },
    // A two-way config has source=null; the select would silently DISPLAY
    // "Spotify" while committing null — default the draft to what is shown.
    sync: { ...s.sync, source: s.sync.source ?? 'spotify' },
    logLevel: s.logLevel,
  };
  const draft = state.settingsDraft;
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  const text = (get, set, type = 'text', placeholder = '') =>
    h('input', { type, value: get(), placeholder, oninput: (e) => set(e.target.value) });
  const check = (label, get, set) => h('label', { class: 'checkline' },
    h('input', { type: 'checkbox', checked: get(), onchange: (e) => set(e.target.checked) }), h('span', {}, label));

  return h('div', { class: 'shell' },
    topbar('settings'),
    h('h1', { style: 'margin-bottom:16px' }, 'Settings'),

    h('div', { class: 'card' },
      h('h2', { style: 'margin-bottom:12px' }, 'API credentials'),
      h('div', { class: 'formrow' },
        field('Spotify client ID', text(() => draft.spotify.clientId, (v) => { draft.spotify.clientId = v; })),
        field('Spotify client secret', text(() => draft.spotify.clientSecret, (v) => { draft.spotify.clientSecret = v; }, 'password', s.spotify.clientSecretSet ? '•••••• (saved — leave blank to keep)' : '')),
        field('TIDAL client ID', text(() => draft.tidal.clientId, (v) => { draft.tidal.clientId = v; })),
        field('TIDAL client secret', text(() => draft.tidal.clientSecret, (v) => { draft.tidal.clientSecret = v; }, 'password', s.tidal.clientSecretSet ? '•••••• (saved — leave blank to keep)' : '')),
      ),
      h('div', { class: 'small muted' }, 'Redirect URIs: ', h('code', {}, s.redirectUris.spotify), ' · ', h('code', {}, s.redirectUris.tidal)),
    ),

    h('div', { class: 'card' },
      h('h2', { style: 'margin-bottom:12px' }, 'Sync'),
      h('div', { class: 'formrow' },
        field('Mode', h('select', { onchange: (e) => { draft.sync.mode = e.target.value; render(); } },
          h('option', { value: 'one-way', selected: draft.sync.mode === 'one-way' }, 'One-way mirror'),
          h('option', { value: 'two-way', selected: draft.sync.mode === 'two-way' }, 'Two-way sync'))),
        field('Source (one-way)', h('select', { onchange: (e) => { draft.sync.source = e.target.value; render(); } },
          h('option', { value: 'spotify', selected: draft.sync.source === 'spotify' }, 'Spotify → TIDAL'),
          h('option', { value: 'tidal', selected: draft.sync.source === 'tidal' }, 'TIDAL → Spotify'))),
        field('Schedule (cron)', text(() => draft.sync.cron, (v) => { draft.sync.cron = v; }), 'Only used while periodic sync is on'),
      ),
      settingsPlaylistPicker(draft),
      check('Periodic sync', () => draft.sync.periodic, (v) => { draft.sync.periodic = v; }),
      check('Sync when the service starts', () => draft.sync.onStart, (v) => { draft.sync.onStart = v; }),
      check('Dry-run (log changes, write nothing)', () => draft.sync.dryRun, (v) => { draft.sync.dryRun = v; }),
      check('Sync Spotify Liked Songs to TIDAL', () => Boolean(draft.sync.likedSongs), (v) => { draft.sync.likedSongs = v; render(); }),
      draft.sync.likedSongs ? h('div', { style: 'max-width:340px;margin-left:24px' },
        field('Liked Songs playlist name',
          text(() => draft.sync.likedSongsName ?? 'Spotify Liked Songs', (v) => { draft.sync.likedSongsName = v; }),
          'Renames the TIDAL playlist on the next sync. If Spotify was connected before enabling this, reconnect it once — Liked Songs need an extra permission.')) : null,
    ),

    h('div', { class: 'card' },
      h('h2', { style: 'margin-bottom:12px' }, 'Advanced'),
      h('div', { class: 'formrow' },
        field('Spotify market', text(() => draft.spotify.market, (v) => { draft.spotify.market = v.toUpperCase(); }), 'Country code used for track search'),
        field('New TIDAL playlists', h('select', { onchange: (e) => { draft.tidal.accessType = e.target.value; } },
          h('option', { value: 'UNLISTED', selected: draft.tidal.accessType === 'UNLISTED' }, 'Unlisted'),
          h('option', { value: 'PUBLIC', selected: draft.tidal.accessType === 'PUBLIC' }, 'Public')),
        'TIDAL has no private playlists'),
        field('Log level', h('select', { onchange: (e) => { draft.logLevel = e.target.value; } },
          ...['debug', 'info', 'warn', 'error'].map((l) => h('option', { value: l, selected: draft.logLevel === l }, l)))),
      ),
      check('Create Spotify playlists as public', () => draft.spotify.playlistPublic, (v) => { draft.spotify.playlistPublic = v; }),
    ),

    h('div', { class: 'savebar' },
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api('/api/settings', { method: 'PUT', body: draft });
          state.settingsDraft = null; // rebuild from saved state next render
          toast('Settings saved and applied', 'ok');
          await Promise.all([refreshSettings(), refreshOverview()]);
          render();
        } catch (err) { toast(err.data?.problems?.join('; ') ?? err.message, 'err'); }
      } }, 'Save changes'),
      h('button', { class: 'btn ghost', onclick: () => {
        wiz = wizDefault();
        wiz.step = 3; // accounts stay connected; jump to mode/playlists
        saveWiz(wiz);
        location.hash = '#/setup';
        render();
      } }, 'Re-run setup wizard'),
    ),
  );
}

// ---------------------------------------------------------------- routing
function errorView(message) {
  return h('div', { class: 'login' },
    h('div', { class: 'card' },
      logoMark(52),
      h('h1', {}, 'Can’t reach musicsync'),
      h('p', { class: 'muted', style: 'margin-bottom:18px' }, message),
      h('button', { class: 'btn primary', style: 'width:100%', onclick: () => boot() }, 'Retry'),
    ),
  );
}

function render() {
  clearTimeout(state.pollTimer);
  if (state.bootError) {
    $app.replaceChildren(errorView(state.bootError));
    return;
  }
  if (!state.authed && !state.authDisabled) {
    $app.replaceChildren(loginView());
    return;
  }
  if (!state.overview) {
    $app.replaceChildren(h('div', { class: 'shell' }, h('p', { class: 'muted', style: 'padding:40px' }, 'Loading…')));
    return;
  }
  let view;
  let route;
  if (state.overview.needsSetup || location.hash === '#/setup') { view = setupView(); route = 'setup'; }
  else if (location.hash === '#/settings') { view = settingsView(); route = 'settings'; }
  else { view = dashboardView(); route = 'dashboard'; }
  $app.replaceChildren(view);
  // Route changes move focus to the new view's heading so keyboard and
  // screen-reader users aren't dropped at <body> after the DOM swap.
  if (route !== state.lastRoute && state.lastRoute !== null) {
    const heading = $app.querySelector('h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    }
  }
  state.lastRoute = route;
  schedulePoll();
}

window.addEventListener('hashchange', render);

async function boot(checkSession = true) {
  state.bootError = null;
  if (checkSession) {
    let session;
    try {
      session = await api('/api/session');
    } catch (err) {
      // A transient server error must not masquerade as "logged out".
      state.bootError = `The panel API did not respond (${err.message}).`;
      return render();
    }
    state.authed = session.authed || session.authDisabled;
    state.authDisabled = session.authDisabled;
    if (!state.authed) return render();
  } else {
    state.authed = true;
  }
  const params = new URLSearchParams(location.search);
  if (params.has('connected') || params.has('authError')) {
    if (params.has('connected')) toast(`${PLATFORM_LABEL[params.get('connected')] ?? params.get('connected')} connected`, 'ok');
    if (params.has('authError')) toast(params.get('authError'), 'err');
    history.replaceState(null, '', '/');
    if (localStorage.getItem(WIZ_KEY)) location.hash = '#/setup';
  }
  try {
    await Promise.all([refreshOverview(), refreshSettings().catch(() => {})]);
  } catch (err) {
    if (err.message !== 'unauthorized') {
      state.bootError = `Loading the dashboard failed (${err.message}).`;
    }
    return render();
  }
  render();
}

boot().catch((err) => {
  state.bootError = String(err.message ?? err);
  render();
});
