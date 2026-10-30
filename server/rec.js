'use strict';
/* Recorder: schneidet öffentliche Handels-Streams (nur lesen, keine Schlüssel) mit und verdichtet sie zu Minuten-/Stunden-Werten.
   Quellen: Binance Spot+Perp, Bybit Spot+Perp, Coinbase Spot, Hyperliquid Perp – für BTC, ETH, SOL.
   Je Minute und Reihe: Käufer-Volumen (Taker kauft), Verkäufer-Volumen, Anzahl, Open/High/Low/Close – in Quote-Währung (USDT bzw. USD).
   Eine Minute zählt nur als „live“, wenn die Verbindung stand (sonst Lücke statt erfundener Nullen).
   Ablage: DATA/rec/m-JJJJ-MM-TT.jsonl (Minuten, 2 Tage), danach verdichtet zu h-JJJJ-MM-TT.json (Stunden, bleibt). */
const fs = require('fs'), path = require('path');

const SYMS = (process.env.REC_SYMS || 'BTC,ETH,SOL').split(',').map(s => s.trim()).filter(Boolean);
const MIN = 60e3, HOUR = 3600e3;

/* Eine Börse = ein Eintrag. parse() liefert über emit(sym, takerKauft, preis, menge) – Seite ist immer die des Takers (Aggressor). */
const VEN = {
  'bn:s': { name: 'Binance Spot', quote: 'USDT', url: 'wss://stream.binance.com:9443/stream?streams=' + SYMS.map(s => s.toLowerCase() + 'usdt@aggTrade').join('/'),
    parse(j, emit) { const d = j && j.data; if (!d || d.e !== 'aggTrade') return; emit(d.s.replace(/USDT$/, ''), !d.m, +d.p, +d.q); } },
  'bn:p': { name: 'Binance Perp', quote: 'USDT', url: 'wss://fstream.binance.com/stream?streams=' + SYMS.map(s => s.toLowerCase() + 'usdt@aggTrade').join('/'),
    parse(j, emit) { const d = j && j.data; if (!d || d.e !== 'aggTrade') return; emit(d.s.replace(/USDT$/, ''), !d.m, +d.p, +d.q); } },
  'by:s': { name: 'Bybit Spot', quote: 'USDT', url: 'wss://stream.bybit.com/v5/public/spot', ping: '{"op":"ping"}', pingMs: 20e3,
    sub: () => [{ op: 'subscribe', args: SYMS.map(s => 'publicTrade.' + s + 'USDT') }],
    parse(j, emit) { if (!j || !/^publicTrade\./.test(j.topic || '') || !Array.isArray(j.data)) return; for (const t of j.data) emit(String(t.s).replace(/USDT$/, ''), t.S === 'Buy', +t.p, +t.v); } },
  'by:p': { name: 'Bybit Perp', quote: 'USDT', url: 'wss://stream.bybit.com/v5/public/linear', ping: '{"op":"ping"}', pingMs: 20e3,
    sub: () => [{ op: 'subscribe', args: SYMS.map(s => 'publicTrade.' + s + 'USDT') }],
    parse(j, emit) { if (!j || !/^publicTrade\./.test(j.topic || '') || !Array.isArray(j.data)) return; for (const t of j.data) emit(String(t.s).replace(/USDT$/, ''), t.S === 'Buy', +t.p, +t.v); } },
  /* Coinbase (Exchange-Feed „matches“): side = Seite des Makers → der Taker ist die Gegenseite */
  'cb:s': { name: 'Coinbase Spot', quote: 'USD', url: 'wss://ws-feed.exchange.coinbase.com',
    sub: () => [{ type: 'subscribe', product_ids: SYMS.map(s => s + '-USD'), channels: ['matches'] }],
    parse(j, emit) { if (!j || j.type !== 'match') return; emit(String(j.product_id).replace(/-USD$/, ''), j.side === 'sell', +j.price, +j.size); } },
  /* Hyperliquid: side B = Käufer-Aggressor, A = Verkäufer-Aggressor (laut Doku; im Betrieb gegen Binance gegenprüfbar) */
  'hl:p': { name: 'Hyperliquid Perp', quote: 'USD', url: 'wss://api.hyperliquid.xyz/ws', ping: '{"method":"ping"}', pingMs: 30e3,
    sub: () => SYMS.map(s => ({ method: 'subscribe', subscription: { type: 'trades', coin: s } })),
    parse(j, emit) { if (!j || j.channel !== 'trades' || !Array.isArray(j.data)) return; for (const t of j.data) emit(String(t.coin), t.side === 'B', +t.px, +t.sz); } },
};
const KEYS = Object.keys(VEN);

function start(DATA, log) {
  const DIR = path.join(DATA, 'rec'); fs.mkdirSync(DIR, { recursive: true });
  const URLS = (() => { try { return JSON.parse(process.env.REC_URLS || '{}'); } catch (e) { return {}; } })();
  const RS = {};                       // Verbindungsstatus je Reihe
  const CUR = new Map();               // laufende Minute: "BTC|bn:s" → Bucket
  const DONE = new Set();              // schon geschriebene Minuten (gegen Doppelzeilen)
  const H = new Map();                 // "BTC|bn:s" → Map(stunde → {bu,se,n,o,h,l,c,t0,t1,lv})
  let pending = [];                    // geschlossene Minuten, noch nicht auf der Platte
  const st = { started: Date.now(), rows: 0, loaded: 0, err: '' };

  const hourOf = t => Math.floor(t / HOUR) * HOUR;
  function addHour(sym, key, m, bu, se, n, o, h, l, c, lv) {
    const k = sym + '|' + key; let hm = H.get(k); if (!hm) H.set(k, hm = new Map());
    const hh = hourOf(m); let e = hm.get(hh); if (!e) hm.set(hh, e = { bu: 0, se: 0, n: 0, o: null, h: null, l: null, c: null, t0: Infinity, t1: -Infinity, lv: 0 });
    e.bu += bu; e.se += se; e.n += n; e.lv += lv;
    if (n > 0) { if (m < e.t0) { e.t0 = m; e.o = o; } if (m >= e.t1) { e.t1 = m; e.c = c; } e.h = e.h == null ? h : Math.max(e.h, h); e.l = e.l == null ? l : Math.min(e.l, l); }
  }
  const r2 = x => x == null ? null : Math.round(x * 100) / 100;
  function closeB(b) {
    const k = b.sym + '|' + b.key; if (CUR.get(k) === b) CUR.delete(k); if (DONE.has(k + '|' + b.m)) return; DONE.add(k + '|' + b.m);
    const row = [b.m, b.sym, b.key, r2(b.bu), r2(b.se), b.n, b.n ? b.o : null, b.n ? b.h : null, b.n ? b.l : null, b.n ? b.c : null];
    pending.push(row); st.rows++; addHour(b.sym, b.key, b.m, row[3], row[4], row[5], row[6], row[7], row[8], row[9], 1);
  }
  function add(key, sym, buy, px, q) {
    if (!(px > 0 && q > 0) || !SYMS.includes(sym)) return;
    const now = Date.now(), m = Math.floor(now / MIN) * MIN, k = sym + '|' + key; let b = CUR.get(k);
    if (b && b.m !== m) { closeB(b); b = null; }
    if (!b) { if (DONE.has(k + '|' + m)) return; CUR.set(k, b = { sym, key, m, bu: 0, se: 0, n: 0, o: px, h: px, l: px, c: px }); }
    const usd = px * q; if (buy) b.bu += usd; else b.se += usd; b.n++; b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); b.c = px;
  }

  /* ----- Verbindungen ----- */
  function conn(key) {
    const V = VEN[key], s = RS[key] = { open: false, last: 0, msgs: 0, recon: 0, err: '', since: 0, url: '' };
    let ws = null, pingT = null, backoff = 2000, retryT = null;
    const live = () => s.open && Date.now() - s.last < 60e3;
    s.live = live;
    function retry(why) { s.open = false; s.err = String(why || ''); clearInterval(pingT); if (retryT) return; s.recon++; retryT = setTimeout(() => { retryT = null; go(); }, backoff); backoff = Math.min(backoff * 2, 60e3); }
    function go() {
      const url = URLS[key] || V.url; s.url = url; let w; try { w = new WebSocket(url); } catch (e) { return retry(e.message); }
      ws = w; let dead = false;
      const drop = why => { if (dead) return; dead = true; try { w.close(); } catch (e) { /* weg */ } retry(why); };
      w.onopen = () => { s.open = true; s.last = Date.now(); s.since = Date.now(); s.err = ''; backoff = 2000; try { for (const m of (V.sub ? V.sub() : [])) w.send(typeof m === 'string' ? m : JSON.stringify(m)); } catch (e) { return drop(e.message); } if (V.ping) pingT = setInterval(() => { try { w.send(V.ping); } catch (e) { /* Wächter holt nach */ } }, V.pingMs || 20e3); };
      w.onmessage = ev => { s.last = Date.now(); s.msgs++; let j; try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (e) { return; } try { V.parse(j, (sym, buy, px, q) => add(key, sym, buy, px, q)); } catch (e) { /* ein Format-Ausreißer stoppt nicht die Aufnahme */ } };
      w.onerror = e => drop(e && e.message || 'Fehler');
      w.onclose = () => drop('geschlossen');
      s.kill = () => drop('Wächter');
    }
    go();
  }

  /* ----- Minuten-Takt: Minute schließen, Nullzeilen für lebende, ruhige Reihen ----- */
  let lastM = Math.floor(Date.now() / MIN) * MIN;
  setInterval(() => {
    const now = Date.now(), m = Math.floor(now / MIN) * MIN;
    for (const b of [...CUR.values()]) if (b.m < m) closeB(b);
    if (m > lastM) {
      const pm = lastM;
      for (const key of KEYS) if (RS[key] && RS[key].live() && RS[key].since <= pm + 5e3) for (const sym of SYMS) { const k = sym + '|' + key; if (!DONE.has(k + '|' + pm) && !CUR.has(k)) closeB({ sym, key, m: pm, bu: 0, se: 0, n: 0 }); }
      lastM = m; for (const x of DONE) if (+x.split('|')[2] < m - 5 * MIN) DONE.delete(x);
    }
    for (const key of KEYS) { const s = RS[key]; if (s && s.open && now - s.last > 90e3 && s.kill) { log('Recorder: ' + key + ' still – neu verbinden'); s.kill(); } }
  }, 1000);

  /* ----- Platte ----- */
  const dayOf = t => new Date(t).toISOString().slice(0, 10);
  function flush() {
    if (!pending.length) return; const by = {}; for (const r of pending) (by[dayOf(r[0])] || (by[dayOf(r[0])] = [])).push(JSON.stringify(r)); pending = [];
    try { for (const d in by) fs.appendFileSync(path.join(DIR, 'm-' + d + '.jsonl'), by[d].join('\n') + '\n'); st.err = ''; } catch (e) { st.err = 'Schreiben: ' + e.message; log('Recorder: ' + st.err); }
  }
  function compact() {
    try {
      const today = dayOf(Date.now()), yest = dayOf(Date.now() - 864e5);
      for (const f of fs.readdirSync(DIR)) {
        const mm = /^m-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f); if (!mm || mm[1] >= yest) continue;
        const hp = path.join(DIR, 'h-' + mm[1] + '.json'), agg = new Map();
        for (const ln of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) { if (!ln) continue; let r; try { r = JSON.parse(ln); } catch (e) { continue; } const k = r[1] + '|' + r[2] + '|' + hourOf(r[0]); let e = agg.get(k); if (!e) agg.set(k, e = { s: r[1], key: r[2], h: hourOf(r[0]), bu: 0, se: 0, n: 0, o: null, hi: null, lo: null, c: null, t0: Infinity, t1: -Infinity, lv: 0 }); e.bu += r[3]; e.se += r[4]; e.n += r[5]; e.lv++; if (r[5] > 0) { if (r[0] < e.t0) { e.t0 = r[0]; e.o = r[6]; } if (r[0] >= e.t1) { e.t1 = r[0]; e.c = r[9]; } e.hi = e.hi == null ? r[7] : Math.max(e.hi, r[7]); e.lo = e.lo == null ? r[8] : Math.min(e.lo, r[8]); } }
        const out = [...agg.values()].map(e => [e.h, e.s, e.key, r2(e.bu), r2(e.se), e.n, e.o, e.hi, e.lo, e.c, e.lv]);
        fs.writeFileSync(hp + '.tmp', JSON.stringify(out)); fs.renameSync(hp + '.tmp', hp); fs.unlinkSync(path.join(DIR, f)); log('Recorder: ' + f + ' → Stunden verdichtet (' + out.length + ' Zeilen)');
      }
    } catch (e) { st.err = 'Verdichten: ' + e.message; log('Recorder: ' + st.err); }
  }
  function load() {
    try {
      const fl = fs.readdirSync(DIR).sort(), hs = new Set(fl.filter(f => /^h-/.test(f)).map(f => f.slice(2, 12)));
      for (const f of fl) {
        const mh = /^h-(\d{4}-\d\d-\d\d)\.json$/.exec(f), mm = /^m-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f);
        if (mh) { let a = []; try { a = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { log('Recorder: ' + f + ' unlesbar'); } for (const r of a) { addHour(r[1], r[2], r[0], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10] || 0); st.loaded++; } }
        else if (mm) {
          if (hs.has(mm[1])) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) { /* egal */ } continue; }   // Absturz zwischen Verdichten und Löschen
          for (const ln of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) { if (!ln) continue; let r; try { r = JSON.parse(ln); } catch (e) { continue; } addHour(r[1], r[2], r[0], r[3], r[4], r[5], r[6], r[7], r[8], r[9], 1); DONE.add(r[1] + '|' + r[2] + '|' + r[0]); st.loaded++; }
        }
      }
      log('Recorder: ' + st.loaded + ' Zeilen geladen');
    } catch (e) { st.err = 'Laden: ' + e.message; log('Recorder: ' + st.err); }
  }
  load(); compact();
  setInterval(flush, 20e3); setInterval(compact, 6 * HOUR);
  for (const k of KEYS) conn(k);

  /* ----- Abfrage: Stundenreihen je Symbol, laufende Minute eingerechnet ----- */
  function query(sym, hours) {
    hours = Math.max(1, Math.min(2400, hours | 0 || 720)); const now = Date.now(), t1 = hourOf(now), t0 = t1 - (hours - 1) * HOUR, out = {};
    for (const key of KEYS) {
      const hm = H.get(sym + '|' + key), cur = CUR.get(sym + '|' + key), N = hours, a = { bu: new Array(N).fill(null), se: new Array(N).fill(null), n: new Array(N).fill(null), o: new Array(N).fill(null), c: new Array(N).fill(null), lv: new Array(N).fill(0) };
      let first = null, cnt = 0;
      for (let i = 0; i < N; i++) {
        const hh = t0 + i * HOUR; let e = hm && hm.get(hh);
        if (cur && hourOf(cur.m) === hh) { const x = e ? Object.assign({}, e) : { bu: 0, se: 0, n: 0, o: null, c: null, lv: 0, t0: Infinity, t1: -Infinity }; x.bu += cur.bu; x.se += cur.se; x.n += cur.n; x.lv += 1; if (cur.n && cur.m >= x.t1) x.c = cur.c; if (cur.n && cur.m < x.t0) x.o = cur.o; e = x; }
        if (!e || !e.lv) continue; a.bu[i] = r2(e.bu); a.se[i] = r2(e.se); a.n[i] = e.n; a.o[i] = e.o; a.c[i] = e.c; a.lv[i] = e.lv; cnt++; if (first == null) first = hh;
      }
      const s = RS[key] || {};
      out[key] = Object.assign(a, { name: VEN[key].name, quote: VEN[key].quote, first, hours: cnt, open: !!(s.open && s.live && s.live()), lastMsg: s.last || 0, recon: s.recon || 0 });
    }
    return { t0, step: HOUR, hours, sym, now, series: out, since: st.started };
  }
  function status() {
    const o = { symbols: SYMS, started: st.started, rows: st.rows, loaded: st.loaded, err: st.err, streams: {} };
    for (const k of KEYS) { const s = RS[k] || {}; o.streams[k] = { name: VEN[k].name, open: !!(s.open && s.live && s.live()), lastMsg: s.last || 0, msgs: s.msgs || 0, recon: s.recon || 0, err: s.err || '' }; }
    return o;
  }
  function stop() { flush(); }
  return { query, status, stop, flush, SYMS, KEYS };
}
module.exports = { start, VEN, SYMS };
