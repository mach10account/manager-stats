// manager-stats · grafici SVG fatti a mano (line + bar), tooltip + crosshair (portati)
import { fmt, cssv } from './format.js';

// ── tooltip fisso condiviso ──────────────────────────────────────────────────
export function showTip(ev, html) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  tip.innerHTML = html;
  tip.style.display = 'block';
  const pad = 14;
  let tx = ev.clientX + pad, ty = ev.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (tx + r.width > window.innerWidth - 8)  tx = ev.clientX - r.width - pad;
  if (ty + r.height > window.innerHeight - 8) ty = ev.clientY - r.height - pad;
  tip.style.left = tx + 'px';
  tip.style.top  = ty + 'px';
}
export function hideTip() {
  const tip = document.getElementById('tooltip');
  if (tip) tip.style.display = 'none';
}

function emptyMsg(svg, W, H, txt) {
  svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${cssv('--muted')}" font-size="13">${txt || 'Nessun dato nel periodo'}</text>`;
}

// ── grafico a linee (1..N serie) ─────────────────────────────────────────────
// labels: string[]  ·  rows: object[] allineati a labels  ·  series: [{key,color,name}]
// opts: { height, padL, yfmt, axisFmt, xlab(label), tip(row,label,index)->html, minMax, lastLabels }
export function renderLineChart(svg, labels, rows, series, opts = {}) {
  const yfmt    = opts.yfmt    || fmt;
  const axisFmt = opts.axisFmt || yfmt;
  const xlab    = opts.xlab    || (s => s);
  const H = opts.height || 260, padL = opts.padL || 44, padR = 16, padT = 12, padB = 28;
  const W = svg.clientWidth || svg.parentElement?.clientWidth || 900;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!labels.length) { emptyMsg(svg, W, H); return; }

  const maxY = Math.max(...rows.flatMap(r => series.map(s => +r[s.key] || 0)), opts.minMax || 5);
  const x = i => padL + (labels.length === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (labels.length - 1));
  const y = v => padT + (H - padT - padB) * (1 - (+v || 0) / maxY);

  let g = '';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = maxY * i / steps, yy = y(v);
    g += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${cssv('--grid')}" stroke-width="1"/>`;
    g += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${cssv('--muted')}">${axisFmt(v)}</text>`;
  }
  const nlab = Math.max(1, Math.ceil(labels.length / 10));
  labels.forEach((d, i) => {
    if (i % nlab === 0) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${cssv('--muted')}">${xlab(d)}</text>`;
  });
  for (const s of series) {
    const line = rows.map((r, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(r[s.key]).toFixed(1)).join(' ');
    g += `<path d="${line}" fill="none" stroke="${cssv(s.color)}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  if (labels.length <= 2) {
    labels.forEach((d, i) => {
      for (const s of series) g += `<circle cx="${x(i)}" cy="${y(rows[i][s.key])}" r="4" fill="${cssv(s.color)}"/>`;
    });
  }
  if (opts.lastLabels !== false) {
    const li = labels.length - 1;
    for (const s of series) {
      g += `<text x="${x(li) - 6}" y="${y(rows[li][s.key]) - 8}" text-anchor="end" font-size="11" font-weight="600" fill="${cssv('--text-secondary')}">${yfmt(rows[li][s.key])}</text>`;
    }
  }
  g += `<line id="crosshair" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="${cssv('--baseline')}" stroke-width="1" visibility="hidden"/>`;
  svg.innerHTML = g;

  svg.onmousemove = ev => {
    const rect = svg.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * W / rect.width;
    let best = 0, bd = Infinity;
    labels.forEach((d, i) => { const dd = Math.abs(x(i) - mx); if (dd < bd) { bd = dd; best = i; } });
    const ch = svg.querySelector('#crosshair');
    if (ch) { ch.setAttribute('x1', x(best)); ch.setAttribute('x2', x(best)); ch.setAttribute('visibility', 'visible'); }
    if (opts.tip) showTip(ev, opts.tip(rows[best], labels[best], best));
  };
  svg.onmouseleave = () => {
    hideTip();
    const ch = svg.querySelector('#crosshair');
    if (ch) ch.setAttribute('visibility', 'hidden');
  };
}

// ── grafico a barre ──────────────────────────────────────────────────────────
// buckets: [{ label, value, subLabel }]  ·  opts: { height, footer, tip(bucket)->html }
export function renderBarChart(svg, buckets, opts = {}) {
  const H = opts.height || 240, padL = opts.padL || 52, padR = 16, padT = 14, padB = 42;
  const W = svg.clientWidth || svg.parentElement?.clientWidth || 900;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!buckets.length) { emptyMsg(svg, W, H, 'Nessun dato'); return; }

  const maxY = Math.max(...buckets.map(b => +b.value || 0), 1);
  const bw = Math.min(64, (W - padL - padR) / buckets.length - 8);
  const x = i => padL + i * (W - padL - padR) / buckets.length + ((W - padL - padR) / buckets.length - bw) / 2;
  const y = v => padT + (H - padT - padB) * (1 - (+v || 0) / maxY);

  let g = '';
  const steps = 3;
  for (let i = 0; i <= steps; i++) {
    const v = Math.round(maxY * i / steps), yy = y(v);
    g += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${cssv('--grid')}" stroke-width="1"/>`;
    g += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${cssv('--muted')}">${v.toLocaleString('it-IT')}</text>`;
  }
  buckets.forEach((b, i) => {
    const bx = x(i), by = y(b.value), bh = H - padB - by;
    g += `<rect data-i="${i}" x="${bx}" y="${by}" width="${bw}" height="${Math.max(bh, 1)}" rx="4" fill="${cssv('--seq-450')}"/>`;
    g += `<text x="${bx + bw / 2}" y="${H - padB + 16}" text-anchor="middle" font-size="12" fill="${cssv('--text-secondary')}">${b.label}</text>`;
    if (b.subLabel) g += `<text x="${bx + bw / 2}" y="${H - padB + 32}" text-anchor="middle" font-size="10" fill="${cssv('--muted')}">${b.subLabel}</text>`;
  });
  if (opts.footer) g += `<text x="${padL}" y="${H - 2}" font-size="10" fill="${cssv('--muted')}">${opts.footer}</text>`;
  svg.innerHTML = g;

  svg.onmousemove = ev => {
    const t = ev.target;
    if (t.tagName === 'rect' && opts.tip) showTip(ev, opts.tip(buckets[+t.dataset.i]));
    else hideTip();
  };
  svg.onmouseleave = hideTip;
}
