// manager-stats · modal dettaglio esiti + note (portato da chiamate-stats, data-source iniettata)
import { fmt, fmtPct, pct, esc, cssv } from './format.js';

const $ = id => document.getElementById(id);

function esitoColor(e) {
  if (e.is_appointment) return cssv('--series-2');
  if (e.esito_class === 'automation' || e.esito_class === 'none') return cssv('--muted');
  return cssv('--series-1');
}

let _loadNote = null;

// opts: { title, subMaker(totale)->str, loadEsiti()->[{esito,esito_class,is_appointment,n}], loadNote(esito)->[{data,testo}] }
export async function openEsiti(opts) {
  _loadNote = opts.loadNote;
  $('emTitle').textContent = opts.title || '';
  $('emSub').textContent = 'Caricamento…';
  $('emBody').innerHTML = '<div class="modal-loading">Carico gli esiti…</div>';
  $('esitiModal').classList.remove('hidden');
  try {
    const esiti = await opts.loadEsiti();
    const totale = esiti.reduce((a, e) => a + (e.n || 0), 0);
    $('emSub').textContent = opts.subMaker ? opts.subMaker(totale) : (fmt(totale) + ' righe');
    if (!esiti.length) {
      $('emBody').innerHTML = '<div class="modal-loading">Nessun dato nel periodo</div>';
      return;
    }
    const max = Math.max(...esiti.map(e => e.n), 1);
    $('emBody').innerHTML = esiti.map(e => `
      <div class="esito-row" data-esito="${esc(e.esito).replace(/"/g, '&quot;')}">
        <div class="esito-click" title="Clicca per le note della beauty">
          <div class="esito-top">
            <span class="lbl">${esc(e.esito)}</span>
            <span class="val"><b>${fmt(e.n)}</b> · ${fmtPct(pct(e.n, totale))}</span>
          </div>
          <div class="esito-track"><div class="esito-fill" style="width:${Math.max(2, Math.round(100 * e.n / max))}%; background:${esitoColor(e)}"></div></div>
        </div>
      </div>`).join('');
    document.querySelectorAll('#emBody .esito-row').forEach(row => {
      row.querySelector('.esito-click').onclick = () => toggleNote(row, row.dataset.esito);
    });
  } catch (err) {
    $('emBody').innerHTML = `<div class="modal-loading">Errore: ${esc(err.message)} — riprova.</div>`;
  }
}

async function toggleNote(row, esitoName) {
  const existing = row.querySelector('.note-box');
  if (existing) { existing.remove(); return; }
  const box = document.createElement('div');
  box.className = 'note-box';
  box.innerHTML = '<div class="note-vuote">Carico le note…</div>';
  row.appendChild(box);
  try {
    const note = _loadNote ? await _loadNote(esitoName) : [];
    if (!note.length) {
      box.innerHTML = '<div class="note-vuote">Nessuna nota della beauty su questi lead.</div>';
      return;
    }
    box.innerHTML = note.map(x =>
      `<div class="nota"><span class="nota-data">${x.data ? String(x.data).slice(0, 10).split('-').reverse().join('/') : ''}</span>${esc(x.testo)}</div>`
    ).join('');
  } catch (err) {
    box.innerHTML = `<div class="note-vuote">Errore nel caricare le note: ${esc(err.message)}</div>`;
  }
}

export function closeEsiti() { $('esitiModal').classList.add('hidden'); }

export function initModal() {
  $('emClose').onclick = closeEsiti;
  $('esitiModal').onclick = e => { if (e.target === $('esitiModal')) closeEsiti(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEsiti(); });
}
