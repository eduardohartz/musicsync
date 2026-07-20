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
  playlistCache: {},
  pollTimer: null,
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

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.authed) return;
  const busy = state.overview?.syncing || (location.hash === '#/setup' && wiz.step === 2);
  state.pollTimer = setTimeout(async () => {
    try {
      await refreshOverview();
      render();
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
  } else if (platform === 'spotify' && conn.daysLeft !== null && conn.daysLeft !== undefined) {
    const cls = conn.warn ? 'small' : 'small muted';
    bits.push(h('p', { class: cls, style: conn.warn ? 'color:var(--warn)' : '' },
      `Authorization renews in ${conn.daysLeft} days`, conn.warn ? ' — reconnect soon' : ''));
    if (conn.warn) bits.push(h('a', { class: 'btn', href: `/auth/${platform}` }, 'Reconnect'));
  } else {
    bits.push(h('p', { class: 'small muted' }, 'Connected'));
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

function pairRow(pair) {
  const r = pair.lastResult;
  const dir = state.overview.mode === 'two-way' ? icon('i-both') : icon('i-arrow');
  let progress = h('span', { class: 'small muted' }, 'not synced yet');
  let chip = null;
  if (r && r.status !== 'failed') {
    const total = r.total || 0;
    const pct = total === 0 ? 100 : Math.round((r.matched / total) * 100);
    progress = h('div', { class: 'progresswrap' },
      h('span', { class: 'small num' }, `${r.matched} / ${total}`),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${r.matched} of ${total} tracks synced` },
        h('i', { class: pct === 100 ? 'full' : '', style: `width:${pct}%` })),
    );
    if (r.unmatched > 0) chip = h('span', { class: 'chip err num' }, `${r.unmatched} unmatched`);
    else chip = h('span', { class: 'chip' }, r.status === 'dry-run' ? 'dry-run' : 'in sync');
  } else if (r?.status === 'failed') {
    chip = h('span', { class: 'chip err' }, 'failed');
    progress = h('span', { class: 'small muted' }, 'see logs');
  }
  return h('div', { class: 'row' },
    h('div', { class: 'title' }, icon('i-music'), h('span', { class: 'nm' }, pair.name ?? pair.primaryId), dir),
    progress,
    h('div', {}, chip, h('div', { class: 'small muted', style: 'text-align:right' }, fmtRel(pair.lastSyncedAt))),
  );
}

async function unmatchedSection() {
  const wrap = h('div', { class: 'card' });
  const body = h('div', {}, h('p', { class: 'small muted' }, 'Loading…'));
  const details = h('details', { class: 'unmatched', ontoggle: async () => {
    if (!details.open) return;
    try {
      const report = await api('/api/unmatched');
      body.replaceChildren(
        report.unmatched.length === 0
          ? h('p', { class: 'small muted' }, 'Nothing here — every track found a home.')
          : report.unmatched.map((u) => h('div', { class: 'unmatched-item' },
            h('div', {},
              h('div', {}, u.title ?? u.trackId),
              h('div', { class: 'small muted' }, (u.artists ?? []).join(', '), u.playlist ? ` · ${u.playlist}` : '')),
            h('span', { class: 'chip' }, u.reason ?? 'unmatched'),
          )),
      );
    } catch (err) { body.replaceChildren(h('p', { class: 'small muted' }, err.message)); }
  } },
  h('summary', {}, `Unmatched tracks (${state.overview.unmatchedTotal})`), body);
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
  const pairs = o.pairs;
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
          'No syncs have run yet. Hit “Sync now” to run the first one.')
        : h('div', { class: 'rows' }, pairs.map(pairRow)),
    ),
  );
  unmatchedSection().then((el) => container.append(el));
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

function wizNav({ back = true, nextLabel = 'Continue', nextDisabled = false, onNext }) {
  return h('div', { class: 'wizfoot' },
    back
      ? h('button', { class: 'btn ghost', onclick: () => { wiz.step -= 1; saveWiz(wiz); render(); } }, 'Back')
      : h('span'),
    h('button', { class: 'btn primary', disabled: nextDisabled, onclick: onNext }, nextLabel, icon('i-arrow')),
  );
}

function credsFields(platform, uri) {
  const c = wiz.creds[platform];
  return h('div', {},
    h('h3', { style: 'margin:14px 0 8px' }, PLATFORM_LABEL[platform]),
    h('div', { class: 'formrow' },
      h('label', { class: 'field' }, h('span', {}, 'Client ID'),
        h('input', { type: 'text', value: c.clientId, oninput: (e) => { c.clientId = e.target.value.trim(); saveWiz(wiz); } })),
      h('label', { class: 'field' }, h('span', {}, 'Client secret'),
        h('input', { type: 'password', value: c.clientSecret, oninput: (e) => { c.clientSecret = e.target.value.trim(); saveWiz(wiz); } })),
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
  const filled = ['spotify', 'tidal'].every((p) => wiz.creds[p].clientId
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
      nextDisabled: !filled,
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
  const manualInput = h('input', { type: 'text', placeholder: 'http://127.0.0.1:…/callback/…?code=…' });
  const both = conns.spotify.connected && conns.tidal.connected;
  return wizardShell(2,
    h('div', {},
      h('h1', {}, 'Connect your accounts'),
      h('p', { class: 'lead' }, 'Approve access on both platforms. You’ll be sent back here after each one.'),
      h('div', { class: 'connectpair' }, card('spotify'), h('div', { class: 'loop' }, logoMark(26)), card('tidal')),
      h('details', { class: 'small' },
        h('summary', { class: 'muted' }, 'Browser can’t reach this server? Paste the redirect URL instead'),
        h('div', { style: 'display:flex;gap:8px;margin-top:8px' },
          manualInput,
          h('button', { class: 'btn', onclick: async () => {
            try {
              const res = await api('/api/auth/manual', { method: 'POST', body: { url: manualInput.value } });
              toast(`${PLATFORM_LABEL[res.platform]} connected`, 'ok');
              manualInput.value = '';
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
    ),
    wizNav({
      nextDisabled: !wiz.all && wiz.picks.length === 0,
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
          await api('/api/settings', { method: 'PUT', body: { sync: {
            mode: wiz.mode,
            source: wiz.mode === 'one-way' ? wiz.source : null,
            pairs: wiz.all ? 'all' : wiz.picks,
            periodic: wiz.periodic,
            cron: wiz.cron,
            onStart: wiz.periodic,
          } } });
          await api('/api/setup/complete', { method: 'POST', body: { runNow: wiz.runNow } });
          localStorage.removeItem(WIZ_KEY);
          wiz = wizDefault();
          toast(wiz.runNow ? 'Setup complete — first sync started' : 'Setup complete', 'ok');
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
function settingsView() {
  const s = state.settings;
  if (!s) {
    refreshSettings().then(render).catch((err) => toast(err.message, 'err'));
    return h('div', { class: 'shell' }, topbar('settings'), h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading…')));
  }
  const draft = {
    spotify: { clientId: s.spotify.clientId, clientSecret: '', market: s.spotify.market, playlistPublic: s.spotify.playlistPublic },
    tidal: { clientId: s.tidal.clientId, clientSecret: '', accessType: s.tidal.accessType },
    sync: { ...s.sync },
    logLevel: s.logLevel,
  };
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  const text = (get, set, type = 'text', placeholder = '') =>
    h('input', { type, value: get(), placeholder, oninput: (e) => set(e.target.value) });
  const check = (label, get, set) => h('label', { class: 'checkline' },
    h('input', { type: 'checkbox', checked: get(), onchange: (e) => set(e.target.checked) }), h('span', {}, label));

  const pairsSummary = s.sync.pairs === 'all'
    ? 'All playlists'
    : `${s.sync.pairs.length} selected`;

  return h('div', { class: 'shell' },
    topbar('settings'),
    h('h1', { style: 'margin-bottom:16px' }, 'Settings'),

    h('div', { class: 'card' },
      h('h2', { style: 'margin-bottom:12px' }, 'API credentials'),
      h('div', { class: 'formrow' },
        field('Spotify client ID', text(() => draft.spotify.clientId, (v) => { draft.spotify.clientId = v; })),
        field('Spotify client secret', text(() => '', (v) => { draft.spotify.clientSecret = v; }, 'password', s.spotify.clientSecretSet ? '•••••• (saved — leave blank to keep)' : '')),
        field('TIDAL client ID', text(() => draft.tidal.clientId, (v) => { draft.tidal.clientId = v; })),
        field('TIDAL client secret', text(() => '', (v) => { draft.tidal.clientSecret = v; }, 'password', s.tidal.clientSecretSet ? '•••••• (saved — leave blank to keep)' : '')),
      ),
      h('div', { class: 'small muted' }, 'Redirect URIs: ', h('code', {}, s.redirectUris.spotify), ' · ', h('code', {}, s.redirectUris.tidal)),
    ),

    h('div', { class: 'card' },
      h('h2', { style: 'margin-bottom:12px' }, 'Sync'),
      h('div', { class: 'formrow' },
        field('Mode', h('select', { onchange: (e) => { draft.sync.mode = e.target.value; } },
          h('option', { value: 'one-way', selected: draft.sync.mode === 'one-way' }, 'One-way mirror'),
          h('option', { value: 'two-way', selected: draft.sync.mode === 'two-way' }, 'Two-way sync'))),
        field('Source (one-way)', h('select', { onchange: (e) => { draft.sync.source = e.target.value; } },
          h('option', { value: 'spotify', selected: draft.sync.source === 'spotify' }, 'Spotify → TIDAL'),
          h('option', { value: 'tidal', selected: draft.sync.source === 'tidal' }, 'TIDAL → Spotify'))),
        field('Schedule (cron)', text(() => draft.sync.cron, (v) => { draft.sync.cron = v; }), 'Only used while periodic sync is on'),
        field('Playlists', h('input', { type: 'text', value: pairsSummary, disabled: true }), 'Re-run the setup wizard below to change the selection'),
      ),
      check('Periodic sync', () => draft.sync.periodic, (v) => { draft.sync.periodic = v; }),
      check('Sync when the service starts', () => draft.sync.onStart, (v) => { draft.sync.onStart = v; }),
      check('Dry-run (log changes, write nothing)', () => draft.sync.dryRun, (v) => { draft.sync.dryRun = v; }),
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
function render() {
  clearTimeout(state.pollTimer);
  if (!state.authed && !state.authDisabled) {
    $app.replaceChildren(loginView());
    return;
  }
  if (!state.overview) {
    $app.replaceChildren(h('div', { class: 'shell' }, h('p', { class: 'muted', style: 'padding:40px' }, 'Loading…')));
    return;
  }
  let view;
  if (state.overview.needsSetup || location.hash === '#/setup') view = setupView();
  else if (location.hash === '#/settings') view = settingsView();
  else view = dashboardView();
  $app.replaceChildren(view);
  schedulePoll();
}

window.addEventListener('hashchange', render);

async function boot(checkSession = true) {
  if (checkSession) {
    const session = await api('/api/session').catch(() => ({ authed: false, authDisabled: false }));
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
  await Promise.all([refreshOverview(), refreshSettings().catch(() => {})]);
  render();
}

boot();
