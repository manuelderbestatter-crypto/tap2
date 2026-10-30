'use strict';
/* Vorwärts-Bilanz: jedes Signal (vom Handy oder von der Server-Engine) wird hier dauerhaft festgehalten und vom SERVER selbst
   gegen die mitgeschnittenen Kurse ausgewertet – unabhängig davon, welches Symbol gerade im Chart offen ist, ob die App schläft
   oder neu gestartet wird. Ergebnis in R nach Gebühren, Slippage und Funding. Nichts wird gekappt oder vergessen.
   Ablage: DATA/ledger/YYYY-MM.jsonl (Ereignisse „new“ und „done“, nur anhängen). */
const fs = require('fs'), path = require('path');
const MIN = 60e3, HOUR = 3600e3, CP = [30, 60, 100, 150, 250, 400, 600, 1000, 1500, 2500, 4000];
const SRCKEY = { bnf: 'bn:p', bns: 'bn:s', hl: 'hl:p' }, FUNDV = { bnf: 'bn', hl: 'hl' };
const FIELDS = ['id', 't', 'sym', 'src', 'tf', 'algo', 'variant', 'side', 'px', 'stop', 'target', 'hold', 'costBp', 'rv'];

function start(DATA, log, rec) {
  const DIR = path.join(DATA, 'ledger'); fs.mkdirSync(DIR, { recursive: true });
  const L = new Map(), st = { loaded: 0, added: 0, done: 0, void: 0, err: '', evalAt: 0 };
  const file = t => path.join(DIR, new Date(t).toISOString().slice(0, 7) + '.jsonl');
  const write = (t, o) => { try { const f = file(t); let pre = ''; try { const fd = fs.openSync(f, 'r'), sz = fs.fstatSync(fd).size; if (sz) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, sz - 1); if (b[0] !== 10) pre = '\n'; } fs.closeSync(fd); } catch (e) { /* neu */ } fs.appendFileSync(f, pre + JSON.stringify(o) + '\n'); } catch (e) { st.err = 'Schreiben: ' + e.message; log('Bilanz: ' + st.err); } };
  /* Laden */
  try {
    for (const f of fs.readdirSync(DIR).filter(f => /^\d{4}-\d\d\.jsonl$/.test(f)).sort()) for (const ln of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      if (!ln) continue; let o; try { o = JSON.parse(ln); } catch (e) { continue; }
      if (o.e === 'new' && o.s && !L.has(o.s.id)) { L.set(o.s.id, Object.assign({ st: 'open' }, o.s)); st.loaded++; }
      else if (o.e === 'done' && L.has(o.id)) Object.assign(L.get(o.id), { st: o.st, out: o.out, R: o.R, exitT: o.exitT, exitPx: o.exitPx, fundR: o.fundR, why: o.why });
    }
    log('Bilanz: ' + st.loaded + ' Signale geladen');
  } catch (e) { st.err = 'Laden: ' + e.message; log('Bilanz: ' + st.err); }

  /* Signale annehmen (fest definierte Felder, Werte geprüft) */
  function add(list) {
    let n = 0; for (const x of Array.isArray(list) ? list.slice(0, 500) : []) {
      if (!x || typeof x.id !== 'string' || x.id.length > 40 || L.has(x.id)) continue; const s = {}; for (const k of FIELDS) s[k] = x[k];
      if (!(s.t > 0 && s.px > 0 && s.stop > 0 && s.target > 0 && s.hold > 0) || !/^(long|short)$/.test(s.side) || typeof s.algo !== 'string' || typeof s.sym !== 'string') continue;
      if (Math.abs(s.t - Date.now()) > 2 * 864e5) continue; s.costBp = +s.costBp || 0; s.st = 'open'; L.set(s.id, s); write(s.t, { e: 'new', s: Object.assign({}, s, { st: undefined }) }); n++; st.added++;
    }
    return n;
  }
  function finish(s, o) { Object.assign(s, o); write(s.t, Object.assign({ e: 'done', id: s.id }, o)); if (o.st === 'done') st.done++; else st.void++; }

  /* Auswertung gegen die Recorder-Kurse */
  function evalOne(s, now) {
    const key = SRCKEY[s.src]; if (!key || !rec || !rec.SYMS.includes(s.sym)) return finish(s, { st: 'void', why: 'keine Eigenaufnahme für ' + s.sym + ' / ' + s.src });
    const dir = s.side === 'long' ? 1 : -1, from = Math.floor(s.t / MIN) * MIN + MIN, endT = s.t + s.hold, to = Math.min(Math.floor(now / MIN) * MIN, Math.ceil(endT / MIN) * MIN);
    if (to <= from) return; const { bars, live } = rec.bars(s.sym, key, from, to); bars.sort((a, b) => a.t - b.t);
    let ex = null; for (const b of bars) { const hitS = dir > 0 ? b.l <= s.stop : b.h >= s.stop, hitT = dir > 0 ? b.h >= s.target : b.l <= s.target; if (hitS) { ex = { out: 'S', px: s.stop, t: b.t + b.step }; break; } if (hitT) { ex = { out: 'T', px: s.target, t: b.t + b.step }; break; } }
    const due = now >= endT + 2 * MIN; if (!ex && !due) return;
    if (!ex) { let lb = null; for (const b of bars) if (b.t + b.step <= Math.ceil(endT / MIN) * MIN) lb = b; if (!lb) return finish(s, { st: 'void', why: 'keine Kurse im Haltezeitraum' }); ex = { out: 'Z', px: lb.c, t: lb.t + lb.step }; }
    const expect = Math.max(1, ((ex.out === 'Z' ? to : Math.min(ex.t, to)) - from) / MIN); /* Zeitablauf: der ganze Haltezeitraum muss aufgenommen sein */ if (live < 0.85 * expect) return finish(s, { st: 'void', why: 'Aufnahme-Lücke (' + Math.round(live / expect * 100) + ' % der Minuten)' });
    const dist = Math.abs(s.px - s.stop); let fund = 0, fundMiss = false; const fv = FUNDV[s.src];
    if (fv) { const step = fv === 'hl' ? HOUR : 8 * HOUR; for (let tau = Math.floor(s.t / step) * step + step; tau <= ex.t; tau += step) { const fr = rec.fundAt(s.sym, fv, tau); if (fr == null) { fundMiss = true; continue; } fund += dir * fr * (fv === 'hl' ? 1 / 8 : 1) * s.px; } }
    const R = (dir * (ex.px - s.px) - s.costBp / 1e4 * s.px - fund) / dist;
    finish(s, { st: 'done', out: ex.out, R: Math.round(R * 1000) / 1000, exitT: ex.t, exitPx: ex.px, fundR: Math.round(fund / dist * 1000) / 1000, why: fundMiss ? 'Funding teilweise unbekannt (0 angesetzt)' : '' });
  }
  function evalAll() { const now = Date.now(); for (const s of L.values()) if (s.st === 'open') { try { evalOne(s, now); } catch (e) { st.err = 'Auswertung: ' + e.message; } } st.evalAt = now; }
  setInterval(evalAll, 30e3); setTimeout(evalAll, 5e3);

  /* Statistik je Algorithmus|Variante|Zeitrahmen|Regel-Version: nicht überlappend je Symbol, Prüfpunkte für das Urteil */
  function stats() {
    const G = new Map(); for (const s of L.values()) { const k = s.algo + '|' + s.variant + '|' + (s.tf || '*') + '|' + (s.rv || ''); let g = G.get(k); if (!g) G.set(k, g = []); g.push(s); }
    const out = {};
    for (const [k, arr] of G) {
      arr.sort((a, b) => a.t - b.t); const last = {}, R = []; let open = 0, vo = 0, skip = 0, T = 0, S = 0, Z = 0;
      for (const s of arr) { if (s.st === 'open') { open++; continue; } if (s.st === 'void') { vo++; continue; } if (last[s.sym] && s.t < last[s.sym]) { skip++; continue; } last[s.sym] = s.exitT; R.push(s.R); if (s.out === 'T') T++; else if (s.out === 'S') S++; else Z++; }
      const m = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, se = a => { if (a.length < 2) return 0; const mu = m(a); return Math.sqrt(a.reduce((x, y) => x + (y - mu) * (y - mu), 0) / (a.length - 1) / a.length); };
      const cp = CP.filter(c => c <= R.length).pop() || 0, Rc = R.slice(0, cp);
      out[k] = { n: R.length, avg: m(R), se: se(R), w: R.filter(x => x > 0).length, sum: R.reduce((x, y) => x + y, 0), cp, avgCp: cp ? m(Rc) : null, seCp: cp ? se(Rc) : null, open, void: vo, skip, tot: arr.length, T, S, Z, since: arr[0].t };
    }
    return out;
  }
  const status = () => ({ signals: L.size, open: [...L.values()].filter(s => s.st === 'open').length, added: st.added, done: st.done, void: st.void, err: st.err, evalAt: st.evalAt });
  return { add, stats, status, evalAll, _L: L };
}
module.exports = { start, CP };
