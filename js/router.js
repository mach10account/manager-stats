// manager-stats · hash routing con query params (#/marketing?centro=..&campaign=..)

export function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '') || '/panoramica';
  const [path, qs] = raw.split('?');
  const params = new URLSearchParams(qs || '');
  return { path: path || '/panoramica', params };
}

export function navigate(path, params) {
  let h = path;
  if (params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') usp.set(k, v);
    }
    const s = usp.toString();
    if (s) h += '?' + s;
  }
  if (('#' + h) === location.hash) {
    // stesso hash: forza comunque un re-render
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = h;
  }
}

export function startRouter(onRoute) {
  window.addEventListener('hashchange', () => onRoute(parseHash()));
  onRoute(parseHash());
}
