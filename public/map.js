// Draws a trip's hand-made SVG map (no tiles, so it works offline) and the
// route day by day. Map shape lives in trips.map; each day's legs in days.route.
const NS = 'http://www.w3.org/2000/svg';
const mk = (tag, a, p) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };

export function renderMap(host, map, days, { onChange } = {}) {
  const [minLon, minLat, maxLon, maxLat] = map.bbox;
  const cos = Math.cos((map.latRef ?? (minLat + maxLat) / 2) * Math.PI / 180);
  const W = 580, k = W / ((maxLon - minLon) * cos), H = Math.round((maxLat - minLat) * k);
  const FULL = [0, 0, W, H], ASP = W / H;
  const proj = ([lon, lat]) => [(lon - minLon) * cos * k, (maxLat - lat) * k];
  const P = map.places || {};
  const pt = key => (Array.isArray(key) ? key : P[key]);
  const regionKeys = Object.keys(map.regions || {});
  const regionIdx = r => Math.max(0, regionKeys.indexOf(r));

  host.innerHTML = '';
  const svg = mk('svg', { viewBox: FULL.join(' '), class: 'map', role: 'img', 'aria-label': 'Route map' }, host);
  svg.style.aspectRatio = `${W}/${H}`;
  const pathOf = pts => pts.map((q, i) => { const [x, y] = proj(pt(q)); return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }).join('');

  mk('rect', { x: -W, y: -H, width: W * 3, height: H * 3, class: 'm-sea' }, svg);
  (map.land || []).forEach(c => mk('path', { d: pathOf(c) + 'Z', class: 'm-land' }, svg));
  (map.lakes || []).forEach(l => mk('path', { d: pathOf(l), class: 'm-lake' }, svg));
  (map.lakeEllipses || []).forEach(([lon, lat, rx, ry]) => { const [x, y] = proj([lon, lat]); mk('ellipse', { cx: x, cy: y, rx: rx * cos * k, ry: ry * k, class: 'm-lakefill' }, svg); });

  const overlays = (map.overlays || []).map(o => {
    const e = mk('path', { d: pathOf(o.points), class: 'm-overlay' }, svg);
    e.style.display = 'none';
    return { ...o, el: e, on: false };
  });

  const islLabels = (map.areaLabels || []).map(([text, lon, lat]) => {
    const e = mk('text', { class: 'm-area', 'text-anchor': 'middle' }, svg); e.textContent = text;
    return { e, p: proj([lon, lat]) };
  });

  const legEls = [];
  days.forEach((d, i) => ((d.route && d.route.legs) || []).forEach(([mode, keys]) => {
    const cls = ['m-leg', mode];
    if (mode !== 'fly') cls.push('r' + regionIdx(d.region));
    const e = mk('path', { d: pathOf(keys), class: cls.join(' ') }, svg);
    legEls.push({ e, i });
  }));
  const gL = mk('g', {}, svg);

  let cur = -1, vb = FULL.slice(), labels = [], anim = null;
  const ppu = () => (svg.getBoundingClientRect().width || 360) / vb[2];

  function addLabel(key, text, num, base, region) {
    const p = pt(key); if (!p) return;
    const [x, y] = proj(p), side = p[3] || 'r';
    const c = mk('circle', { class: 'm-dot' + (base ? ' base' : ''), cx: x, cy: y }, gL);
    const t = mk('text', { class: 'm-lbl' + (region != null ? ' r' + region : '') }, gL);
    t.appendChild(document.createTextNode(text));
    if (num) { const s = mk('tspan', { class: 'n' }, t); s.textContent = '  ' + num; }
    labels.push({ c, t, x, y, side });
  }

  function buildLabels() {
    gL.innerHTML = ''; labels = [];
    if (cur < 0) {
      (map.bases || []).forEach(([key, nights]) => {
        const day = days.find(d => (d.route?.legs || []).some(l => l[1].includes(key)));
        addLabel(key, P[key]?.[2] || key, nights, true, day && day.region !== 'X' ? regionIdx(day.region) : null);
      });
      overlays.filter(o => o.on && o.labelPlace).forEach(o => addLabel(o.labelPlace, P[o.labelPlace]?.[2] || '', '', false, null));
    } else {
      const d = days[cur], seen = new Set();
      const legs = d.route?.legs || [];
      const ks = legs.length ? [].concat(...legs.map(l => l[1])) : (d.route?.fit || []);
      ks.forEach(key => { if (typeof key === 'string' && P[key]?.[2] && !seen.has(key)) { seen.add(key); addLabel(key, P[key][2], '', false, null); } });
    }
    size();
  }

  function size() {
    const u = 1 / ppu(), fs = 12 * u;
    labels.forEach(l => {
      l.c.setAttribute('r', (l.c.classList.contains('base') ? 4.5 : 4) * u);
      l.t.setAttribute('font-size', fs); l.t.setAttribute('stroke-width', 3.5 * u);
      let x = l.x, y = l.y + fs * 0.35, a = 'start';
      if (l.side === 'r') x += 8 * u;
      else if (l.side === 'l') { x -= 8 * u; a = 'end'; }
      else if (l.side === 'b') { y = l.y + fs * 1.35; a = 'middle'; }
      else { y = l.y - fs * 0.75; a = 'middle'; }
      l.t.setAttribute('x', x); l.t.setAttribute('y', y); l.t.setAttribute('text-anchor', a);
      // Keep labels inside the visible map: flip sides when one would run off an edge.
      let w = 0; try { w = l.t.getComputedTextLength(); } catch {}
      const left = vb[0] + 4 * u, right = vb[0] + vb[2] - 4 * u;
      if (a === 'end' && x - w < left) { l.t.setAttribute('x', l.x + 8 * u); l.t.setAttribute('text-anchor', 'start'); }
      else if (a === 'start' && x + w > right) { l.t.setAttribute('x', l.x - 8 * u); l.t.setAttribute('text-anchor', 'end'); }
    });
    islLabels.forEach(({ e, p }) => { e.style.display = cur < 0 ? '' : 'none'; e.setAttribute('font-size', 11 * u); e.setAttribute('x', p[0]); e.setAttribute('y', p[1]); });
  }

  function target(i) {
    if (i < 0) return FULL;
    const d = days[i];
    const legs = d.route?.legs || [];
    let ks = d.route?.fit;
    if (!ks) {
      const ground = legs.filter(l => l[0] !== 'fly');
      ks = [].concat(...(ground.length ? ground : legs).map(l => l[1]));
    }
    const pts = ks.map(pt).filter(Boolean).map(proj);
    if (!pts.length) return FULL;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    let w = Math.max(x1 - x0, 90) * 1.6, h = Math.max(y1 - y0, 90) * 1.4;
    if (w / h > ASP) h = w / ASP; else w = h * ASP;
    if (w > W) { w = W; h = H; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return [cx - w / 2, cy - h / 2, w, h];
  }

  function go(to) {
    const from = vb.slice(), t0 = performance.now();
    const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450;
    cancelAnimationFrame(anim);
    const step = now => {
      const t = dur ? Math.min(1, (now - t0) / dur) : 1;
      const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      vb = from.map((v, j) => v + (to[j] - v) * e);
      svg.setAttribute('viewBox', vb.map(v => v.toFixed(2)).join(' '));
      size();
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function select(i) {
    cur = i;
    legEls.forEach(({ e, i: di }) => { e.classList.toggle('on', cur >= 0 && di === cur); e.classList.toggle('off', cur >= 0 && di !== cur); });
    buildLabels(); go(target(cur));
    onChange && onChange(cur);
  }

  function setOverlay(id, on) {
    const o = overlays.find(x => x.id === id); if (!o) return;
    o.on = on; o.el.style.display = on ? '' : 'none'; buildLabels();
  }

  const ro = new ResizeObserver(() => size()); ro.observe(svg);
  buildLabels();
  return { select, setOverlay, get current() { return cur; }, overlays: overlays.map(o => ({ id: o.id, label: o.label })), destroy() { ro.disconnect(); cancelAnimationFrame(anim); } };
}
