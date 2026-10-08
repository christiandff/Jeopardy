// Lasttest med mange simulerte telefoner, kaos og serverrestart.
//   npm run load                       (30 spillere, ett helt brett)
//   npm run load -- --players 60
//   npm run load -- --minutes 30       (soak: 20 spillere som lever lenge, sporadiske runder)
// Skriver rapport til test/load-report.txt. Avslutter med kode 1 hvis en terskel eller invariant brytes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { startServer, mkAdmin, until, sleep } = require('./helpers');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const SOAK_MIN = Number(arg('minutes', 0));
const N = Number(arg('players', SOAK_MIN ? 20 : 30));
const CLUES = Number(arg('clues', 25));
const RESTART_AT = Number(arg('restart-at', 12));
const rand = (a, b) => a + Math.random() * (b - a);
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const MB = b => Math.round(b / 1048576);

const violations = [];
const violate = msg => { violations.push(msg); console.error('  ✖ BRUDD:', msg); };
const log = (...a) => console.log(...a);

// Metrikker for gjeldende rute (settes av driveren, leses av botene)
const measure = { key: null, openSentAt: 0, firstBuzzAt: 0 };
const fanOut = [], buzzToLock = [];

class Bot {
  constructor(srv, name) {
    this.srv = srv; this.name = name; this.pid = null; this.state = null; this.connected = false;
    this.stopped = false; this.buzzedKey = null; this.sizes = []; this.willBuzz = Math.random() < 0.7;
    this.seenOpen = null; this.seenLock = null; this.spam = false;
  }
  connect() {
    if (this.stopped) return;
    const ws = this.ws = new WebSocket(`ws://127.0.0.1:${this.srv.port}/ws`);
    ws.on('open', () => { this.connected = true; this.send({ type: 'hello', role: 'player', pid: this.pid, name: this.name }); });
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.type === 'joined') this.pid = m.pid;
      else if (m.type === 'state') { this.sizes.push(d.length); this.state = m.state; this.react(); }
    });
    ws.on('close', () => { this.connected = false; if (!this.stopped) setTimeout(() => this.connect(), rand(300, 1000)); });
    ws.on('error', () => {});
  }
  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  drop() { if (this.ws) this.ws.terminate(); }
  stop() { this.stopped = true; if (this.ws) this.ws.terminate(); }
  react() {
    const cur = this.state && this.state.current;
    if (!cur || !this.pid) return;
    const key = `${this.state.round}:${cur.c}-${cur.r}:${cur.lockedOut.length}`;
    if (cur.phase === 'open' && key === measure.key && this.seenOpen !== key) { this.seenOpen = key; fanOut.push(Date.now() - measure.openSentAt); }
    if (cur.phase === 'answering' && key === measure.key && this.seenLock !== key && measure.firstBuzzAt) { this.seenLock = key; buzzToLock.push(Date.now() - measure.firstBuzzAt); }
    if (cur.phase === 'open' && !cur.lockedOut.includes(this.pid) && this.buzzedKey !== key && (this.willBuzz || cur.lockedOut.length > 0)) {
      this.buzzedKey = key;
      setTimeout(() => {
        if (!measure.firstBuzzAt || measure.key !== key) { if (measure.key === key) measure.firstBuzzAt = Date.now(); }
        this.send({ type: 'player', action: 'buzz' });
        if (this.spam) for (let i = 0; i < 40; i++) this.send({ type: 'player', action: 'buzz' });
      }, rand(0, 50));
    }
  }
}

const norm = s => JSON.stringify({
  round: s.round, started: s.started, used: Object.keys(s.used).sort(),
  cur: s.current ? [s.current.c, s.current.r, s.current.phase, s.current.answering, s.current.lockedOut.length] : null,
  players: s.players.map(p => [p.id, p.score]).sort(),
});

async function stats(srv) { try { return await (await fetch(srv.base + '/__stats')).json(); } catch { return null; } }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-load-'));
  let srv = await startServer({ dir });
  const port = srv.port;
  log(`\nLasttest: ${N} spillere${SOAK_MIN ? `, soak ${SOAK_MIN} min` : `, ${CLUES} ruter`}, port ${port}, data i ${dir}\n`);
  let admin = await mkAdmin(srv);
  const act = async (a, extra = {}) => { admin.act(a, extra); await sleep(70); }; // 70 ms: et menneske trykker aldri raskere enn rate-limit
  await act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: false });

  // Storskjerm
  const { mkDisplay } = require('./helpers');
  let display = await mkDisplay(srv);

  // Spillere
  const bots = Array.from({ length: N }, (_, i) => new Bot(srv, 'Lag' + String(i + 1).padStart(2, '0')));
  const t0 = Date.now();
  bots.forEach(b => b.connect());
  await until(() => bots.every(b => b.pid), 10000, `at alle ${N} spillere blir med`);
  log(`  ${N} spillere koblet til på ${Date.now() - t0} ms`);
  bots.slice(0, 3).forEach(b => { b.spam = true; });

  const ledger = new Map(bots.map(b => [b.pid, 0]));
  const expectedUsed = new Set();
  const hist = []; // (rute, handling, spiller) – skrives ut ved poengbrudd
  const memSamples = [];
  let hostile = null;

  const allConnected = () => bots.every(b => b.connected && b.state);
  async function converge(label) {
    try { await until(allConnected, 8000, 'at alle spillere er tilkoblet'); } catch (e) { return violate(`${label}: ${e.message}`); }
    try {
      await until(() => { const ref = norm(admin.state); return bots.every(b => norm(b.state) === ref) && norm(display.state) === ref; }, 5000, 'lik tilstand hos alle');
    } catch { violate(`${label}: klientene har ulik tilstand`); }
  }
  function checkLedger(label) {
    const srvScores = new Map(admin.state.players.map(p => [p.id, p.score]));
    if (admin.state.players.length !== N) violate(`${label}: ${admin.state.players.length} lag på serveren, forventet ${N}`);
    for (const [id, exp] of ledger) if ((srvScores.get(id) ?? 0) !== exp) { console.error('    historikk for lag:', JSON.stringify(hist.filter(h => h[2] === id)), 'denne ruten:', JSON.stringify(hist.filter(h => h[0] === label)), 'server-state nå:', JSON.stringify(admin.state.current)); violate(`${label}: poeng for ${id} er ${srvScores.get(id)}, forventet ${exp}`); break; }
  }

  async function playClue(c, r, i) {
    const label = `rute ${i + 1} (${c},${r})`;
    // Kaos før runden: noen telefoner «sovner» (brå frakobling)
    bots.forEach(b => { if (Math.random() < 0.15) b.drop(); });
    if (i % 5 === 4) { log(`  ${label}: reconnect-storm (alle ${N} kobler fra og til samtidig)`); bots.forEach(b => b.drop()); }
    // Fiendtlig klient: søppelmeldinger og dobbelt navn
    if (!hostile || hostile.readyState > 1) { hostile = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`); hostile.on('error', () => {}); }
    if (hostile.readyState === 1) {
      for (const g of ['null', '123', '{', '{"type":"admin","action":"start"}', '{"type":"hello","role":"player","pid":"__proto__"}', 'x'.repeat(30)]) hostile.send(g);
      hostile.send(JSON.stringify({ type: 'hello', role: 'player', name: bots[0].name }));
    }
    await converge(label + ' før valg');

    await act('select', { c, r });
    await admin.waitState(s => s.current && s.current.c === c && s.current.r === r, 3000, 'valgt rute');
    const value = admin.state.current.value;
    measure.key = `${admin.state.round}:${c}-${r}:0`; measure.firstBuzzAt = 0;
    await converge(label + ' etter valg');

    // Åpne buzzer; alle (de som vil) buzzer innen 0–50 ms
    measure.openSentAt = Date.now();
    await act('open');
    let rounds = 0, locked = 0;
    for (;;) {
      // vent på en FERSK «answering» (riktig antall utestengte), ikke en utdatert tilstand fra forrige svar
      try { await admin.waitState(s => s.current && s.current.phase === 'answering' && s.current.lockedOut.length === locked, 2500, 'noen buzzer'); }
      catch { await act('reveal'); break; }           // ingen buzzet (alle utestengt/uvillige)
      const cur = admin.state.current;
      if (!bots.some(b => b.pid === cur.answering)) violate(`${label}: «answering» er ikke en kjent spiller`);
      if (new Set(cur.lockedOut).size !== cur.lockedOut.length) violate(`${label}: duplikater i utestengte`);
      if (cur.lockedOut.includes(cur.answering)) violate(`${label}: utestengt spiller svarer`);
      const roll = Math.random();
      if (roll < 0.55 || rounds >= 3) {
        await act('correct', { who: cur.answering });
        try { await admin.waitState(s => s.current && s.current.phase === 'revealed', 2500, 'riktig-svar'); } catch { violate(`${label}: «riktig» ble ikke utført`); }
        ledger.set(cur.answering, ledger.get(cur.answering) + value); hist.push([label, 'riktig', cur.answering, value, cur.phase, rounds]); break;
      } else if (roll < 0.9) {
        measure.key = `${admin.state.round}:${c}-${r}:${cur.lockedOut.length + 1}`; measure.firstBuzzAt = 0; measure.openSentAt = Date.now();
        await act('wrong', { who: cur.answering });
        try { await admin.waitState(s => s.current && s.current.lockedOut.length === locked + 1, 2500, 'feil-svar'); } catch { violate(`${label}: «feil» ble ikke utført`); }
        ledger.set(cur.answering, ledger.get(cur.answering) - value); hist.push([label, 'feil', cur.answering, value, cur.phase, rounds]);
        locked++; rounds++;
        if (admin.state.current && admin.state.current.phase === 'revealed') break;
      } else { await act('reveal'); break; }
    }
    await converge(label + ' etter svar');
    await act('close');
    await admin.waitState(s => !s.current && s.used[`${c}-${r}`], 3000, 'lukket rute');
    expectedUsed.add(`${c}-${r}`);
    await converge(label + ' etter lukking');
    checkLedger(label);
    // Bot-tilstand etter brå frakoblinger kan ha endret willBuzz – varier litt
    bots.forEach(b => { b.willBuzz = Math.random() < 0.7; });
  }

  async function restartServer() {
    log(`  ── drepper serveren (SIGKILL) midt i spillet og starter den på nytt ──`);
    await sleep(700); // la utsatt lagring (300 ms) skrive til disk
    await srv.kill();
    const down = Date.now();
    srv = await startServer({ dir, port });
    bots.forEach(b => { b.srv = srv; });
    display.close(); admin.close();
    admin = await mkAdmin(srv);
    display = await mkDisplay(srv);
    await until(allConnected, 20000, 'at alle spillere kobler til igjen etter restart').catch(e => violate(e.message));
    log(`  serveren var nede ~${Date.now() - down} ms; alle spillere tilbake etter ${Date.now() - down} ms`);
    await sleep(300);
    checkLedger('etter restart');
    const used = Object.keys(admin.state.used).sort().join(',');
    if (used !== [...expectedUsed].sort().join(',')) violate(`etter restart: brukte ruter ${used} ≠ forventet`);
    await act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: false });
  }

  // ───────── Kjør ─────────
  await act('start');
  const base = await stats(srv); const rss0 = base && base.mem.rss;
  const cells = []; for (let c = 0; c < 5; c++) for (let r = 0; r < 5; r++) cells.push([c, r]);
  cells.sort(() => Math.random() - 0.5);

  if (!SOAK_MIN) {
    for (let i = 0; i < Math.min(CLUES, 25); i++) {
      await playClue(cells[i][0], cells[i][1], i);
      if (i === RESTART_AT - 1) await restartServer();
      if ((i + 1) % 5 === 0) { const st = await stats(srv); if (st) memSamples.push(st.mem.rss); log(`  ${i + 1}/${Math.min(CLUES, 25)} ruter ferdig – serverminne ${st ? MB(st.mem.rss) : '?'} MB, ${st ? st.sockets : '?'} tilkoblinger`); }
    }
    // Brett to: flipp og spill et par ruter
    await act('flip'); await admin.waitState(s => s.round === 1, 3000, 'flipp brett');
    expectedUsed.clear();
    for (let i = 0; i < 3; i++) await playClue(cells[i][0], cells[i][1], 100 + i);
  } else {
    const end = Date.now() + SOAK_MIN * 60000; let i = 0, lastSample = 0;
    while (Date.now() < end) {
      if (admin.state.roundDone) { await act('resetBoard'); expectedUsed.clear(); }
      const free = cells.filter(([c, r]) => !admin.state.used[`${c}-${r}`]);
      const [c, r] = free[Math.floor(Math.random() * free.length)];
      await playClue(c, r, i++);
      await sleep(rand(1000, 4000));
      if (Date.now() - lastSample > 30000) { lastSample = Date.now(); const st = await stats(srv); if (st) { memSamples.push(st.mem.rss); log(`  ${Math.round((Date.now() - (end - SOAK_MIN * 60000)) / 60000)} min – ${i} ruter, minne ${MB(st.mem.rss)} MB, ${st.sockets} tilkoblinger`); } }
    }
  }

  // ───────── Rapport ─────────
  const fin = await stats(srv);
  const adminSizes = admin.sizes || [], botSizes = bots.flatMap(b => b.sizes);
  const errs = srv.errors();
  if (errs.length) violate(`${errs.length} uventede feil i serverloggen: ${errs[0]}`);
  const p95fan = pct(fanOut, 95), p95lock = pct(buzzToLock, 95);
  if (p95fan > 500) violate(`p95 for «buzzer åpnet» er ${p95fan} ms (> 500 ms)`);
  if (p95lock > 500) violate(`p95 for «buzz → låst hos alle» er ${p95lock} ms (> 500 ms)`);
  if (fin && memSamples.length > 1 && rss0 && fin.mem.rss > 2 * rss0 && fin.mem.rss - rss0 > 100 * 1048576) violate(`serverminnet vokste fra ${MB(rss0)} til ${MB(fin.mem.rss)} MB`);
  if (fin && fin.sockets > N + 4) violate(`${fin.sockets} åpne tilkoblinger på serveren, forventet ca. ${N + 2} (døde sockets?)`);

  const report = [
    `Lasttest ${new Date().toLocaleString('no')}`,
    `Spillere: ${N}   Modus: ${SOAK_MIN ? `soak ${SOAK_MIN} min` : `${Math.min(CLUES, 25)} ruter + 3 på brett 2, restart etter rute ${RESTART_AT}`}`,
    `«Buzzer åpnet» hos spiller (ms):   p50 ${pct(fanOut, 50)}   p95 ${p95fan}   maks ${pct(fanOut, 100)}   (n=${fanOut.length})`,
    `«Buzz → låst» hos spiller (ms):    p50 ${pct(buzzToLock, 50)}   p95 ${p95lock}   maks ${pct(buzzToLock, 100)}   (n=${buzzToLock.length})`,
    `Meldingsstørrelse state til spiller: snitt ${Math.round(botSizes.reduce((a, b) => a + b, 0) / (botSizes.length || 1))} B, maks ${botSizes.reduce((m, x) => Math.max(m, x), 0)} B`,
    `Meldingsstørrelse state til admin:   snitt ${Math.round(adminSizes.reduce((a, b) => a + b, 0) / (adminSizes.length || 1))} B, maks ${adminSizes.reduce((m, x) => Math.max(m, x), 0)} B`,
    fin ? `Server: minne ${MB(fin.mem.rss)} MB (start ${rss0 ? MB(rss0) : '?'} MB), CPU ${Math.round((fin.cpu.user + fin.cpu.system) / 1000)} ms totalt, ${fin.sockets} tilkoblinger` : 'Server: ingen statistikk',
    violations.length ? `\nRESULTAT: FEIL (${violations.length})\n - ${violations.join('\n - ')}` : '\nRESULTAT: OK – alle invarianter holdt',
  ].join('\n');
  log('\n' + report + '\n');
  fs.writeFileSync(path.join(__dirname, 'load-report.txt'), report + '\n');

  bots.forEach(b => b.stop()); if (hostile) hostile.terminate(); admin.close(); display.close();
  await srv.cleanup();
  process.exit(violations.length ? 1 : 0);
})().catch(err => { console.error('Lasttesten krasjet:', err); process.exit(2); });
