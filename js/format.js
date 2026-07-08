// manager-stats · helper di formattazione (portati da chiamate-stats + KPI marketing)

export const fmt  = n => (n === null || n === undefined || isNaN(n)) ? '—' : Math.round(n).toLocaleString('it-IT');
export const fmt1 = n => (n === null || n === undefined || isNaN(n)) ? '—' : (Math.round(n * 10) / 10).toLocaleString('it-IT');

// pct(a,b) → percentuale 0-100 (o null); fmtPct la formatta "x,y%"
export const pct    = (a, b) => b > 0 ? (100 * a / b) : null;
export const fmtPct = v => v === null || v === undefined || isNaN(v) ? '—' : (Math.round(v * 10) / 10).toLocaleString('it-IT') + '%';
export const fmtMin = s => !s ? '—' : Math.round(s / 60).toLocaleString('it-IT') + ' min';

// KPI marketing
export const safeDiv = (a, b) => (b === null || b === undefined || b <= 0) ? null : a / b;      // frazione (o null)
export const eur     = n => (n === null || n === undefined || isNaN(n)) ? '—' : Math.round(n).toLocaleString('it-IT') + ' €';
export const ratio   = n => (n === null || n === undefined || isNaN(n) || !isFinite(n)) ? '—' : (Math.round(n * 10) / 10).toLocaleString('it-IT') + 'x';
export const pctFrac = frac => (frac === null || frac === undefined || isNaN(frac)) ? '—' : Math.round(frac * 100).toLocaleString('it-IT') + '%';

// numero compatto per gli assi dei grafici (12k, 1,2M)
export const fmtCompact = n => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return (Math.round(n / 1e5) / 10).toLocaleString('it-IT') + 'M';
  if (a >= 1e3) return (Math.round(n / 100) / 10).toLocaleString('it-IT') + 'k';
  return Math.round(n).toLocaleString('it-IT');
};

// date
export const dstr = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
export const dlab = iso => { const [y, m, g] = iso.split('-'); return g + '/' + m; };
export const nextDay = iso => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + 1); return dstr(d); };

export function todayRome() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
}

// html / css
export const esc  = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const cssv = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
