'use strict';
/* Historie aus den freien Binance-Archiven (data.binance.vision): Stundenkerzen Spot + Perp mit Taker-Kaufvolumen,
   Funding (Perp) und Open Interest (Perp, Tageswerte in 5-min-Schritten → je volle Stunde).
   Lädt einmalig rückwärts (Standard 36 Monate), danach täglich die neuen Tage. Alles bleibt auf der Platte (DATA/hist).
   Nur feste Adressen, nur lesen. Fehlt eine Datei (404), wird sie einen Tag lang nicht erneut versucht. */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const H = 3600e3, BASE = 'https://data.binance.vision/data/';
const SYMS = (process.env.HIST_SYMS || 'BTC,ETH,SOL').split(',').map(s => s.trim()).filter(Boolean);
const MONTHS = +process.env.HIST_MONTHS || 36, OI_DAYS = +process.env.HIST_OI_DAYS || 400;

/* ZIP mit genau einer Datei entpacken (Zentralverzeichnis lesen, dann Deflate) */
function unzip1(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--; if (e < 0) throw new Error('kein ZIP');
  const cd = buf.readUInt32LE(e + 16); if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('ZIP-Verzeichnis kaputt');
  const meth = buf.readUInt16LE(cd + 10), csz = buf.readUInt32LE(cd + 20), lo = buf.readUInt32LE(cd + 42);
  const st = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), data = buf.subarray(st, st + csz);
  return (meth === 8 ? zlib.inflateRawSync(data) : meth === 0 ? data : (() => { throw new Error('ZIP-Methode ' + meth); })()).toString();
}
const ms = t => t > 1e14 ? Math.floor(t / 1000) : t;     // Spot-Archive ab 2025 in Mikrosekunden
const rows = csv => csv.split(/\r?\n/).map(l => l.split(',')).filter(r => r.length > 2 && /^\d/.test(r[0]));   // Kopfzeilen fallen weg

function start(DATA, log) {
  const DIR = path.join(DATA, 'hist'); fs.mkdirSync(DIR, { recursive: true });
  const FAKE = process.env.HIST_FAKE || '', st = { busy: false, files: 0, miss: 0, err: '', at: 0, last: '' }, miss = new Map(), mem = new Map();
  const urlOf = rel => FAKE ? FAKE + '/' + rel : BASE + rel;
  async function getZip(rel) {
    const f = path.join(DIR, rel.replace(/\//g, '_').replace(/\.zip$/, '.json'));
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    const m = miss.get(rel); if (m && Date.now() - m < 864e5) return null;
    const r = await fetch(urlOf(rel), { signal: AbortSignal.timeout(60e3) }); if (r.status === 404) { miss.set(rel, Date.now()); st.miss++; return null; } if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + rel);
    const out = rows(unzip1(Buffer.from(await r.arrayBuffer()))); fs.writeFileSync(f, JSON.stringify(out)); st.files++; st.last = rel; await new Promise(z => setTimeout(z, FAKE ? 0 : 150)); return out;
  }
  const ym = d => d.toISOString().slice(0, 7), ymd = d => d.toISOString().slice(0, 10);
  function plan(sym) {
    const S = sym + 'USDT', now = new Date(), jobs = [], m0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHS, 1));
    for (let d = new Date(m0); d < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); d.setUTCMonth(d.getUTCMonth() + 1)) {
      jobs.push(['s', 'spot/monthly/klines/' + S + '/1h/' + S + '-1h-' + ym(d) + '.zip'], ['p', 'futures/um/monthly/klines/' + S + '/1h/' + S + '-1h-' + ym(d) + '.zip'], ['f', 'futures/um/monthly/fundingRate/' + S + '/' + S + '-fundingRate-' + ym(d) + '.zip']);
    }
    for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); ymd(d) < ymd(now); d.setUTCDate(d.getUTCDate() + 1)) jobs.push(['s', 'spot/daily/klines/' + S + '/1h/' + S + '-1h-' + ymd(d) + '.zip'], ['p', 'futures/um/daily/klines/' + S + '/1h/' + S + '-1h-' + ymd(d) + '.zip']);
    for (let i = OI_DAYS; i >= 1; i--) { const d = new Date(Date.now() - i * 864e5); jobs.push(['o', 'futures/um/daily/metrics/' + S + '/' + S + '-metrics-' + ymd(d) + '.zip']); }
    return jobs;
  }
  /* Laufende Stundenreihe je Symbol aufbauen */
  async function build(sym) {
    const K = { s: new Map(), p: new Map() }, F = [], O = new Map();
    for (const [k, rel] of plan(sym)) {
      let r; try { r = await getZip(rel); } catch (e) { st.err = String(e.message || e); log('Historie: ' + st.err); continue; } if (!r) continue;
      if (k === 's' || k === 'p') for (const x of r) { const t = ms(+x[0]); K[k].set(t, [+x[1], +x[4], +x[7], +x[10]]); }        // open, close, quote vol, taker buy quote
      else if (k === 'f') for (const x of r) F.push([ms(+x[0]), +x[2]]);
      else for (const x of r) { const t = Date.parse(String(x[0]).replace(' ', 'T') + 'Z'); if (isFinite(t) && t % H === 0) O.set(t, +x[3]); }  // sum_open_interest_value
    }
    const ts = [...K.p.keys()].filter(t => K.s.has(t)).sort((a, b) => a - b); if (ts.length < 100) { mem.set(sym, null); return; }
    F.sort((a, b) => a[0] - b[0]); const t0 = ts[0], n = Math.round((ts[ts.length - 1] - t0) / H) + 1;
    const A = { so: [], sc: [], sd: [], po: [], pc: [], pd: [], oi: [], fr: [] }; let fi = 0, fr = null;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * H, s = K.s.get(t), p = K.p.get(t); while (fi < F.length && F[fi][0] <= t) fr = F[fi++][1];
      A.so.push(s ? s[0] : null); A.sc.push(s ? s[1] : null); A.sd.push(s ? Math.round(2 * s[3] - s[2]) : null); A.po.push(p ? p[0] : null); A.pc.push(p ? p[1] : null); A.pd.push(p ? Math.round(2 * p[3] - p[2]) : null);
      A.oi.push(O.has(t) ? Math.round(O.get(t)) : null); A.fr.push(fr);
    }
    mem.set(sym, Object.assign({ sym, t0, step: H, n, at: Date.now() }, A));
  }
  async function run() {
    if (st.busy) return; st.busy = true; const t = Date.now();
    for (const s of SYMS) { try { await build(s); } catch (e) { st.err = String(e.message || e); log('Historie ' + s + ': ' + st.err); } }
    st.busy = false; st.at = Date.now(); log('Historie aktualisiert (' + st.files + ' Dateien geladen, ' + Math.round((Date.now() - t) / 1000) + ' s)');
  }
  setTimeout(run, +process.env.HIST_DELAY || 30e3); setInterval(() => { const d = new Date(); if (d.getUTCHours() === 4 && d.getUTCMinutes() < 10) run(); }, 10 * 60e3);
  return { get: sym => mem.get(sym) || null, status: () => Object.assign({ symbols: SYMS, months: MONTHS, ready: SYMS.filter(s => mem.get(s)) }, st), run, SYMS };
}
module.exports = { start, unzip1 };
