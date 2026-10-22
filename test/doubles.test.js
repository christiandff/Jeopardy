// «Dobbel poengsum»-ruter: tilfeldig plassering, skjult for spillerne, dobbel verdi, lagring.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, mkAdmin, mkPlayer, mkDisplay, sleep } = require('./helpers');

const key = (c, r) => `${c}-${r}`;
const parse = k => k.split('-').map(Number);

describe('dobbel poengsum', () => {
  let srv, admin;
  before(async () => { srv = await startServer({ env: { DEFAULT_DOUBLES: '3' } }); admin = await mkAdmin(srv); });
  after(async () => { admin.close(); await srv.cleanup(); });
  const fresh = async () => {
    await sleep(1100);
    admin.act('resetAll'); for (const p of admin.state.players) { admin.act('kick', { id: p.id }); await sleep(60); }
    await admin.waitState(s => !s.started && !s.current && s.players.length === 0);
    admin.act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: false, doubles: 3 });
    await admin.waitState(s => s.settings.doubles === 3);
    admin.act('start'); await admin.waitState(s => s.started && s.doubles.length === 3);
  };
  const pick = (s, wantDouble) => {
    for (let c = 0; c < s.board.length; c++) for (let r = 0; r < s.board[c].clues.length; r++)
      if (s.doubles.includes(key(c, r)) === wantDouble && !s.used[key(c, r)]) return [c, r];
  };

  it('3 unike ruter plasseres tilfeldig utenom øverste rad, og kun admin får vite hvor', async () => {
    await fresh();
    const d = admin.state.doubles;
    assert.equal(new Set(d).size, 3);
    for (const k of d) { const [c, r] = parse(k); assert.ok(admin.state.board[c].clues[r], 'ruten finnes'); assert.ok(r >= 1, 'ikke øverste rad (100-poengsrutene)'); }
    const p = await mkPlayer(srv, 'Spion'), disp = await mkDisplay(srv);
    await p.waitState(() => true);
    for (const st of [p.state, disp.state]) {
      assert.equal(st.doubles, undefined, 'spillere og storskjerm får ikke listen');
      const json = JSON.stringify(st);
      for (const k of d) assert.ok(!json.includes(`"${k}":`) || st.used[k] === undefined, 'ingen avsløring i tilstanden');
    }
    p.close(); disp.close();
  });

  it('plasseringen er tilfeldig: gjentatt nullstilling gir ulike plasseringer', async () => {
    await fresh();
    const seen = new Set([admin.state.doubles.slice().sort().join(',')]);
    for (let i = 0; i < 12; i++) {
      await sleep(80); admin.act('resetBoard');
      await admin.waitState(s => s.doubles.length === 3 && Object.keys(s.used).length === 0);
      seen.add(admin.state.doubles.slice().sort().join(','));
    }
    assert.ok(seen.size >= 6, `ulike plasseringer: ${seen.size}`);
  });

  it('dobbel rute: verdi ×2 for alle, riktig gir +2×, feil −2×, og stjeling fungerer', async () => {
    await fresh();
    const a = await mkPlayer(srv, 'A'), b = await mkPlayer(srv, 'B');
    const [c, r] = pick(admin.state, true); const base = admin.state.board[c].clues[r].value;
    const score = n => admin.state.players.find(p => p.name === n).score;
    admin.act('select', { c, r }); await admin.waitState(s => s.current);
    assert.equal(admin.state.current.double, true); assert.equal(admin.state.current.value, base * 2);
    assert.equal(admin.state.event.type, 'double');
    await a.waitState(s => s.current && s.current.double); assert.equal(a.state.current.value, base * 2, 'spillerne ser dobbel verdi');
    admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    a.buzz(); await admin.waitState(s => s.current.answering === a.id); admin.act('wrong', { who: a.id });
    await admin.waitState(s => s.current.lockedOut.includes(a.id)); assert.equal(score('A'), -base);
    b.buzz(); await admin.waitState(s => s.current.answering === b.id); admin.act('correct', { who: b.id });
    await admin.waitState(s => s.current.phase === 'revealed'); assert.equal(score('B'), base * 2);
    a.close(); b.close();
  });

  it('vanlig rute er uendret (ingen ×2, ingen «double»-hendelse)', async () => {
    await fresh();
    const a = await mkPlayer(srv, 'A');
    const [c, r] = pick(admin.state, false); const base = admin.state.board[c].clues[r].value;
    admin.act('select', { c, r }); await admin.waitState(s => s.current);
    assert.equal(admin.state.current.double, false); assert.equal(admin.state.current.value, base);
    assert.notEqual(admin.state.event.type, 'double');
    admin.act('open'); a.buzz(); await admin.waitState(s => s.current.answering === a.id); admin.act('correct', { who: a.id });
    await admin.waitState(s => s.current.phase === 'revealed'); assert.equal(admin.state.players[0].score, base);
    a.close();
  });

  it('antall kan endres (0–5), klemmes, og brukte ruter blir aldri valgt', async () => {
    await fresh();
    const a = await mkPlayer(srv, 'A');
    for (const [want, send] of [[0, 0], [5, 5], [5, 99], [2, 2], [2, 'abc'], [2, null], [4, '4']]) {
      await sleep(80); admin.act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: false, doubles: send });
      await admin.waitState(s => s.settings.doubles === want && s.doubles.length === want, 3000, `antall ${want} (sendte ${send})`);
    }
    // bruk 6 ruter, og sett antall på nytt: nye plasseringer unngår de brukte
    const used = [];
    for (let i = 0; i < 6; i++) {
      const [c, r] = pick(admin.state, false) || pick(admin.state, true);
      admin.act('select', { c, r }); await admin.waitState(s => s.current); admin.act('close'); await admin.waitState(s => !s.current && s.used[key(c, r)]);
      used.push(key(c, r)); await sleep(80);
    }
    for (const n of [3, 5]) {
      admin.act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: false, doubles: n });
      await admin.waitState(s => s.settings.doubles === n && s.doubles.length === n);
      for (const k of admin.state.doubles) assert.ok(!used.includes(k), `${k} er allerede brukt`);
    }
    a.close();
  });

  it('flere brett: hvert brett har egne dobbel-ruter som huskes når du flipper frem og tilbake', async () => {
    await fresh();
    const r0 = admin.state.doubles.slice().sort();
    admin.act('flip'); await admin.waitState(s => s.round === 1 && s.doubles.length === 3);
    const r1 = admin.state.doubles.slice().sort();
    admin.act('flip'); await admin.waitState(s => s.round === 0);
    assert.deepEqual(admin.state.doubles.slice().sort(), r0, 'brett 1 husker plasseringen');
    admin.act('flip'); await admin.waitState(s => s.round === 1);
    assert.deepEqual(admin.state.doubles.slice().sort(), r1, 'brett 2 husker plasseringen');
  });

  it('antall 0 gir ingen dobbel-ruter', async () => {
    await fresh();
    admin.act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: false, doubles: 0 });
    await admin.waitState(s => s.settings.doubles === 0 && s.doubles.length === 0);
    admin.act('select', { c: 1, r: 1 }); await admin.waitState(s => s.current);
    assert.equal(admin.state.current.double, false);
  });
});

describe('dobbel poengsum: lagring', () => {
  it('plassering, innstilling og dobbel-status overlever restart (SIGKILL)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-dbl-'));
    let srv = await startServer({ dir, env: { DEFAULT_DOUBLES: '2' } });
    let a = await mkAdmin(srv);
    a.act('start'); await a.waitState(s => s.started && s.doubles.length === 2);
    const before = a.state.doubles.slice().sort();
    a.act('flip'); await a.waitState(s => s.round === 1 && s.doubles.length === 2);
    const before1 = a.state.doubles.slice().sort();
    await sleep(700); await srv.kill();

    srv = await startServer({ dir, env: { DEFAULT_DOUBLES: '2' } }); a = await mkAdmin(srv);
    assert.equal(a.state.round, 1); assert.deepEqual(a.state.doubles.slice().sort(), before1);
    a.act('flip'); await a.waitState(s => s.round === 0);
    assert.deepEqual(a.state.doubles.slice().sort(), before, 'brett 1 beholdt plasseringen etter restart');
    a.close(); await srv.cleanup();
  });

  it('skadede doble-data i state.json renses (ugyldige ruter/typer ignoreres)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-dbl2-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      started: true, round: 0, settings: { doubles: 99 },
      doubles: { 0: ['1-1', '99-99', 'x', 5, '2-3', '2-3'], abc: ['0-0'], 1: 'tekst', 7: ['0-0'] },
    }));
    const srv = await startServer({ dir }); const a = await mkAdmin(srv);
    assert.equal(a.state.settings.doubles, 5, '99 klemmes til 5');
    assert.ok(a.state.doubles.every(k => /^\d+-\d+$/.test(k)) && !a.state.doubles.includes('99-99'));
    assert.ok(a.state.doubles.includes('1-1') && a.state.doubles.includes('2-3'));
    assert.equal(srv.exited, false); a.close(); await srv.cleanup();
  });
});
