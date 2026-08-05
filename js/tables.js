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

// testo dentro un attributo HTML (i tooltip nascono da dati, non da costanti)
const attr = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// titolo della tile + ⓘ. L'ultima parola e l'icona restano legate (nowrap): con
// le etichette lunghe, che vanno a capo, l'icona finirebbe da sola su una riga.
function labelConInfo(label, info) {
  const icona = `<button type="button" class="kg-i" data-tip="${attr(info)}"
      aria-label="${attr(label)}: ${attr(info)}">i</button>`;
  const i = String(label).lastIndexOf(' ');
  const testa = i === -1 ? '' : label.slice(0, i + 1);
  const coda = i === -1 ? label : label.slice(i + 1);
  return `${testa}<span class="kg-nb">${coda}${icona}</span>`;
}

// gruppi KPI a funnel: [{ step, title, wide, tiles: [{ label, value, sub, info, hero, tone }] }]
// wide = il gruppo occupa due colonne della griglia (per quelli con molte voci:
//        riempie la riga invece di lasciare una colonna vuota accanto)
// hero = metrica principale del gruppo (grande, su riga propria) · tone = 'good'|'bad'
// sub  = riga di testo sempre visibile sotto il numero
// info = stessa spiegazione ma dentro una ⓘ accanto al titolo, in hover: per le
//        tile con spiegazioni lunghe, che a vista sono solo rumore
// opts.righe = metriche secondarie una per riga (etichetta a sinistra, numero a
// destra) invece che affiancate: serve dove le etichette sono lunghe e in colonna
// andavano a capo lasciando tile spaiate. Le etichette corte stanno meglio in
// colonna, quindi resta una scelta della sezione.
export function renderKpiGroups(el, groups, opts) {
  const righe = !!(opts && opts.righe);
  el.innerHTML = groups.map(g => `
    <section class="kpi-group${g.wide ? ' kg-wide' : ''}">
      <div class="kg-head">
        ${g.step ? `<span class="kg-step">${g.step}</span>` : ''}
        <h3 class="kg-title">${g.title}</h3>
      </div>
      <div class="kg-tiles${righe ? ' kg-righe' : ''}">
        ${g.tiles.map(t => `
          <div class="kg-tile${t.hero ? ' kg-hero' : ''}">
            <div class="label">${t.info ? labelConInfo(t.label, t.info) : t.label}</div>
            <div class="value${t.tone ? ' val-' + t.tone : ''}">${t.value}</div>
            ${t.sub ? `<div class="sub">${t.sub}</div>` : ''}
          </div>`).join('')}
      </div>
    </section>`).join('');
}
