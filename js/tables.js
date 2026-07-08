// manager-stats · tabelle ordinabili + riga KPI (portati da chiamate-stats, generalizzati)
import { fmt } from './format.js';

// cols: [{ key, label, fmt(value,row), good, goodMin }]
// opts: { barKey, onRowClick(row,index), rowLink(row)->bool }
export function renderTable(el, cols, rows, sort, onSort, opts = {}) {
  const { barKey, onRowClick, rowLink } = opts;
  const maxBar = barKey ? Math.max(...rows.map(r => r[barKey] || 0), 1) : 1;

  rows.sort((a, b) => {
    const va = a[sort.key], vb = b[sort.key];
    if (typeof va === 'string' || typeof vb === 'string') {
      return sort.dir * String(va ?? '').localeCompare(String(vb ?? ''));
    }
    return sort.dir * ((va ?? -Infinity) - (vb ?? -Infinity));
  });

  let h = '<thead><tr>' + cols.map(c =>
    `<th data-k="${c.key}">${c.label} <span class="arrow">${sort.key === c.key ? (sort.dir < 0 ? '▼' : '▲') : ''}</span></th>`
  ).join('') + '</tr></thead><tbody>';

  rows.forEach((r, ri) => {
    const clickable = rowLink ? rowLink(r) : false;
    h += `<tr class="${clickable ? 'rowlink' : ''}" data-ri="${ri}">` + cols.map((c, i) => {
      let v = c.fmt ? c.fmt(r[c.key], r) : (typeof r[c.key] === 'number' ? fmt(r[c.key]) : (r[c.key] ?? '—'));
      if (i === 0) return `<td class="name">${v}</td>`;
      if (barKey && c.key === barKey) {
        const w = Math.round(60 * (r[barKey] || 0) / maxBar);
        return `<td><span class="mini-bar" style="width:${w}px"></span>${v}</td>`;
      }
      if (c.good && r[c.key] !== null && r[c.key] !== undefined && r[c.key] >= (c.goodMin ?? 20)) {
        return `<td class="pct-good">${v}</td>`;
      }
      return `<td>${v}</td>`;
    }).join('') + '</tr>';
  });

  el.innerHTML = h + '</tbody>';
  el.querySelectorAll('th').forEach(th => th.onclick = () => onSort(th.dataset.k));
  if (onRowClick) {
    el.querySelectorAll('tbody tr.rowlink').forEach(tr =>
      tr.onclick = () => onRowClick(rows[+tr.dataset.ri], +tr.dataset.ri));
  }
}

// tiles: [{ label, value, sub }]
export function renderKpiRow(el, tiles) {
  el.innerHTML = tiles.map(x =>
    `<div class="tile"><div class="label">${x.label}</div><div class="value">${x.value}</div><div class="sub">${x.sub || ''}</div></div>`
  ).join('');
}
