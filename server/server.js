'use strict';
/* Tape-Server: schützt die App (Login), lässt die Engine rund um die Uhr in einem Headless-Browser laufen,
   gibt die Steuerung beim Öffnen ans Handy und zurück, sendet Alarme, sichert den Stand.
   Nur Papier-Handel gegen echte Live-Preise. Keine Börsen-Schlüssel, kein echter Handel. */
const REC = require('./rec.js'), HIST = require('./hist.js'), LEDGER = require('./ledger.js');
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
let chromium; try { ({ chromium } = require('playwright-core')); } catch (e) { ({ chromium } = require('playwright')); }

const ENV = process.env;
const PORT = +ENV.PORT || 8080, DATA = ENV.DATA_DIR || '/data', INDEX = ENV.INDEX_FILE || path.join(__dirname, 'index.html'), MOCK = ENV.MOCK || '';
const PW = ENV.APP_PASSWORD || '', BASE = 'http://127.0.0.1:' + PORT, EKEY = crypto.randomBytes(24).toString('hex');
const SECURE = ENV.DEV ? '' : '; Secure';
const LEASE_MS = 35e3, GRAB_MS = 30e3, VERSION = '1';
if (PW.length < 12) { console.error('APP_PASSWORD fehlt oder ist kürzer als 12 Zeichen – Start abgebrochen.'); process.exit(1); }
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });

const logs = []; const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); logs.push(l); if (logs.length > 200) logs.shift(); console.log(l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]);
const eq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
let chain = Promise.resolve(); const lock = fn => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

/* ---------- Zustand (Quelle der Wahrheit) ---------- */
const SF = path.join(DATA, 'state.json');
const S = { nx: null, st: null, at: 0, owner: 'server', tok: '', beat: 0, by: '' };
try { const o = JSON.parse(fs.readFileSync(SF, 'utf8')); S.nx = o.nx; S.st = o.st; S.at = o.at || 0; S.by = o.by || ''; log('Stand geladen', new Date(S.at).toISOString()); } catch (e) { log('Kein gespeicherter Stand – wartet auf das erste Öffnen am Handy'); }
let saveBusy = false;
async function saveState() {
  if (!S.nx || saveBusy) return; saveBusy = true;
  try { const tmp = SF + '.tmp'; await fs.promises.writeFile(tmp, JSON.stringify({ nx: S.nx, st: S.st, at: S.at, by: S.by })); await fs.promises.rename(tmp, SF); }
  catch (e) { log('Speichern fehlgeschlagen', e.message); notify('save', 'Server: Speichern fehlgeschlagen', String(e.message), 4); }
  saveBusy = false;
}

/* ---------- Benachrichtigungen ---------- */
const NT = { url: (ENV.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, ''), topic: ENV.NTFY_TOPIC || '', tg: ENV.TG_TOKEN || '', chat: ENV.TG_CHAT || '' };
const lastN = {}, sentHour = []; const sm = ENV.PUSH_PER_HOUR ? +ENV.PUSH_PER_HOUR : 40;
async function notify(key, title, body, prio, minGap) {
  const now = Date.now(); if (minGap && lastN[key] && now - lastN[key] < minGap) return; lastN[key] = now;
  while (sentHour.length && now - sentHour[0] > 3600e3) sentHour.shift(); if (sentHour.length >= sm && prio < 5) return; sentHour.push(now);
  log('PUSH', title, body || '');
  const jobs = [];
  if (NT.topic) jobs.push(fetch(NT.url + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: NT.topic, title, message: body || ' ', priority: prio || 3, tags: [prio >= 4 ? 'warning' : 'chart_with_upwards_trend'] }) }));
  if (NT.tg && NT.chat) jobs.push(fetch('https://api.telegram.org/bot' + NT.tg + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: NT.chat, text: title + (body ? '\n' + body : '') }) }));
  await Promise.allSettled(jobs.map(j => withTimeout(j, 10000)));
}
const NOTE = {
  'position.opened': d => ['Position offen', `${d.side} ${d.sym} ${d.qty} @ ${d.entry}`, 3, 0],
  'position.closed': d => [`Position zu: ${d.pnl >= 0 ? '+' : ''}${d.pnl} (${d.R}R)`, d.reason || '', 3, 0],
  'decision.issued': d => d.verdict === 'ask' ? ['Freigabe nötig', `${d.algo}: ${d.side} – bitte in der App entscheiden`, 4, 0] : null,
  'killswitch.on': d => ['Kill-Switch AN', d.why || '', 5, 0],
  'risk.pause': d => d && d.until > Date.now() ? ['Risiko-Pause', d.why || '', 4, 60e3] : null,
  'supervisor.pause': () => ['Supervisor: Handel pausiert', '', 4, 60e3],
  'incident.opened': d => ['Vorfall', d.what || '', 4, 60e3],
  'ops.alert': d => ['Betriebs-Alarm', d.msg || d.k || '', 4, 300e3],
  'connector.breaker_open': d => ['Datenquelle gestört', `${d.host}: ${d.errors}/${d.of} Fehler`, 4, 300e3],
  'reconcile.mismatch': () => ['Konto-Abweichung', 'Abgleich meldet eine Differenz', 5, 300e3],
  'engine.error': d => ['Engine-Fehler', String(d.m || '').slice(0, 200), 4, 600e3],
};
function onEv(type, d) { const f = NOTE[type]; if (!f) return; try { const r = f(d || {}); if (r) notify(type, r[0], r[1], r[2], r[3]); } catch (e) { /* Format egal */ } }

/* ---------- Engine (Headless-Browser) ---------- */
const E = { ctx: null, page: null, up: false, starting: false, since: 0, restarts: 0, fails: 0, health: null, failAt: 0, lastRestartFeed: 0 };
async function launchCtx() {
  if (E.ctx) return;
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) { try { fs.rmSync(path.join(DATA, 'profile', f), { force: true }); } catch (e) { /* egal */ } }   // alte Sperre nach Absturz/Neubau
  E.ctx = await chromium.launchPersistentContext(path.join(DATA, 'profile'), { headless: true, viewport: { width: 412, height: 860 }, executablePath: ENV.CHROME_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  E.ctx.on('close', () => { E.ctx = null; E.page = null; E.up = false; });
  if (MOCK) await E.ctx.addInitScript(fs.readFileSync(MOCK, 'utf8'));
}
async function engineKill() { E.up = false; try { if (E.page) await withTimeout(E.page.close({ runBeforeUnload: false }), 5000); } catch (e) { /* weg */ } E.page = null; }
async function engineKillAll() { await engineKill(); try { if (E.ctx) await withTimeout(E.ctx.close(), 8000); } catch (e) { /* weg */ } E.ctx = null; }
async function engineGrab() {
  if (!E.up || !E.page) return false;
  try {
    const o = await withTimeout(E.page.evaluate(() => { const o = JSON.parse(JSON.stringify(NX)); o.signals = o.signals.slice(0, 600); o.decisions = o.decisions.slice(0, 400); o.orders = o.orders.slice(0, 400); o.closed = o.closed.slice(0, 500); return { nx: o, st: { sym: ST.sym, src: ST.src, tf: ST.tf } }; }), 15000);
    S.nx = o.nx; S.st = o.st; S.at = Date.now(); S.by = 'server'; await saveState(); return true;
  } catch (e) { log('Abholen fehlgeschlagen', e.message); return false; }
}
async function engineStart(reason) {
  if (E.starting || !S.nx) return; E.starting = true;
  try {
    await launchCtx(); await engineKill();
    const page = await E.ctx.newPage(); E.page = page; page.setDefaultTimeout(20000);
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
    await page.exposeFunction('__ev', onEv);
    page.on('pageerror', e => log('Seitenfehler', e.message.slice(0, 200)));
    page.on('crash', () => { log('Engine-Seite abgestürzt'); E.up = false; });
    await page.goto(BASE + '/boot?k=' + EKEY);
    await page.evaluate(async ({ nx, st }) => {
      if (st) { let cur = {}; try { cur = JSON.parse(localStorage.getItem('tp:st') || '{}'); } catch (e) { /* neu */ } localStorage.setItem('tp:st', JSON.stringify(Object.assign(cur, st))); }
      if (nx) await new Promise((res, rej) => { const r = indexedDB.open('tape', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put(nx, 'nexus'); tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); });
    }, { nx: S.nx, st: S.st });
    await page.goto(BASE + '/engine?k=' + EKEY, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof NX !== 'undefined' && typeof OBS !== 'undefined' && OBS.tick > 0, null, { timeout: 40000 });
    await page.evaluate(() => onNX(e => { try { window.__ev(e.type, e.d || {}); } catch (x) { /* egal */ } }));
    E.up = true; E.since = Date.now(); E.fails = 0; E.startFails = 0; E.health = null; log('Engine läuft (' + reason + ')');
  } catch (e) { log('Engine-Start fehlgeschlagen:', e.message); E.up = false; E.failAt = Date.now(); E.startFails = (E.startFails || 0) + 1; await engineKillAll(); }
  E.starting = false;
}
async function engineRestart(reason) {
  await engineGrab(); await engineKillAll(); E.restarts++; await engineStart(reason);
  notify('restart', 'Engine neu gestartet', reason, 3, 120e3);
}
/* Wächter: erkennt hängende/abgestürzte Engine und Datenausfall */
setInterval(() => lock(async () => {
  if (S.owner !== 'server' || !S.nx || E.starting) return;
  if (!E.up) { if (Date.now() - E.failAt > Math.min(15 * 60e3, 15e3 * Math.pow(2, Math.min(6, E.startFails || 0)))) {   /* Wartezeit wächst bei wiederholtem Fehlschlag (15 s … 15 min) */ await engineStart('Wächter'); if (!E.up) notify('down', 'Engine startet nicht', 'Server versucht es weiter', 4, 600e3); } return; }
  try {
    const h = await withTimeout(E.page.evaluate(() => ({ tick: OBS.tick, msg: D.lastMsg || 0, now: Date.now(), ev: NX.events.length, pos: NX.pos.length, sym: ST.sym, src: ST.src, kill: NX.kill })), 10000);
    E.health = h; E.fails = 0;
    if (h.now - h.tick > 30e3) return engineRestart('Tick hängt');
    if (h.msg && h.now - h.msg > 600e3 && Date.now() - E.lastRestartFeed > 1800e3) { E.lastRestartFeed = Date.now(); notify('feed', 'Keine Marktdaten seit 10 min', h.sym + ' ' + h.src, 4, 1800e3); return engineRestart('Datenfeed still'); }
  } catch (e) { if (++E.fails >= 3) { log('Wächter: Engine antwortet nicht –', e.message); return engineRestart('Antwortet nicht'); } }
}), 20e3);
/* Stand regelmäßig sichern (Engine-Absturz verliert höchstens 30 s) */
setInterval(() => { if (S.owner === 'server' && E.up && !E.starting) engineGrab(); }, GRAB_MS);
/* Leihe prüfen: meldet sich das Handy nicht mehr, übernimmt der Server den zuletzt gemeldeten Stand */
setInterval(() => lock(async () => {
  if (S.owner === 'phone' && Date.now() - S.beat > LEASE_MS) { log('Handy meldet sich nicht mehr – Server übernimmt'); S.owner = 'server'; S.tok = ''; await engineStart('Übernahme'); }
}), 5e3);
/* Nächtlicher Neustart gegen Speicherwachstum (03:10 UTC) + Sicherungen alle 6 h */
let softDay = ''; setInterval(() => { const d = new Date(); if (d.getUTCHours() === 3 && d.getUTCMinutes() === 10 && softDay !== d.toISOString().slice(0, 10) && S.owner === 'server' && E.up) { softDay = d.toISOString().slice(0, 10); lock(() => engineRestart('nächtlich')); } }, 30e3);
function backup() {
  try {
    if (!fs.existsSync(SF)) return; const n = path.join(DATA, 'backups', 'state-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16) + '.json.gz');
    fs.writeFileSync(n, zlib.gzipSync(fs.readFileSync(SF))); const all = fs.readdirSync(path.join(DATA, 'backups')).sort(); while (all.length > 40) fs.unlinkSync(path.join(DATA, 'backups', all.shift()));
    log('Sicherung', path.basename(n));
  } catch (e) { notify('bk', 'Server: Sicherung fehlgeschlagen', e.message, 4, 3600e3); }
}
setInterval(backup, 6 * 3600e3); setTimeout(backup, 60e3);
if (ENV.HC_URL) setInterval(() => { if (S.owner === 'phone' || E.up) fetch(ENV.HC_URL).catch(() => {}); }, 60e3);

/* ---------- Anmeldung ---------- */
const SECRET = (() => { const f = path.join(DATA, 'secret'); try { return fs.readFileSync(f); } catch (e) { const s = crypto.randomBytes(32); fs.writeFileSync(f, s, { mode: 0o600 }); return s; } })();
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const mkCookie = () => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + 30 * 864e5 })).toString('base64url'); return p + '.' + sign(p); };
function authed(req) {
  const m = /(?:^|;\s*)tape_s=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return false; const [p, s] = m[1].split('.'); if (!p || !s || !eq(sign(p), s)) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch (e) { return false; }
}
const fails = new Map(); let gFails = [];
function ipOf(req) { const x = req.headers['x-forwarded-for']; return x ? x.split(',').pop().trim() : req.socket.remoteAddress; }
function blocked(ip) { const now = Date.now(); gFails = gFails.filter(t => now - t < 3600e3); if (gFails.length >= 40) return true; const f = (fails.get(ip) || []).filter(t => now - t < 600e3); fails.set(ip, f); return f.length >= 5; }
const LOGIN = err => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07090c"><title>Tape</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07090c;color:#e8eef5;font:16px system-ui,sans-serif}form{display:flex;flex-direction:column;gap:12px;width:min(320px,86vw)}input,button{padding:14px;border-radius:10px;border:1px solid #2a3340;background:#121820;color:#e8eef5;font:inherit}button{background:#4da3ff;color:#07090c;border:0;font-weight:600}p{margin:0;color:#ff6b6b;min-height:1.2em;font-size:14px}</style></head><body><form method="post" action="/login"><b>Tape</b><input type="password" name="pw" placeholder="Passwort" autocomplete="current-password" autofocus required><button>Anmelden</button><p>${err || ''}</p></form></body></html>`;

/* ---------- HTTP ---------- */
let cache = { m: 0, html: '' };
function appHtml(flag, extra) {
  const st = fs.statSync(INDEX); if (st.mtimeMs !== cache.m) cache = { m: st.mtimeMs, html: fs.readFileSync(INDEX, 'utf8') };
  return cache.html.replace(/<head[^>]*>/, m => m + '<script>window.' + flag + '=1;' + (extra || '') + '</script>');
}

/* ---------- Daten-Hub: öffentliche Quellen, die der Browser nicht direkt lesen darf (CORS / Kennung) ----------
   Feste Liste, kein offener Proxy. Nur lesen, keine Schlüssel. Zwischenspeicher 30 min; bei Fehler gilt der letzte Stand bis 24 h (als „alt“ markiert). */
const FRED = { spx: 'SP500', vix: 'VIXCLS', y10: 'DGS10', usd: 'DTWEXBGS' }, HUBC = new Map(), FAKE = ENV.HUB_FAKE || '';
async function hubText(url, headers) { const r = await fetch(url, { headers: Object.assign({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', accept: '*/*' }, headers || {}), signal: AbortSignal.timeout(20e3) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }
function fredPts(csv) { const out = []; for (const ln of csv.split(/\r?\n/).slice(1)) { const [d, v] = ln.split(','); const t = Date.parse(d + 'T00:00:00Z'), x = parseFloat(v); if (isFinite(t) && isFinite(x)) out.push([t, x]); } return out.slice(-700); }
async function hubBuild(id) {
  if (id === 'macro') {
    const o = {}, ks = Object.keys(FRED);
    await Promise.all(ks.map(async k => { try { const pts = fredPts(await hubText(FAKE ? FAKE + '/fred?id=' + FRED[k] : 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + FRED[k])); if (pts.length < 5) throw new Error('keine Daten'); o[k] = { pts, src: 'FRED ' + FRED[k] }; } catch (e) { o[k] = { err: String(e.message || e) }; } }));
    return { series: o };
  }
  if (id === 'cnn') {
    const j = JSON.parse(await hubText(FAKE ? FAKE + '/cnn' : 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { origin: 'https://edition.cnn.com', referer: 'https://edition.cnn.com/' }));
    const h = j.fear_and_greed_historical && j.fear_and_greed_historical.data; if (!Array.isArray(h) || h.length < 5) throw new Error('Format weicht ab');
    return { now: j.fear_and_greed ? { score: +j.fear_and_greed.score, rating: j.fear_and_greed.rating } : null, pts: h.slice(-400).map(x => [+x.x, +x.y]), src: 'CNN (inoffiziell)' };
  }
  if (id === 'gex_btc' || id === 'gex_eth') {   // Optionen-Gamma aus Deribits freien Daten (Modell mit Annahme, siehe gexCalc)
    const cur = id.slice(4).toUpperCase(), j = JSON.parse(await hubText(FAKE ? FAKE + '/deribit?currency=' + cur : 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=' + cur + '&kind=option', { accept: 'application/json' }));
    return gexCalc(cur, j.result);
  }
  if (id === 'bg') {   // BGeometrics frei: 8/h, 15/Tag → nacheinander, 4 Abrufe je 8 h; Format tolerant gelesen (ungeprüft gegen die echte Schnittstelle)
    const o = {};
    const prev = (HUBC.get('bg') || {}).v, day = new Date().toISOString().slice(0, 10), cf = path.join(DATA, 'hub-bg-count.json'); let cnt = { day, n: 0 }; try { const c = JSON.parse(fs.readFileSync(cf, 'utf8')); if (c.day === day) cnt = c; } catch (e) { /* neu */ }
    for (const [k, ep] of Object.entries(BG)) { if (cnt.n >= 12) { o[k] = prev && prev.series && prev.series[k] && prev.series[k].pts ? Object.assign({}, prev.series[k], { stale: true }) : { err: 'Tageslimit (12 Abrufe) erreicht' }; continue; } cnt.n++; try { fs.writeFileSync(cf, JSON.stringify(cnt)); } catch (e) { /* egal */ } try { const pts = bgPts(JSON.parse(await hubText(FAKE ? FAKE + '/bg?ep=' + ep : 'https://bitcoin-data.com/v1/' + ep, { accept: 'application/json' }))); if (pts.length < 30) throw new Error('Format weicht ab oder keine Daten'); o[k] = { pts, src: 'BGeometrics ' + ep }; } catch (e) { o[k] = prev && prev.series && prev.series[k] && prev.series[k].pts ? Object.assign({}, prev.series[k], { stale: true, err: String(e.message || e) }) : { err: String(e.message || e) }; } }
    if (!Object.values(o).some(x => x.pts)) throw new Error(Object.values(o).map(x => x.err)[0] || 'keine Daten');
    return { series: o };
  }
  throw new Error('unbekannt');
}
/* GEX-Modell: Black-Scholes-Gamma (Zins 0) je Option mit Deribits Mark-Volatilität × Open Interest. Annahme (üblich, nicht gemessen): Händler sind long Calls und short Puts
   → Calls +, Puts −. Ob das stimmt, weiß niemand; deshalb ist das ein Modell und nur Kontext. Ergebnis in USD je 1 % Kursbewegung. */
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const npdf = x => Math.exp(-x * x / 2) / 2.5066282746;
function gexCalc(cur, list) {
  if (!Array.isArray(list) || list.length < 20) throw new Error('Deribit: zu wenige Optionen (Format?)');
  const now = Date.now(), opts = []; let spot = 0;
  for (const o of list) { const m = /^\w+-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(o.instrument_name || ''); if (!m || !(o.open_interest > 0) || !(o.mark_iv > 0) || !(o.underlying_price > 0)) continue;
    const exp = Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8), T = (exp - now) / (365 * 864e5); if (!(T > 0.0005)) continue; spot = o.underlying_price; opts.push({ K: +m[4], T, iv: o.mark_iv / 100, oi: o.open_interest, sg: m[5] === 'C' ? 1 : -1, exp }); }
  if (opts.length < 20 || !spot) throw new Error('Deribit: keine auswertbaren Optionen');
  const at = S => { const by = new Map(); let tot = 0; for (const o of opts) { const d1 = (Math.log(S / o.K) + o.iv * o.iv / 2 * o.T) / (o.iv * Math.sqrt(o.T)), g = npdf(d1) / (S * o.iv * Math.sqrt(o.T)), v = o.sg * g * o.oi * S * S * 0.01; tot += v; by.set(o.K, (by.get(o.K) || 0) + v); } return { tot, by }; };
  const base = at(spot); let flip = null, prev = null;
  for (let i = 0; i <= 60; i++) { const S = spot * (0.8 + i * 0.01), t = at(S).tot; if (prev && Math.sign(prev[1]) !== Math.sign(t) && t !== 0) { flip = prev[0] + (S - prev[0]) * (0 - prev[1]) / (t - prev[1]); break; } prev = [S, t]; }
  const ks = [...base.by.entries()].filter(([K]) => K > spot * 0.75 && K < spot * 1.25).sort((a, b) => a[0] - b[0]), pos = ks.filter(x => x[1] > 0).sort((a, b) => b[1] - a[1])[0], neg = ks.filter(x => x[1] < 0).sort((a, b) => a[1] - b[1])[0];
  return { cur, spot, total: base.tot, flip, callWall: pos ? pos[0] : null, putWall: neg ? neg[0] : null, strikes: ks.map(([K, v]) => [K, Math.round(v)]), n: opts.length, exp: new Set(opts.map(o => o.exp)).size, src: 'Deribit (öffentlich) + Black-Scholes, Annahme: Händler long Calls / short Puts', at: now };
}
const BG = { sthrp: 'sth-realized-price', sopr: 'sopr', nupl: 'nupl', sthmvrv: 'sth-mvrv' };
function bgPts(j) {
  const a = Array.isArray(j) ? j : (j && (j.data || j.result)) || []; const out = [];
  for (const r of a) { if (!r || typeof r !== 'object') continue; const ts = r.unixTs != null ? +r.unixTs : null, t = ts ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(r.d || r.theDay || r.date || r.time); const vk = Object.keys(r).find(k => !/^(d|theDay|date|time|unixTs|ts|timestamp)$/i.test(k) && r[k] !== null && r[k] !== '' && isFinite(+r[k])); const v = vk ? +r[vk] : NaN; if (isFinite(t) && isFinite(v)) out.push([t, v]); }
  return out.sort((x, y) => x[0] - y[0]).slice(-1500);
}
const HUBTTL = { bg: 8 * 3600e3, gex_btc: 10 * 60e3, gex_eth: 10 * 60e3 }, HUBDISK = ['bg'];
for (const id of HUBDISK) { try { HUBC.set(id, JSON.parse(fs.readFileSync(path.join(DATA, 'hub-' + id + '.json'), 'utf8'))); } catch (e) { /* noch nichts */ } }
const hubBusy = new Map();
async function hubGet(id) {
  const c = HUBC.get(id), now = Date.now(); if (c && now - c.t < (HUBTTL[id] || 30 * 60e3)) return Object.assign({}, c.v, { cached: true });
  if (c && c.failAt && now - c.failAt < 30 * 60e3) return Object.assign({}, c.v, { stale: true, err: c.err });    // nach Fehler nicht sofort wieder (Abruf-Grenzen)
  const fl = HUBC.get(id + ':fail'); if (!c && fl && now - fl.t < 30 * 60e3) throw new Error(fl.err + ' (nächster Versuch ' + Math.ceil((30 * 60e3 - (now - fl.t)) / 60e3) + ' min)');
  if (hubBusy.has(id)) return hubBusy.get(id);
  const job = (async () => { try { const v = await hubBuild(id); const e = { t: now, v }; HUBC.set(id, e); if (HUBDISK.includes(id)) fs.promises.writeFile(path.join(DATA, 'hub-' + id + '.json'), JSON.stringify(e)).catch(() => {}); return v; }
    catch (x) { if (c) { c.failAt = now; c.err = String(x.message || x); } if (c && now - c.t < 3 * 864e5) return Object.assign({}, c.v, { stale: true, err: String(x.message || x) }); if (!c) HUBC.set(id + ':fail', { t: now, err: String(x.message || x) }); throw x; } finally { hubBusy.delete(id); } })();
  hubBusy.set(id, job); return job;
}
function readBody(req, max) { return new Promise((res, rej) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > max) { rej(new Error('zu groß')); req.destroy(); } else c.push(d); }); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); }); }
const send = (res, code, body, type, extra) => { res.writeHead(code, Object.assign({ 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' }, extra || {})); res.end(body); };
const json = (res, code, o) => send(res, code, JSON.stringify(o), 'application/json');
const tokOk = (req, url) => S.owner === 'phone' && S.tok && eq(req.headers['x-ctl'] || url.searchParams.get('t') || '', S.tok);
const lostWhy = () => (S.owner === 'phone' ? 'other' : 'lease');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (p === '/healthz') return send(res, 200, 'ok');
    if ((p === '/engine' || p === '/boot') && eq(url.searchParams.get('k') || '', EKEY)) return send(res, 200, p === '/engine' ? appHtml('__ENGINE', 'window.__HK=' + JSON.stringify(EKEY)) : '<!doctype html><title>boot</title>', 'text/html; charset=utf-8');
    if (p === '/api/hub' && (authed(req) || eq(url.searchParams.get('k') || '', EKEY))) {
      const id = url.searchParams.get('id') || ''; if (!['macro', 'cnn', 'bg', 'gex_btc', 'gex_eth'].includes(id)) return json(res, 404, { err: 'unbekannt' });
      try { return json(res, 200, Object.assign({ ok: true, id, at: Date.now() }, await hubGet(id))); } catch (e) { return json(res, 502, { ok: false, err: String(e.message || e) }); }
    }
    if (p === '/api/rec' && (authed(req) || eq(url.searchParams.get('k') || '', EKEY))) {
      if (!recorder) return json(res, 503, { ok: false, err: 'Recorder aus' });
      if (url.searchParams.get('status')) return json(res, 200, Object.assign({ ok: true }, recorder.status()));
      const sym = (url.searchParams.get('sym') || 'BTC').toUpperCase(); if (!recorder.SYMS.includes(sym)) return json(res, 404, { err: 'unbekanntes Symbol' });
      return json(res, 200, Object.assign({ ok: true }, recorder.query(sym, +url.searchParams.get('h') || 720)));
    }
    if (p === '/api/ledger' && (authed(req) || eq(url.searchParams.get('k') || '', EKEY))) {
      if (!ledger) return json(res, 503, { ok: false, err: 'Bilanz aus' });
      if (req.method === 'POST') { let o; try { o = JSON.parse((await readBody(req, 2e6)).toString()); } catch (e) { return json(res, 400, { ok: false, err: 'kein JSON' }); } return json(res, 200, { ok: true, added: ledger.add(o.signals) }); }
      return json(res, 200, { ok: true, at: Date.now(), status: ledger.status(), stats: ledger.stats(), cp: LEDGER.CP });
    }
    if (p === '/api/hist' && (authed(req) || eq(url.searchParams.get('k') || '', EKEY))) {
      if (!history) return json(res, 503, { ok: false, err: 'Historie aus' });
      if (url.searchParams.get('status')) return json(res, 200, Object.assign({ ok: true }, history.status()));
      const sym = (url.searchParams.get('sym') || 'BTC').toUpperCase(); if (!history.SYMS.includes(sym)) return json(res, 404, { ok: false, err: 'Historie nur für ' + history.SYMS.join(', ') });
      const h = history.get(sym); if (!h) return json(res, 503, { ok: false, err: history.status().busy ? 'Historie wird gerade geladen (einmalig einige Minuten)' : 'noch keine Historie' + (history.status().err ? ': ' + history.status().err : '') });
      const body = JSON.stringify(Object.assign({ ok: true }, h)); if (/gzip/.test(req.headers['accept-encoding'] || '')) return send(res, 200, zlib.gzipSync(body), 'application/json', { 'content-encoding': 'gzip' }); return send(res, 200, body, 'application/json');
    }
    if (p === '/login') {
      if (req.method === 'POST') {
        const ip = ipOf(req); if (blocked(ip)) return send(res, 429, LOGIN('Zu viele Versuche – bitte später erneut.'), 'text/html; charset=utf-8');
        const b = new URLSearchParams((await readBody(req, 4096)).toString());
        if (eq(b.get('pw') || '', PW)) { fails.delete(ip); return send(res, 302, '', 'text/plain', { location: '/', 'set-cookie': 'tape_s=' + mkCookie() + '; Path=/; Max-Age=2592000; HttpOnly' + SECURE + '; SameSite=Strict' }); }
        gFails.push(Date.now()); (fails.get(ip) || fails.set(ip, []).get(ip)).push(Date.now()); log('Login falsch von', ip); await sleep(800);
        return send(res, 401, LOGIN('Falsches Passwort.'), 'text/html; charset=utf-8');
      }
      return send(res, 200, LOGIN(''), 'text/html; charset=utf-8');
    }
    if (p === '/logout') return send(res, 302, '', 'text/plain', { location: '/login', 'set-cookie': 'tape_s=; Path=/; Max-Age=0; HttpOnly' + SECURE + '; SameSite=Strict' });
    if (!authed(req)) { if (p.startsWith('/api/')) return json(res, 401, { err: 'login' }); return send(res, 302, '', 'text/plain', { location: '/login' }); }
    if (p === '/dev/eval' && ENV.DEV && E.page) { const r = await E.page.evaluate((await readBody(req, 1e5)).toString()); return json(res, 200, { r }); }
    if (p === '/' || p === '/index.html') return send(res, 200, appHtml('__SERVER'), 'text/html; charset=utf-8');

    if (p === '/api/take' && req.method === 'POST') {
      const r = await lock(async () => {
        if (S.owner === 'server') { await engineGrab(); await engineKill(); }
        S.owner = 'phone'; S.tok = crypto.randomBytes(18).toString('hex'); S.beat = Date.now();
        return { tok: S.tok, nx: S.nx, st: S.st, at: S.at };
      });
      return json(res, 200, r);
    }
    if (p === '/api/beat' && req.method === 'POST') { if (!tokOk(req, url)) return json(res, 409, { why: lostWhy() }); S.beat = Date.now(); return json(res, 200, { ok: true }); }
    if (p === '/api/push' && req.method === 'POST') {
      if (!tokOk(req, url)) return json(res, 409, { why: lostWhy() });
      let buf = await readBody(req, 30e6); if (req.headers['x-gz']) buf = zlib.gunzipSync(buf, { maxOutputLength: 120e6 });
      const o = JSON.parse(buf.toString()); if (!o.nx || o.nx.v !== 1) return json(res, 400, { err: 'Stand ungültig' });
      S.nx = o.nx; S.st = o.st || S.st; S.at = Date.now(); S.by = 'phone'; S.beat = Date.now(); saveState(); return json(res, 200, { ok: true });
    }
    if (p === '/api/release' && req.method === 'POST') {
      if (!tokOk(req, url)) return json(res, 409, { why: lostWhy() });
      lock(async () => { S.owner = 'server'; S.tok = ''; await engineStart('Handy hat abgegeben'); }); return json(res, 200, { ok: true });
    }
    if (p === '/api/status') {
      return json(res, 200, { version: VERSION, uptime: Math.round(process.uptime()), owner: S.owner, haveState: !!S.nx, stateAt: S.at, stateBy: S.by, beatAgo: S.owner === 'phone' ? Date.now() - S.beat : null,
        engine: { up: E.up, since: E.since, restarts: E.restarts, health: E.health }, rec: recorder ? recorder.status() : null, hist: history ? history.status() : null, ledger: ledger ? ledger.status() : null, notify: { ntfy: !!NT.topic, telegram: !!(NT.tg && NT.chat), healthcheck: !!ENV.HC_URL }, backups: fs.readdirSync(path.join(DATA, 'backups')).length, log: logs.slice(-30) });
    }
    if (p === '/api/export') { if (S.owner === 'server') await lock(engineGrab); return send(res, 200, JSON.stringify({ app: 'server', at: new Date().toISOString(), state: S.nx }, null, 1), 'application/json', { 'content-disposition': 'attachment; filename="nexus-server-' + new Date().toISOString().slice(0, 10) + '.json"' }); }
    return send(res, 404, 'nicht gefunden');
  } catch (e) { log('Fehler', req.url, e.message); try { send(res, 500, 'Fehler'); } catch (x) { /* weg */ } }
});
server.headersTimeout = 20e3; server.requestTimeout = 60e3;
let history = null; if (ENV.HIST !== '0') { try { history = HIST.start(DATA, log); } catch (e) { log('Historie-Start fehlgeschlagen:', e.message); } }
let recorder = null; if (ENV.REC !== '0') { try { recorder = REC.start(DATA, log); } catch (e) { log('Recorder-Start fehlgeschlagen:', e.message); } }
let ledger = null; try { ledger = LEDGER.start(DATA, log, recorder); } catch (e) { log('Bilanz-Start fehlgeschlagen:', e.message); }
server.listen(PORT, ENV.BIND || '0.0.0.0', () => { log('Server auf Port', PORT); if (S.nx) lock(() => engineStart('Start')); });

async function bye() { log('Beende …'); try { if (recorder) recorder.stop(); } catch (e) { /* egal */ } try { await withTimeout(lock(async () => { if (S.owner === 'server') await engineGrab(); await saveState(); await engineKillAll(); }), 15e3); } catch (e) { try { await saveState(); } catch (x) { /* egal */ } } process.exit(0); }
process.on('SIGTERM', bye); process.on('SIGINT', bye);
process.on('uncaughtException', e => log('uncaught', e.stack || e)); process.on('unhandledRejection', e => log('unhandled', e && e.stack || e));
