import { SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET } from './config.js';
import * as idb from './db.js';
import { renderMap } from './map.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

// ---------- State ----------
const S = {
  snap: null,            // { trips, days, items, entries, photos, syncedAt }
  session: null,
  tripId: null,
  tab: 'plan',
  day: -1,
  jview: 'photos',
  jday: '',              // journal day filter: '' all, day id, or 'none'
  jtag: '',
  syncing: false,
  waiting: 0,
  lastError: '',
};
let mapCtl = null;

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const fmtDate = d => { if (!d) return ''; const x = new Date(d + (d.length === 10 ? 'T00:00:00' : '')); return x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); };
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const emptySnap = () => ({ trips: [], days: [], items: [], entries: [], photos: [], syncedAt: null });

const trip = () => S.snap?.trips.find(t => t.id === S.tripId) || null;
const tripDays = () => (S.snap?.days || []).filter(d => d.trip_id === S.tripId).sort((a, b) => a.sort - b.sort);
const tripItems = () => (S.snap?.items || []).filter(i => i.trip_id === S.tripId).sort((a, b) => a.sort - b.sort);
const tripEntries = () => (S.snap?.entries || []).filter(e => e.trip_id === S.tripId).sort((a, b) => (b.entry_date || '').localeCompare(a.entry_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
const tripPhotos = () => (S.snap?.photos || []).filter(p => p.trip_id === S.tripId && !p.archived);
const thumbPath = p => p.replace(/\.jpg$/, '_t.jpg');

// ---------- Photos (cached as blobs on the phone) ----------
const urlCache = new Map();
async function blobURL(path) {
  if (urlCache.has(path)) return urlCache.get(path);
  let blob = await idb.get('blobs', path).catch(() => null);
  if (!blob && navigator.onLine && S.session) {
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(path);
    if (!error && data) { blob = data; idb.put('blobs', data, path).catch(() => {}); }
  }
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urlCache.set(path, u);
  return u;
}
function hydrateImages(root = document) {
  const imgs = [...root.querySelectorAll('img[data-path]:not([src])')];
  let i = 0;
  const worker = async () => {
    while (i < imgs.length) {
      const img = imgs[i++];
      const u = await blobURL(img.dataset.path).catch(() => null);
      if (u) img.src = u; else img.alt = 'Not downloaded yet';
    }
  };
  for (let n = 0; n < 4; n++) worker();
}
async function prefetchThumbs() {
  if (!navigator.onLine || !S.session) return;
  const have = new Set(await idb.keys('blobs').catch(() => []));
  const need = (S.snap?.photos || []).map(p => thumbPath(p.storage_path)).filter(p => !have.has(p));
  for (const path of need) {
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(path);
    if (!error && data) await idb.put('blobs', data, path).catch(() => {});
  }
}

async function resize(file, max, quality) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  return { blob, w, h };
}

// ---------- Local changes + upload queue ----------
function applyOp(snap, op) {
  const up = (list, row) => { const i = list.findIndex(x => x.id === row.id); if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row); };
  switch (op.type) {
    case 'entry_upsert': up(snap.entries, { ...op.row, pending: true }); break;
    case 'entry_delete':
      snap.entries = snap.entries.filter(e => e.id !== op.id);
      snap.photos.forEach(p => { if (p.entry_id === op.id) p.entry_id = null; });
      break;
    case 'photo_insert': up(snap.photos, { ...op.row, pending: true }); break;
    case 'photo_update': up(snap.photos, { id: op.id, ...op.fields }); break;
    case 'photo_delete': snap.photos = snap.photos.filter(p => p.id !== op.id); break;
  }
}
async function queue(op) {
  op.at = new Date().toISOString();
  await idb.put('outbox', op);
  applyOp(S.snap, op);
  await idb.put('kv', S.snap, 'snapshot');
  S.waiting = await idb.count('outbox');
  render();
  sync();
}

async function flush() {
  const ops = (await idb.all('outbox')).sort((a, b) => a.seq - b.seq);
  for (const op of ops) {
    let error = null;
    if (op.type === 'entry_upsert') ({ error } = await sb.from('entries').upsert(op.row));
    else if (op.type === 'entry_delete') ({ error } = await sb.from('entries').delete().eq('id', op.id));
    else if (op.type === 'photo_insert') {
      for (const path of [op.row.storage_path, thumbPath(op.row.storage_path)]) {
        const blob = await idb.get('blobs', path);
        if (!blob) continue;
        const r = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true });
        if (r.error) { error = r.error; break; }
      }
      if (!error) ({ error } = await sb.from('photos').upsert(op.row));
    }
    else if (op.type === 'photo_update') ({ error } = await sb.from('photos').update(op.fields).eq('id', op.id));
    else if (op.type === 'photo_delete') {
      await sb.storage.from(PHOTO_BUCKET).remove([op.path, thumbPath(op.path)]);
      ({ error } = await sb.from('photos').delete().eq('id', op.id));
    }
    if (error) throw error;
    await idb.del('outbox', op.seq);
  }
}

async function pull() {
  const [t, d, i, e, p] = await Promise.all([
    sb.from('trips').select('*').order('sort'),
    sb.from('days').select('*').order('sort'),
    sb.from('items').select('*').order('sort'),
    sb.from('entries').select('*'),
    sb.from('photos').select('*'),
  ]);
  const err = [t, d, i, e, p].find(r => r.error);
  if (err) throw err.error;
  const snap = { trips: t.data, days: d.data, items: i.data, entries: e.data, photos: p.data, syncedAt: new Date().toISOString() };
  for (const op of (await idb.all('outbox')).sort((a, b) => a.seq - b.seq)) applyOp(snap, op);
  S.snap = snap;
  await idb.put('kv', snap, 'snapshot');
}

async function sync() {
  if (S.syncing || !S.session) return paintSync();
  if (!navigator.onLine) return paintSync();
  S.syncing = true; S.lastError = ''; paintSync();
  try {
    await flush();
    await pull();
    pickTrip();
    render();
    prefetchThumbs();
  } catch (err) {
    S.lastError = (err && (err.message || err.error_description)) || 'Sync failed';
  } finally {
    S.syncing = false;
    S.waiting = await idb.count('outbox').catch(() => 0);
    paintSync();
  }
}

function paintSync() {
  const el = $('#sync'), tx = $('#syncText');
  el.classList.remove('off', 'wait', 'busy');
  if (S.syncing) { el.classList.add('busy'); tx.textContent = 'Syncing'; return; }
  if (!navigator.onLine) { el.classList.add('off'); tx.textContent = S.waiting ? `Offline · ${S.waiting} to upload` : 'Offline · saved on phone'; return; }
  if (S.waiting) { el.classList.add('wait'); tx.textContent = S.lastError ? `${S.waiting} waiting · tap to retry` : `${S.waiting} to upload`; return; }
  if (S.lastError) { el.classList.add('wait'); tx.textContent = 'Sync failed · retry'; return; }
  const t = S.snap?.syncedAt ? new Date(S.snap.syncedAt) : null;
  tx.textContent = t ? 'Synced ' + t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Not synced yet';
}

// ---------- Trip picker ----------
function pickTrip() {
  const trips = S.snap?.trips || [];
  if (!trips.find(t => t.id === S.tripId)) {
    const saved = lsGet('tripId');
    S.tripId = (trips.find(t => t.id === saved) || trips.find(t => t.status === 'travelling') || trips.find(t => t.status === 'planning') || trips[0] || {}).id || null;
  }
  const cur = trips.find(t => t.id === S.tripId);
  $('#tripTitle').textContent = cur ? cur.title : 'Travel';
  $('#tripSub').textContent = cur ? (cur.dates_label || '') : '';
  $('#tripBtn').disabled = !trips.length;
}
const TRIP_STATUS = { planning: 'Planning', travelling: 'On now', done: 'Done' };
$('#tripBtn').addEventListener('click', () => {
  const trips = S.snap?.trips || [];
  const dlg = $('#tripMenu');
  dlg.innerHTML = `<div class="tm"><div class="tm-h">Choose a trip</div>${trips.map(t => `<button type="button" class="tm-row" data-id="${t.id}" aria-current="${t.id === S.tripId}"><span class="tm-t">${esc(t.title)}</span><span class="tm-d">${esc(t.dates_label || '')}</span>${t.status ? `<span class="chip ${esc(t.status)}">${esc(TRIP_STATUS[t.status] || t.status)}</span>` : ''}</button>`).join('')}</div>`;
  dlg.querySelectorAll('.tm-row').forEach(b => b.onclick = () => {
    dlg.close();
    if (b.dataset.id === S.tripId) return;
    S.tripId = b.dataset.id; lsSet('tripId', S.tripId); S.day = -1; S.jday = ''; S.jtag = '';
    pickTrip(); render();
  });
  dlg.onclick = e => { if (e.target === dlg) dlg.close(); };
  dlg.showModal();
});

// ---------- Views ----------
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === S.tab ? 'page' : 'false'));
  const v = $('#view');
  if (mapCtl) { mapCtl.destroy(); mapCtl = null; }
  if (!S.session && !S.snap?.trips?.length) { v.innerHTML = authView(); bindAuth(); $('#tabs').hidden = true; return; }
  $('#tabs').hidden = false;
  const t = trip();
  if (!t) {
    v.innerHTML = `<div class="empty"><b>No trips yet</b>${S.session ? `Signed in as ${esc(S.session.user.email)}. If you expected trips here, this account may not have access.` : 'Sign in to load your trips.'}</div>${footer()}`;
    bindFooter(); return;
  }
  if (S.tab === 'plan') renderPlan(v, t);
  else if (S.tab === 'info') renderInfo(v, t);
  else renderJournal(v, t);
  bindFooter();
}

function footer() {
  return `<div class="foot"><span>${S.session ? esc(S.session.user.email) : 'Offline copy'}</span>${S.session ? '<button class="link" id="signout" type="button">Sign out</button>' : '<button class="link" id="signin" type="button">Sign in</button>'}</div>`;
}
function bindFooter() {
  $('#signout')?.addEventListener('click', async () => {
    const pending = await idb.count('outbox');
    if (pending && !$('#signout').dataset.sure) { $('#signout').dataset.sure = '1'; $('#signout').textContent = `${pending} changes not uploaded. Tap again to sign out anyway`; return; }
    await sb.auth.signOut(); S.session = null; await idb.del('kv', 'snapshot'); S.snap = null; render();
  });
  $('#signin')?.addEventListener('click', () => { S.snap = null; render(); });
}

function journalCounts(dayId) {
  const p = tripPhotos().filter(x => x.day_id === dayId || (x.entry_id && tripEntries().find(e => e.id === x.entry_id && e.day_id === dayId))).length;
  const e = tripEntries().filter(x => x.day_id === dayId).length;
  return { p, e };
}

function renderPlan(v, t) {
  const days = tripDays();
  const regions = t.map?.regions || {};
  const rk = Object.keys(regions);
  const regionTag = r => (r === 'X' ? 'Flight' : regions[r]?.short || regions[r]?.name || '');
  const today = todayISO();
  v.innerHTML = `
    <div class="lede">${t.route_line ? `<div class="route">${t.route_line}</div>` : ''}<div class="meta">${esc([t.subtitle, t.dates_label].filter(Boolean).join(' · '))}</div></div>
    ${t.map ? `<div class="mapcard"><div id="maphost"></div>
      <div class="ctrl"><button class="round" id="prev" type="button" aria-label="Previous day">←</button>
        <div class="cap" aria-live="polite"><div class="t" id="capT">All days</div><div class="s" id="capS"></div><a class="gmap" id="gmap" target="_blank" rel="noopener" hidden>Open this day in Google Maps ↗</a></div>
        <button class="round" id="next" type="button" aria-label="Next day">→</button></div>
      <div class="pchips" id="pchips"></div>
      <div class="legend">${rk.map((r, i) => `<span><i style="border-color:var(--r${i})"></i>${esc(regions[r].name)}</span>`).join('')}
        <span><i style="border-top-style:dashed;border-color:var(--ink-soft)"></i>Flight</span>
        <span><i style="border-top-style:dotted;border-color:var(--ink)"></i>Boat / coach</span>
        ${(t.map.overlays || []).map(o => `<label class="toggle"><input type="checkbox" data-ov="${esc(o.id)}"> ${esc(o.label)}</label>`).join('')}</div></div>` : ''}
    <h2 class="sec">Day by day</h2>
    <div class="rows" id="dayrows">${days.map((d, i) => {
      const c = journalCounts(d.id);
      const ri = rk.indexOf(d.region);
      return `<button class="day" type="button" data-i="${i}" id="d-${d.id}">
        <span class="dn">${esc(d.label)}${d.date ? `<small>${esc(fmtDate(d.date))}${d.date === today ? ' · today' : ''}</small>` : ''}</span>
        <span class="dt"><b>${esc(d.title)}</b><span>${esc(d.detail || '')}${d.sleep && d.sleep !== '—' ? ' · sleep ' + esc(d.sleep) : ''}</span>
          ${c.p || c.e ? `<span class="jl" data-jday="${d.id}">${[c.p ? c.p + ' photo' + (c.p > 1 ? 's' : '') : '', c.e ? c.e + ' entr' + (c.e > 1 ? 'ies' : 'y') : ''].filter(Boolean).join(' · ')} →</span>` : ''}</span>
        ${regionTag(d.region) ? `<span class="chip ${ri >= 0 ? 'r' + ri : ''}">${esc(regionTag(d.region))}</span>` : '<span></span>'}
      </button>`;
    }).join('')}</div>
    ${footer()}`;

  const rows = [...v.querySelectorAll('.day')];
  // Real-road directions for a day: the day's ground legs (drive, boat, coach) as a Google Maps link.
  const gmapsUrl = d => {
    const P = t.map?.places || {};
    const seq = [];
    (d.route?.legs || []).filter(l => l[0] !== 'fly').forEach(l => l[1].forEach(k => { if (typeof k === 'string' && P[k] && seq[seq.length - 1] !== k) seq.push(k); }));
    if (seq.length < 2) return '';
    const a = seq[0], b = seq[seq.length - 1], ll = k => P[k][1] + ',' + P[k][0];
    const mid = [...new Set(seq.slice(1, -1).filter(k => P[k][2] && k !== a && k !== b))].slice(0, 8);
    return 'https://www.google.com/maps/dir/?api=1&origin=' + ll(a) + '&destination=' + ll(b)
      + (mid.length ? '&waypoints=' + encodeURIComponent(mid.map(ll).join('|')) : '') + '&travelmode=driving';
  };
  // Tap a place (on the map or in the chips) to read what it is, what you'll do there and what to know.
  const info = t.map?.info || {};
  const openPlace = key => {
    const i = info[key]; if (!i) return;
    const p = t.map.places?.[key];
    const q = i.q ? encodeURIComponent(i.q) : (p ? p[1] + ',' + p[0] : '');
    const dlg = $('#placeInfo');
    dlg.innerHTML = `<div class="pi"><div class="pi-k">${esc(i.kind || '')}</div><h3>${esc(i.name)}</h3>
      <p>${esc(i.what || '')}</p>
      ${i.doIt ? `<h4>What you'll do</h4><p>${esc(i.doIt)}</p>` : ''}
      ${(i.know || []).length ? `<h4>Good to know</h4><ul>${i.know.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
      <div class="pi-actions">${q ? `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${q}">Open in Google Maps ↗</a>` : ''}<button class="btn primary" id="piClose" type="button">Close</button></div></div>`;
    $('#piClose').onclick = () => dlg.close();
    dlg.onclick = e => { if (e.target === dlg) dlg.close(); };
    dlg.showModal();
  };
  const placeKeys = cur => {
    const seen = new Set(), out = [];
    (cur < 0 ? days : [days[cur]]).forEach(d => [].concat(...(d.route?.legs || []).map(l => l[1])).forEach(k => { if (typeof k === 'string' && info[k] && !seen.has(k)) { seen.add(k); out.push(k); } }));
    return out;
  };
  const paint = cur => {
    rows.forEach((r, j) => r.classList.toggle('sel', j === cur));
    if (!t.map) return;
    const pc = $('#pchips');
    pc.innerHTML = placeKeys(cur).map(k => `<button type="button" class="pchip" data-k="${esc(k)}">${esc(info[k].name)}</button>`).join('');
    pc.querySelectorAll('.pchip').forEach(b => b.onclick = () => openPlace(b.dataset.k));
    const T = $('#capT'), Sx = $('#capS'), G = $('#gmap');
    if (cur < 0) { T.textContent = 'All days'; Sx.textContent = `${days.length} days · tap a day or use the arrows`; }
    else { const d = days[cur]; T.textContent = (/^\d/.test(d.label) ? 'Day ' : '') + d.label + ' · ' + d.title; Sx.textContent = d.sleep && d.sleep !== '—' ? 'Sleep: ' + d.sleep : (d.detail || ''); }
    const u = cur >= 0 ? gmapsUrl(days[cur]) : '';
    G.hidden = !u; if (u) G.href = u;
  };
  if (t.map) {
    mapCtl = renderMap($('#maphost'), t.map, days, { onChange: c => { S.day = c; paint(c); }, onPlace: openPlace });
    $('#prev').onclick = () => mapCtl.select(S.day <= 0 ? (S.day < 0 ? days.length - 1 : -1) : S.day - 1);
    $('#next').onclick = () => mapCtl.select(S.day >= days.length - 1 ? -1 : S.day + 1);
    v.querySelectorAll('[data-ov]').forEach(cb => cb.addEventListener('change', () => mapCtl.setOverlay(cb.dataset.ov, cb.checked)));
    const ti = days.findIndex(d => d.date === today);
    mapCtl.select(S.day >= 0 && S.day < days.length ? S.day : (ti >= 0 ? ti : -1));
  } else paint(S.day);
  rows.forEach((r, i) => r.addEventListener('click', ev => {
    const jl = ev.target.closest('[data-jday]');
    if (jl) { S.tab = 'journal'; S.jday = jl.dataset.jday; S.jtag = ''; render(); window.scrollTo(0, 0); return; }
    const next = S.day === i ? -1 : i;
    if (mapCtl) { mapCtl.select(next); const m = $('#maphost').getBoundingClientRect(); if (m.top < 0 || m.bottom > innerHeight) $('#maphost').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else { S.day = next; paint(next); }
  }));
}

function renderInfo(v, t) {
  const items = tripItems();
  const sections = [];
  items.forEach(it => { if (!sections.includes(it.section)) sections.push(it.section); });
  v.innerHTML = (sections.length ? sections.map(sec => `
    <h2 class="sec">${esc(sec)}</h2>
    <ul class="list">${items.filter(i => i.section === sec).map(i => `
      <li><span class="k"><b>${esc(i.title)}</b>${i.detail ? `<span>${esc(i.detail)}</span>` : ''}</span>
      <span class="v">${esc(i.value || '')}${i.status ? `<br><span class="chip ${esc(i.status)}">${esc(i.status)}</span>` : ''}</span></li>`).join('')}</ul>`).join('')
    : `<div class="empty"><b>Nothing here yet</b>Bookings, costs and notes for ${esc(t.title)} will show up here.</div>`) + footer();
}

function renderJournal(v, t) {
  const days = tripDays();
  const entries = tripEntries();
  let photos = tripPhotos();
  const entryDay = id => entries.find(e => e.id === id)?.day_id || null;
  const dayOf = p => p.day_id || entryDay(p.entry_id);
  if (S.jday === 'none') photos = photos.filter(p => !dayOf(p));
  else if (S.jday) photos = photos.filter(p => dayOf(p) === S.jday);
  const tags = [...new Set(tripPhotos().flatMap(p => p.tags || []))].sort();
  if (S.jtag) photos = photos.filter(p => (p.tags || []).includes(S.jtag));
  const ents = S.jday === 'none' ? entries.filter(e => !e.day_id) : S.jday ? entries.filter(e => e.day_id === S.jday) : entries;

  const dayOpts = `<option value="">All days</option>${days.map(d => `<option value="${d.id}" ${S.jday === d.id ? 'selected' : ''}>${esc(d.label)} · ${esc(d.title)}</option>`).join('')}<option value="none" ${S.jday === 'none' ? 'selected' : ''}>No day set</option>`;

  let body = '';
  if (S.jview === 'photos') {
    if (!photos.length) body = `<div class="empty"><b>No photos yet</b>Tap New entry to add photos from your phone. They stay on the phone until you have signal.</div>`;
    else {
      const groups = new Map();
      photos.sort((a, b) => (a.taken_at || a.created_at || '').localeCompare(b.taken_at || b.created_at || ''));
      photos.forEach(p => { const k = dayOf(p) || 'none'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
      const order = [...days.map(d => d.id), 'none'].filter(k => groups.has(k));
      body = order.map(k => {
        const d = days.find(x => x.id === k);
        return `<div class="ghead"><span>${d ? esc(d.label + ' · ' + d.title) : 'No day set'}</span><span>${groups.get(k).length}</span></div>
          <div class="grid">${groups.get(k).map(p => `<button class="tile" type="button" data-photo="${p.id}" aria-label="${esc(p.caption || 'Photo')}"><img data-path="${esc(thumbPath(p.storage_path))}" alt="">${p.rating ? `<span class="stars">${'★'.repeat(p.rating)}</span>` : ''}${p.pending ? '<span class="pend" title="Waiting to upload"></span>' : ''}</button>`).join('')}</div>`;
      }).join('');
    }
  } else {
    body = ents.length ? ents.map(e => {
      const d = days.find(x => x.id === e.day_id);
      const ph = tripPhotos().filter(p => p.entry_id === e.id).slice(0, 6);
      return `<button class="ecard" type="button" data-entry="${e.id}">
        <span class="d"><span>${esc(fmtDate(e.entry_date))}${d ? ' · ' + esc(d.label) : ''}</span><span>${e.pending ? 'waiting to upload' : esc(e.place || '')}</span></span>
        <h3>${esc(e.title || (d ? d.title : 'Untitled'))}</h3>
        ${e.body ? `<p>${esc(e.body)}</p>` : ''}
        ${ph.length ? `<span class="strip">${ph.map(p => `<img data-path="${esc(thumbPath(p.storage_path))}" alt="">`).join('')}</span>` : ''}
      </button>`;
    }).join('') : `<div class="empty"><b>No entries yet</b>Write the first one with New entry.</div>`;
  }

  v.innerHTML = `
    <div class="jbar">
      <div class="seg" role="group" aria-label="Journal view">
        <button type="button" data-jv="photos" aria-pressed="${S.jview === 'photos'}">Photos</button>
        <button type="button" data-jv="entries" aria-pressed="${S.jview === 'entries'}">Entries</button>
      </div>
      <button class="btn primary" type="button" id="newEntry">New entry</button>
    </div>
    <div class="filters">
      <select id="jdaySel" aria-label="Filter by day">${dayOpts}</select>
      ${S.jview === 'photos' ? tags.map(tg => `<button type="button" data-tag="${esc(tg)}" aria-pressed="${S.jtag === tg}">${esc(tg)}</button>`).join('') : ''}
    </div>
    ${body}
    ${footer()}`;
  v.querySelectorAll('[data-jv]').forEach(b => b.onclick = () => { S.jview = b.dataset.jv; render(); });
  $('#jdaySel').onchange = e => { S.jday = e.target.value; render(); };
  v.querySelectorAll('[data-tag]').forEach(b => b.onclick = () => { S.jtag = S.jtag === b.dataset.tag ? '' : b.dataset.tag; render(); });
  $('#newEntry').onclick = () => openEditor(null);
  v.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => openViewer(b.dataset.photo));
  v.querySelectorAll('[data-entry]').forEach(b => b.onclick = () => openEditor(b.dataset.entry));
  hydrateImages(v);
}

// ---------- Photo viewer ----------
async function openViewer(id) {
  const dlg = $('#viewer');
  const p = S.snap.photos.find(x => x.id === id); if (!p) return;
  const entry = S.snap.entries.find(e => e.id === p.entry_id);
  let rating = p.rating || 0;
  dlg.innerHTML = `<div class="big"><img id="vimg" alt="${esc(p.caption || '')}"></div>
    <div class="sh-in">
      <div class="sh-head"><span class="hint">${esc(fmtDate((p.taken_at || p.created_at || '').slice(0, 10)))}${entry ? ' · ' + esc(entry.title || 'Entry') : ''}${p.pending ? ' · waiting to upload' : ''}</span><button class="x" type="button" id="vclose" aria-label="Close">✕</button></div>
      <label class="field"><span>Caption</span><input id="vcap" value="${esc(p.caption || '')}" placeholder="What's in the shot"></label>
      <div class="two">
        <label class="field"><span>Tags</span><input id="vtags" value="${esc((p.tags || []).join(', '))}" placeholder="landscape, food"></label>
        <div class="field"><span>Rating</span><div class="rate" id="vrate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" class="${n <= rating ? 'on' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div></div>
      </div>
      <div class="actions"><button class="btn danger" type="button" id="vdel">Delete photo</button><button class="btn primary" type="button" id="vsave">Save</button></div>
    </div>`;
  dlg.showModal();
  const full = await blobURL(p.storage_path) || await blobURL(thumbPath(p.storage_path));
  if (full) $('#vimg').src = full; else $('#vimg').alt = 'Photo not downloaded yet. Open the app with signal to fetch it.';
  $('#vrate').querySelectorAll('button').forEach(b => b.onclick = () => { rating = rating === +b.dataset.n ? 0 : +b.dataset.n; $('#vrate').querySelectorAll('button').forEach(x => x.classList.toggle('on', +x.dataset.n <= rating)); });
  $('#vclose').onclick = () => dlg.close();
  $('#vsave').onclick = async () => {
    const tags = $('#vtags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    await queue({ type: 'photo_update', id: p.id, fields: { caption: $('#vcap').value.trim() || null, tags, rating: rating || null } });
    dlg.close();
  };
  $('#vdel').onclick = async () => {
    const b = $('#vdel');
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Tap again to delete'; return; }
    await queue({ type: 'photo_delete', id: p.id, path: p.storage_path });
    dlg.close();
  };
}

// ---------- Entry editor ----------
async function openEditor(entryId) {
  const dlg = $('#editor');
  const t = trip(); const days = tripDays();
  const e = entryId ? S.snap.entries.find(x => x.id === entryId) : null;
  const existing = e ? tripPhotos().filter(p => p.entry_id === e.id) : [];
  const defaultDay = e?.day_id || (S.jday && S.jday !== 'none' ? S.jday : (days.find(d => d.date === todayISO())?.id || ''));
  const added = []; // { file, url }
  dlg.innerHTML = `<form class="sh-in" id="ef" method="dialog">
    <div class="sh-head"><h3>${e ? 'Edit entry' : 'New entry'}</h3><button class="x" type="button" id="eclose" aria-label="Close">✕</button></div>
    <div class="two">
      <label class="field"><span>Day</span><select id="eday"><option value="">No day</option>${days.map(d => `<option value="${d.id}" ${d.id === defaultDay ? 'selected' : ''}>${esc(d.label)} · ${esc(d.title)}</option>`).join('')}</select></label>
      <label class="field"><span>Date</span><input type="date" id="edate" value="${esc(e?.entry_date || days.find(d => d.id === defaultDay)?.date || todayISO())}"></label>
    </div>
    <label class="field"><span>Title</span><input id="etitle" value="${esc(e?.title || '')}" placeholder="Doubtful Sound in the rain"></label>
    <label class="field"><span>Place</span><input id="eplace" value="${esc(e?.place || '')}" placeholder="Deep Cove"></label>
    <label class="field"><span>Notes</span><textarea id="ebody" placeholder="What happened today">${esc(e?.body || '')}</textarea></label>
    <div class="field"><span>Photos</span><div class="thumbs" id="ethumbs"></div></div>
    <input type="file" id="efile" accept="image/*" multiple hidden>
    <div class="actions">${e ? '<button class="btn danger" type="button" id="edel">Delete entry</button>' : '<span class="hint">Saves on your phone first, uploads when online.</span>'}<button class="btn primary" type="submit" id="esave">Save</button></div>
  </form>`;
  const paintThumbs = () => {
    $('#ethumbs').innerHTML = existing.map(p => `<div class="t"><img data-path="${esc(thumbPath(p.storage_path))}" alt=""></div>`).join('')
      + added.map((a, i) => `<div class="t"><img src="${a.url}" alt=""><button class="rm" type="button" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('')
      + `<label class="addph" for="efile">+ Add photos</label>`;
    hydrateImages($('#ethumbs'));
    $('#ethumbs').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { URL.revokeObjectURL(added[+b.dataset.rm].url); added.splice(+b.dataset.rm, 1); paintThumbs(); });
  };
  paintThumbs();
  $('#eday').onchange = ev => { const d = days.find(x => x.id === ev.target.value); if (d?.date) $('#edate').value = d.date; };
  $('#efile').onchange = ev => { [...ev.target.files].forEach(f => added.push({ file: f, url: URL.createObjectURL(f) })); ev.target.value = ''; paintThumbs(); };
  $('#eclose').onclick = () => { added.forEach(a => URL.revokeObjectURL(a.url)); dlg.close(); };
  $('#edel')?.addEventListener('click', async () => {
    const b = $('#edel');
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Tap again to delete (photos stay)'; return; }
    await queue({ type: 'entry_delete', id: e.id }); dlg.close();
  });
  $('#ef').onsubmit = async ev => {
    ev.preventDefault();
    const btn = $('#esave'); btn.disabled = true; btn.textContent = added.length ? 'Preparing photos…' : 'Saving…';
    const id = e?.id || uuid();
    const dayId = $('#eday').value || null;
    const row = { id, trip_id: t.id, day_id: dayId, entry_date: $('#edate').value || todayISO(), title: $('#etitle').value.trim() || null, place: $('#eplace').value.trim() || null, body: $('#ebody').value.trim() || null };
    if (!e) row.created_at = new Date().toISOString();
    await queue({ type: 'entry_upsert', row });
    for (const a of added) {
      try {
        const pid = uuid();
        const path = `${t.slug}/${pid}.jpg`;
        const main = await resize(a.file, 2048, 0.82);
        const th = await resize(a.file, 480, 0.72);
        await idb.put('blobs', main.blob, path);
        await idb.put('blobs', th.blob, thumbPath(path));
        await queue({ type: 'photo_insert', row: { id: pid, trip_id: t.id, entry_id: id, storage_path: path, taken_at: new Date(a.file.lastModified || Date.now()).toISOString(), width: main.w, height: main.h, tags: [] } });
      } catch (err) {
        S.lastError = 'One photo could not be read'; paintSync();
      }
      URL.revokeObjectURL(a.url);
    }
    dlg.close();
  };
  dlg.showModal();
}

// ---------- Sign in ----------
function authView() {
  return `<div class="auth">
    <h1>Travel</h1>
    <p>Sign in once with signal. After that the app works offline.</p>
    <form id="af" class="auth" style="margin:0">
      <label class="field"><span>Email</span><input id="aemail" type="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input id="apass" type="password" autocomplete="current-password" minlength="8" required></label>
      <button class="btn primary" type="submit" id="asubmit">Sign in</button>
    </form>
    <button class="link" type="button" id="amode">First time? Create your account</button>
    <div id="amsg"></div>
  </div>`;
}
function bindAuth() {
  let mode = 'in';
  const msg = (t, err) => { $('#amsg').innerHTML = t ? `<div class="msg ${err ? 'err' : ''}">${esc(t)}</div>` : ''; };
  $('#amode').onclick = () => {
    mode = mode === 'in' ? 'up' : 'in';
    $('#asubmit').textContent = mode === 'in' ? 'Sign in' : 'Create account';
    $('#amode').textContent = mode === 'in' ? 'First time? Create your account' : 'Have an account? Sign in';
    $('#apass').autocomplete = mode === 'in' ? 'current-password' : 'new-password';
    msg('');
  };
  $('#af').onsubmit = async ev => {
    ev.preventDefault();
    if (!navigator.onLine) return msg('You need signal to sign in the first time.', true);
    const email = $('#aemail').value.trim(), password = $('#apass').value;
    $('#asubmit').disabled = true;
    const res = mode === 'in' ? await sb.auth.signInWithPassword({ email, password }) : await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
    $('#asubmit').disabled = false;
    if (res.error) return msg(res.error.message, true);
    if (mode === 'up' && !res.data.session) return msg('Check your email and tap the confirmation link, then come back here and sign in.');
  };
}

// ---------- Boot ----------
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
$('#sync').addEventListener('click', () => sync());
addEventListener('online', () => { paintSync(); sync(); });
addEventListener('offline', paintSync);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    const show = w => { $('#update').hidden = false; $('#updateBtn').onclick = () => w.postMessage('skipWaiting'); };
    if (reg.waiting && navigator.serviceWorker.controller) show(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) show(w); });
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}
navigator.storage?.persist?.().catch(() => {});

(async function boot() {
  S.snap = await idb.get('kv', 'snapshot').catch(() => null);
  S.waiting = await idb.count('outbox').catch(() => 0);
  try { const { data } = await sb.auth.getSession(); S.session = data.session; } catch { S.session = null; }
  if (!S.snap && S.session) S.snap = emptySnap();
  pickTrip(); render(); paintSync();
  sb.auth.onAuthStateChange((_e, session) => {
    const was = !!S.session; S.session = session;
    if (session && !was) { if (!S.snap) S.snap = emptySnap(); render(); sync(); }
  });
  sync();
})();
