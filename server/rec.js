'use strict';
/* Recorder: schneidet öffentliche Ströme (nur lesen, keine Schlüssel) mit und verdichtet sie zu Minuten-/Stunden-Werten.
   Handel: Binance Spot+Perp, Bybit Spot+Perp, OKX Spot+Perp, Coinbase Spot, Hyperliquid Perp – BTC, ETH, SOL.
   Je Minute und Reihe: Taker-Kauf-/Verkaufs-Volumen (Quote-Währung), getrennt nach Größe des einzelnen Prints
   (klein < 10 Tsd, mittel < 100 Tsd, groß ≥ 100 Tsd), Anzahl, OHLC, Liquidationen (Longs / Shorts zwangsgeschlossen).
   Derivate: Funding (auf 8 h umgerechnet) und Open Interest (USD) je Börse, alle 15 min abgefragt.
   Eine Minute zählt nur als „live“, wenn die Verbindung stand (sonst Lücke statt erfundener Nullen).
   Ablage: DATA/rec/m-*.jsonl (Minuten, 2 Tage) → h-*.json (Stunden, bleibt); liq-*.jsonl (Einzel-Liquidationen); d-*.jsonl (Funding/OI). */
const fs = require('fs'), path = require('path');

const SYMS = (process.env.REC_SYMS || 'BTC,ETH,SOL').split(',').map(s => s.trim()).filter(Boolean);
const MIN = 60e3, HOUR = 3600e3, NX = 8;   // Zusatzfelder: bS sS bM sM bL sL lqL lqS
const OKX_CT = { BTC: 0.01, ETH: 0.1, SOL: 1 };   // Kontraktgröße OKX-USDT-Swaps (Münzen je Kontrakt)

/* parse(j, emit, liq): emit(sym, takerKauft, preis, menge) – Seite ist die des Takers. liq(sym, longLiquidiert, preis, menge). */
const VEN = {
  'bn:s': { name: 'Binance Spot', quote: 'USDT', url: 'wss://stream.binance.com:9443/stream?streams=' + SYMS.map(s => s.toLowerCase() + 'usdt@aggTrade').join('/'),
    parse(j, emit) { const d = j && j.data; if (!d || d.e !== 'aggTrade') return; emit(d.s.replace(/USDT$/, ''), !d.m, +d.p, +d.q); } },
  'bn:p': { name: 'Binance Perp', quote: 'USDT', url: 'wss://fstream.binance.com/stream?streams=' + SYMS.map(s => s.toLowerCase() + 'usdt@aggTrade').join('/') + '/!forceOrder@arr',
    /* forceOrder: S=SELL → eine Long-Position wurde zwangsverkauft. Binance meldet höchstens eine Liquidation je Symbol und Sekunde (Untergrenze). */
    parse(j, emit, liq) { const d = j && j.data; if (!d) return; if (d.e === 'aggTrade') return emit(d.s.replace(/USDT$/, ''), !d.m, +d.p, +d.q); if (d.e === 'forceOrder' && d.o && /USDT$/.test(d.o.s)) liq(d.o.s.replace(/USDT$/, ''), d.o.S === 'SELL', +d.o.ap || +d.o.p, +d.o.z || +d.o.q); } },
  'by:s': { name: 'Bybit Spot', quote: 'USDT', url: 'wss://stream.bybit.com/v5/public/spot', ping: '{"op":"ping"}', pingMs: 20e3,
    sub: () => [{ op: 'subscribe', args: SYMS.map(s => 'publicTrade.' + s + 'USDT') }],
    parse(j, emit) { if (!j || !/^publicTrade\./.test(j.topic || '') || !Array.isArray(j.data)) return; for (const t of j.data) emit(String(t.s).replace(/USDT$/, ''), t.S === 'Buy', +t.p, +t.v); } },
  /* allLiquidation: S = Seite der liquidierten Position (Buy = Long liquidiert) */
  'by:p': { name: 'Bybit Perp', quote: 'USDT', url: 'wss://stream.bybit.com/v5/public/linear', ping: '{"op":"ping"}', pingMs: 20e3,
    sub: () => [{ op: 'subscribe', args: SYMS.map(s => 'publicTrade.' + s + 'USDT').concat(SYMS.map(s => 'allLiquidation.' + s + 'USDT')) }],
    parse(j, emit, liq) { if (!j || !Array.isArray(j.data)) return; const tp = j.topic || '';
      if (/^publicTrade\./.test(tp)) for (const t of j.data) emit(String(t.s).replace(/USDT$/, ''), t.S === 'Buy', +t.p, +t.v);
      else if (/^allLiquidation\./.test(tp)) for (const t of j.data) liq(String(t.s).replace(/USDT$/, ''), t.S === 'Buy', +t.p, +t.v); } },
  'ok:s': { name: 'OKX Spot', quote: 'USDT', url: 'wss://ws.okx.com:8443/ws/v5/public', ping: 'ping', pingMs: 25e3,
    sub: () => [{ op: 'subscribe', args: SYMS.map(s => ({ channel: 'trades', instId: s + '-USDT' })) }],
    parse(j, emit) { if (!j || !j.arg || j.arg.channel !== 'trades' || !Array.isArray(j.data)) return; for (const t of j.data) emit(String(t.instId).replace(/-USDT$/, ''), t.side === 'buy', +t.px, +t.sz); } },
  /* OKX-Swap: Menge in Kontrakten → × Kontraktgröße. liquidation-orders: posSide long → Long liquidiert */
  'ok:p': { name: 'OKX Perp', quote: 'USDT', url: 'wss://ws.okx.com:8443/ws/v5/public', ping: 'ping', pingMs: 25e3,
    sub: () => [{ op: 'subscribe', args: SYMS.map(s => ({ channel: 'trades', instId: s + '-USDT-SWAP' })).concat([{ channel: 'liquidation-orders', instType: 'SWAP' }]) }],
    parse(j, emit, liq) { if (!j || !j.arg || !Array.isArray(j.data)) return;
      if (j.arg.channel === 'trades') for (const t of j.data) { const s = String(t.instId).replace(/-USDT-SWAP$/, ''); if (OKX_CT[s]) emit(s, t.side === 'buy', +t.px, +t.sz * OKX_CT[s]); }
      else if (j.arg.channel === 'liquidation-orders') for (const x of j.data) { const m = /^(\w+)-USDT-SWAP$/.exec(x.instId || ''); if (!m || !OKX_CT[m[1]]) continue; for (const d of x.details || []) liq(m[1], d.posSide === 'long' || (d.posSide === 'net' && d.side === 'sell'), +d.bkPx, +d.sz * OKX_CT[m[1]]); } } },
  /* Coinbase (Exchange-Feed „matches“): side = Seite des Makers → der Taker ist die Gegenseite */
  'cb:s': { name: 'Coinbase Spot', quote: 'USD', url: 'wss://ws-feed.exchange.coinbase.com',
    sub: () => [{ type: 'subscribe', product_ids: SYMS.map(s => s + '-USD'), channels: ['matches'] }],
    parse(j, emit) { if (!j || j.type !== 'match') return; emit(String(j.product_id).replace(/-USD$/, ''), j.side === 'sell', +j.price, +j.size); } },
  /* Hyperliquid: side B = Käufer-Aggressor (laut Doku). Liquidationen sind dort nicht als öffentlicher Strom verfügbar. */
  'hl:p': { name: 'Hyperliquid Perp', quote: 'USD', url: 'wss://api.hyperliquid.xyz/ws', ping: '{"method":"ping"}', pingMs: 30e3,
    sub: () => SYMS.map(s => ({ method: 'subscribe', subscription: { type: 'trades', coin: s } })),
    parse(j, emit) { if (!j || j.channel !== 'trades' || !Array.isArray(j.data)) return; for (const t of j.data) emit(String(t.coin), t.side === 'B', +t.px, +t.sz); } },
};
const KEYS = Object.keys(VEN);
const LIQV = { 'bn:p': 'Binance', 'by:p': 'Bybit', 'ok:p': 'OKX' };

/* Derivate per REST: Funding (8 h) und OI (USD) */
const DERIV = {
  bn: { name: 'Binance', async get(f, sym) { const s = sym + 'USDT', [p, o] = await Promise.all([f('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=' + s), f('https://fapi.binance.com/fapi/v1/openInterest?symbol=' + s)]); return { fr: +p.lastFundingRate, oi: +o.openInterest * +p.markPrice, px: +p.markPrice }; } },
  by: { name: 'Bybit', async get(f, sym) { const j = await f('https://api.bybit.com/v5/market/tickers?category=linear&symbol=' + sym + 'USDT'), t = j.result.list[0]; return { fr: +t.fundingRate, oi: +t.openInterestValue, px: +t.markPrice }; } },
  ok: { name: 'OKX', async get(f, sym) { const id = sym + '-USDT-SWAP', [a, b, c] = await Promise.all([f('https://www.okx.com/api/v5/public/funding-rate?instId=' + id), f('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=' + id), f('https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=' + id)]);
    const px = +c.data[0].markPx, o = b.data[0]; return { fr: +a.data[0].fundingRate, oi: o.oiUsd != null && o.oiUsd !== '' ? +o.oiUsd : +o.oiCcy * px, px }; } },
  hl: { name: 'Hyperliquid', all: true, async get(f) { const j = await f('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' }), out = {}; j[0].universe.forEach((u, i) => { const c = j[1][i]; if (SYMS.includes(u.name) && c) out[u.name] = { fr: +c.funding * 8, oi: +c.openInterest * +c.markPx, px: +c.markPx }; }); return out; } },   // HL: stündliches Funding × 8
};

function start(DATA, log) {
  const DIR = path.join(DATA, 'rec'); fs.mkdirSync(DIR, { recursive: true });
  const URLS = (() => { try { return JSON.parse(process.env.REC_URLS || '{}'); } catch (e) { return {}; } })(), HFAKE = process.env.REC_HTTP_FAKE || '';
  const RS = {}, CUR = new Map(), DONE = new Set(), H = new Map(), DV = new Map(); let LQ = [], pending = [], pendLq = [];
  const st = { started: Date.now(), rows: 0, loaded: 0, liq: 0, err: '', derivAt: 0, derivErr: {} };
  const hourOf = t => Math.floor(t / HOUR) * HOUR, r2 = x => x == null ? null : Math.round(x * 100) / 100, dayOf = t => new Date(t).toISOString().slice(0, 10);
  const newE = () => ({ bu: 0, se: 0, n: 0, o: null, h: null, l: null, c: null, t0: Infinity, t1: -Infinity, lv: 0, x: new Array(NX).fill(0) });

  function addHour(sym, key, m, bu, se, n, o, h, l, c, lv, x) {
    const k = sym + '|' + key; let hm = H.get(k); if (!hm) H.set(k, hm = new Map());
    const hh = hourOf(m); let e = hm.get(hh); if (!e) hm.set(hh, e = newE());
    e.bu += bu; e.se += se; e.n += n; e.lv += lv; if (x) for (let i = 0; i < NX; i++) e.x[i] += x[i] || 0;
    if (n > 0 && o != null) { if (m < e.t0) { e.t0 = m; e.o = o; } if (m >= e.t1) { e.t1 = m; e.c = c; } e.h = e.h == null ? h : Math.max(e.h, h); e.l = e.l == null ? l : Math.min(e.l, l); }
  }
  function closeB(b) {
    const k = b.sym + '|' + b.key; if (CUR.get(k) === b) CUR.delete(k); if (DONE.has(k + '|' + b.m)) return; DONE.add(k + '|' + b.m);
    const x = (b.x || new Array(NX).fill(0)).map(r2), row = [b.m, b.sym, b.key, r2(b.bu), r2(b.se), b.n, b.n ? b.o : null, b.n ? b.h : null, b.n ? b.l : null, b.n ? b.c : null].concat(x);
    pending.push(row); st.rows++; addHour(b.sym, b.key, b.m, row[3], row[4], row[5], row[6], row[7], row[8], row[9], 1, x);
  }
  function bucket(key, sym) {
    const m = Math.floor(Date.now() / MIN) * MIN, k = sym + '|' + key; let b = CUR.get(k);
    if (b && b.m !== m) { closeB(b); b = null; }
    if (!b) { if (DONE.has(k + '|' + m)) return null; CUR.set(k, b = { sym, key, m, bu: 0, se: 0, n: 0, o: null, h: null, l: null, c: null, x: new Array(NX).fill(0) }); }
    return b;
  }
  function add(key, sym, buy, px, q) {
    if (!(px > 0 && q > 0) || !SYMS.includes(sym)) return; const b = bucket(key, sym); if (!b) return;
    const usd = px * q, sz = usd < 1e4 ? 0 : usd < 1e5 ? 2 : 4; if (buy) { b.bu += usd; b.x[sz] += usd; } else { b.se += usd; b.x[sz + 1] += usd; }
    if (!b.n) { b.o = b.h = b.l = px; } b.n++; b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); b.c = px;
  }
  function addLiq(key, sym, longLiq, px, q) {
    if (!(px > 0 && q > 0) || !SYMS.includes(sym)) return; const usd = px * q, b = bucket(key, sym); if (b) b.x[longLiq ? 6 : 7] += usd;
    const ev = [Date.now(), sym, key, longLiq ? 'L' : 'S', px, r2(usd)]; LQ.push(ev); pendLq.push(ev); st.liq++; if (LQ.length > 20000) LQ = LQ.slice(-15000);
  }

  /* ----- Verbindungen ----- */
  function conn(key) {
    const V = VEN[key], s = RS[key] = { open: false, last: 0, msgs: 0, recon: 0, err: '', since: 0, url: '' };
    let pingT = null, backoff = 2000, retryT = null;
    s.live = () => s.open && Date.now() - s.last < 60e3;
    function retry(why) { s.open = false; s.err = String(why || ''); clearInterval(pingT); if (retryT) return; s.recon++; retryT = setTimeout(() => { retryT = null; go(); }, backoff); backoff = Math.min(backoff * 2, 60e3); }
    function go() {
      const url = URLS[key] || V.url; s.url = url; let w; try { w = new WebSocket(url); } catch (e) { return retry(e.message); }
      let dead = false; const drop = why => { if (dead) return; dead = true; try { w.close(); } catch (e) { /* weg */ } retry(why); };
      w.onopen = () => { s.open = true; s.last = Date.now(); s.since = Date.now(); s.err = ''; backoff = 2000; try { for (const m of (V.sub ? V.sub() : [])) w.send(typeof m === 'string' ? m : JSON.stringify(m)); } catch (e) { return drop(e.message); } if (V.ping) pingT = setInterval(() => { try { w.send(V.ping); } catch (e) { /* Wächter */ } }, V.pingMs || 20e3); };
      w.onmessage = ev => { s.last = Date.now(); s.msgs++; let j; try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (e) { return; } try { V.parse(j, (sym, buy, px, q) => add(key, sym, buy, px, q), (sym, l, px, q) => addLiq(key, sym, l, px, q)); } catch (e) { /* Ausreißer stoppt nicht die Aufnahme */ } };
      w.onerror = e => drop(e && e.message || 'Fehler'); w.onclose = () => drop('geschlossen'); s.kill = () => drop('Wächter');
    }
    go();
  }

  /* ----- Minuten-Takt ----- */
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

  /* ----- Derivate (Funding/OI) alle 15 min ----- */
  const rget = async (url, body) => {
    const u = HFAKE ? HFAKE + '/?u=' + encodeURIComponent(url) : url;
    const r = await fetch(u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15e3) } : { signal: AbortSignal.timeout(15e3) });
    if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
  };
  function addDv(t, sym, v, fr, oi, px) { const k = sym + '|' + v; let m = DV.get(k); if (!m) DV.set(k, m = new Map()); m.set(hourOf(t), { t, fr, oi, px }); }
  async function derivTick() {
    const t = Date.now(), rows = [];
    await Promise.all(Object.entries(DERIV).map(async ([v, D]) => {
      try {
        const res = D.all ? await D.get(rget) : Object.fromEntries(await Promise.all(SYMS.map(async s => [s, await D.get(rget, s)])));
        for (const [s, o] of Object.entries(res)) if (isFinite(o.fr) && isFinite(o.oi) && o.oi > 0) { addDv(t, s, v, o.fr, o.oi, o.px); rows.push(JSON.stringify([t, s, v, o.fr, Math.round(o.oi), o.px])); }
        st.derivErr[v] = '';
      } catch (e) { st.derivErr[v] = String(e.message || e); }
    }));
    st.derivAt = t; if (rows.length) try { fs.appendFileSync(path.join(DIR, 'd-' + dayOf(t) + '.jsonl'), rows.join('\n') + '\n'); } catch (e) { st.err = 'Schreiben: ' + e.message; }
  }

  /* ----- Platte ----- */
  function flush() {
    const w = (pre, arr) => { const by = {}; for (const r of arr) (by[dayOf(r[0])] || (by[dayOf(r[0])] = [])).push(JSON.stringify(r)); for (const d in by) fs.appendFileSync(path.join(DIR, pre + d + '.jsonl'), by[d].join('\n') + '\n'); };
    try { if (pending.length) { const a = pending; pending = []; w('m-', a); } if (pendLq.length) { const a = pendLq; pendLq = []; w('liq-', a); } st.err = ''; } catch (e) { st.err = 'Schreiben: ' + e.message; log('Recorder: ' + st.err); }
  }
  const lines = f => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  function compact() {
    try {
      const yest = dayOf(Date.now() - 864e5);
      for (const f of fs.readdirSync(DIR)) {
        const mm = /^m-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f); if (!mm || mm[1] >= yest) continue;
        const agg = new Map();
        for (const r of lines(f)) { const k = r[1] + '|' + r[2] + '|' + hourOf(r[0]); let e = agg.get(k); if (!e) agg.set(k, e = Object.assign(newE(), { s: r[1], key: r[2], hh: hourOf(r[0]) }));
          e.bu += r[3]; e.se += r[4]; e.n += r[5]; e.lv++; for (let i = 0; i < NX; i++) e.x[i] += r[10 + i] || 0;
          if (r[5] > 0 && r[6] != null) { if (r[0] < e.t0) { e.t0 = r[0]; e.o = r[6]; } if (r[0] >= e.t1) { e.t1 = r[0]; e.c = r[9]; } e.h = e.h == null ? r[7] : Math.max(e.h, r[7]); e.l = e.l == null ? r[8] : Math.min(e.l, r[8]); } }
        const out = [...agg.values()].map(e => [e.hh, e.s, e.key, r2(e.bu), r2(e.se), e.n, e.o, e.h, e.l, e.c, e.lv].concat(e.x.map(r2)));
        const hp = path.join(DIR, 'h-' + mm[1] + '.json'); fs.writeFileSync(hp + '.tmp', JSON.stringify(out)); fs.renameSync(hp + '.tmp', hp); fs.unlinkSync(path.join(DIR, f)); log('Recorder: ' + f + ' → Stunden verdichtet (' + out.length + ' Zeilen)');
      }
    } catch (e) { st.err = 'Verdichten: ' + e.message; log('Recorder: ' + st.err); }
  }
  function load() {
    try {
      const fl = fs.readdirSync(DIR).sort(), hs = new Set(fl.filter(f => /^h-/.test(f)).map(f => f.slice(2, 12))), cut = dayOf(Date.now() - 14 * 864e5);
      for (const f of fl) {
        const mh = /^h-(\d{4}-\d\d-\d\d)\.json$/.exec(f), mm = /^m-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f), ml = /^liq-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f), md = /^d-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f);
        if (mh) { let a = []; try { a = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { log('Recorder: ' + f + ' unlesbar'); } for (const r of a) { addHour(r[1], r[2], r[0], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10] || 0, r.slice(11, 11 + NX)); st.loaded++; } }
        else if (mm) {
          if (hs.has(mm[1])) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) { /* egal */ } continue; }
          for (const r of lines(f)) { addHour(r[1], r[2], r[0], r[3], r[4], r[5], r[6], r[7], r[8], r[9], 1, r.slice(10, 10 + NX)); DONE.add(r[1] + '|' + r[2] + '|' + r[0]); st.loaded++; }
        } else if (ml && ml[1] >= cut) LQ.push(...lines(f));
        else if (md) for (const r of lines(f)) addDv(r[0], r[1], r[2], r[3], r[4], r[5]);
      }
      LQ = LQ.slice(-15000); log('Recorder: ' + st.loaded + ' Zeilen geladen');
    } catch (e) { st.err = 'Laden: ' + e.message; log('Recorder: ' + st.err); }
  }
  load(); compact();
  setInterval(flush, 20e3); setInterval(compact, 6 * HOUR); setTimeout(derivTick, 3e3); setInterval(derivTick, +process.env.REC_DERIV_MS || 15 * MIN);
  for (const k of KEYS) conn(k);

  /* ----- Abfrage: Stundenreihen je Symbol, laufende Minute eingerechnet ----- */
  function query(sym, hours) {
    hours = Math.max(1, Math.min(2400, hours | 0 || 720)); const now = Date.now(), t1 = hourOf(now), t0 = t1 - (hours - 1) * HOUR, out = {};
    for (const key of KEYS) {
      const hm = H.get(sym + '|' + key), cur = CUR.get(sym + '|' + key), N = hours, nul = () => new Array(N).fill(null);
      const a = { bu: nul(), se: nul(), n: nul(), o: nul(), c: nul(), lv: new Array(N).fill(0), x: Array.from({ length: NX }, nul) };
      let first = null, cnt = 0;
      for (let i = 0; i < N; i++) {
        const hh = t0 + i * HOUR; let e = hm && hm.get(hh);
        if (cur && hourOf(cur.m) === hh) { const y = e ? Object.assign({}, e, { x: e.x.slice() }) : newE(); y.bu += cur.bu; y.se += cur.se; y.n += cur.n; y.lv += 1; for (let k = 0; k < NX; k++) y.x[k] += cur.x[k]; if (cur.n && cur.m >= y.t1) y.c = cur.c; if (cur.n && cur.m < y.t0) y.o = cur.o; e = y; }
        if (!e || !e.lv) continue; a.bu[i] = r2(e.bu); a.se[i] = r2(e.se); a.n[i] = e.n; a.o[i] = e.o; a.c[i] = e.c; a.lv[i] = e.lv; for (let k = 0; k < NX; k++) a.x[k][i] = r2(e.x[k]); cnt++; if (first == null) first = hh;
      }
      const s = RS[key] || {};
      out[key] = Object.assign(a, { name: VEN[key].name, quote: VEN[key].quote, liq: !!LIQV[key], first, hours: cnt, open: !!(s.open && s.live && s.live()), lastMsg: s.last || 0, recon: s.recon || 0 });
    }
    const deriv = {}; for (const v of Object.keys(DERIV)) { const m = DV.get(sym + '|' + v); if (!m) continue; const fr = new Array(hours).fill(null), oi = new Array(hours).fill(null); for (let i = 0; i < hours; i++) { const e = m.get(t0 + i * HOUR); if (e) { fr[i] = e.fr; oi[i] = e.oi; } } deriv[v] = { name: DERIV[v].name, fr, oi, err: st.derivErr[v] || '' }; }
    const liq = LQ.filter(e => e[1] === sym && e[0] >= t0).slice(-4000).map(e => [e[0], e[2], e[3], e[4], e[5]]);
    return { t0, step: HOUR, hours, sym, now, series: out, deriv, liq, xf: ['bS', 'sS', 'bM', 'sM', 'bL', 'sL', 'lqL', 'lqS'], since: st.started };
  }
  function status() {
    const o = { symbols: SYMS, started: st.started, rows: st.rows, loaded: st.loaded, liq: st.liq, err: st.err, derivAt: st.derivAt, derivErr: st.derivErr, streams: {} };
    for (const k of KEYS) { const s = RS[k] || {}; o.streams[k] = { name: VEN[k].name, open: !!(s.open && s.live && s.live()), lastMsg: s.last || 0, msgs: s.msgs || 0, recon: s.recon || 0, err: s.err || '' }; }
    return o;
  }
  return { query, status, stop: flush, flush, SYMS, KEYS };
}
module.exports = { start, VEN, SYMS, DERIV };
