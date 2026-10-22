// Tester for siste gjennomgang: ugyldige verdier, skadet tilstand, musikk som stopper, innloggingsvern og XSS via storskjerm-status.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, login, mkAdmin, mkPlayer, mkDisplay, sleep } = require('./helpers');

const ID = 'dQw4w9WgXcQ';
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const postJson = (srv, url, body, cookie, headers = {}) => fetch(srv.base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body),
});

describe('musikk-ruter: status og stopp', () => {
  let srv, admin, ck;
  before(async () => {
    srv = await startServer(); ck = await login(srv);
    const board = { boards: [{ name: 'M', categories: [{ name: 'Sanger', clues: [
      { value: 100, q: '', a: 'Svar', yt: ID, ytStart: 5, ytEnd: 30, ytHide: true },
      { value: 200, q: 'Vanlig', a: 'x' },
    ] }] }] };
    assert.equal((await postJson(srv, '/api/board', board, ck)).status, 200);
    admin = await mkAdmin(srv);
  });
  after(async () => { admin.close(); await srv.cleanup(); });
  const reset = async () => {
    await sleep(1100);
    admin.act('resetAll'); admin.act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: false });
    for (const p of admin.state.players) { admin.act('kick', { id: p.id }); await sleep(60); }
    await admin.waitState(s => !s.started && !s.current && s.players.length === 0);
  };

  it('ytStatus: bare kjente verdier lagres, HTML/skript fra «storskjerm» avvises', async () => {
    await reset();
    const d = await mkDisplay(srv), rogue = await mkDisplay(srv); // hvem som helst kan si at de er en storskjerm
    admin.act('start'); admin.act('select', { c: 0, r: 0 }); await admin.waitState(s => s.current);
    for (const bad of ['<svg onload=alert(1)>', '<img src=x onerror=alert(1)>', 'playing<b>', '', null, 42, { x: 1 }, 'PLAYING', 'constructor'])
      rogue.send({ type: 'display', action: 'ytStatus', status: bad });
    await sleep(300);
    assert.equal(admin.state.current.media.status, null, 'ugyldig status ble ikke lagret');
    d.send({ type: 'display', action: 'ytStatus', status: 'playing' });
    await admin.waitState(s => s.current.media.status === 'playing');
    d.close(); rogue.close();
  });

  it('admin-siden escaper status (statisk sjekk av reserveverdien)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    assert.match(src, /\|\| esc\(cur\.media\.status\)/);
    assert.doesNotMatch(src, /\|\| cur\.media\.status\)/);
  });

  it('buzz-tiden går ut → musikken stoppes sammen med at svaret vises', async () => {
    await reset();
    await mkPlayer(srv, 'A').then(p => p.close());
    admin.act('setTimers', { buzzSecs: 1, answerSecs: 1, chooserFirst: false });
    admin.act('start'); admin.act('select', { c: 0, r: 0 }); await admin.waitState(s => s.current);
    admin.act('mediaPlay'); await admin.waitState(s => s.current.media.playing);
    admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    assert.equal(admin.state.current.media.playing, true, 'musikken spiller mens buzzerne er åpne');
    await admin.waitState(s => s.current.phase === 'revealed', 3000, 'buzz-timeout');
    assert.equal(admin.state.current.media.playing, false, 'musikken stoppet ved timeout');
    assert.equal(admin.state.current.deadline, null);
  });

  it('siste lag svarer feil → svaret vises og musikken stoppes', async () => {
    await reset();
    const p = await mkPlayer(srv, 'Alene');
    admin.act('start'); admin.act('select', { c: 0, r: 0 }); await admin.waitState(s => s.current);
    admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    p.buzz(); await admin.waitState(s => s.current.answering === p.id);
    admin.act('mediaPlay'); await admin.waitState(s => s.current.media.playing);
    admin.act('wrong', { who: p.id });
    await admin.waitState(s => s.current.phase === 'revealed');
    assert.equal(admin.state.current.media.playing, false);
    p.close();
  });

  it('svar-tiden går ut for siste lag → svaret vises og musikken stoppes', async () => {
    await reset();
    const p = await mkPlayer(srv, 'Treg');
    admin.act('setTimers', { buzzSecs: 5, answerSecs: 1, chooserFirst: false });
    admin.act('start'); admin.act('select', { c: 0, r: 0 }); await admin.waitState(s => s.current);
    admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    p.buzz(); await admin.waitState(s => s.current.answering === p.id);
    admin.act('mediaPlay'); await admin.waitState(s => s.current.media.playing);
    await admin.waitState(s => s.current.phase === 'revealed', 3000, 'svar-timeout');
    assert.equal(admin.state.current.media.playing, false);
    p.close();
  });
});

describe('ugyldige admin-kommandoer', () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = await mkAdmin(srv); admin.act('start'); await admin.waitState(s => s.started); });
  after(async () => { admin.close(); await srv.cleanup(); });
  const quiet = async () => { await sleep(1100); }; // rate-limit-vinduet

  it('select med rare verdier gjør ingenting; gyldige tall (også som tekst) fungerer', async () => {
    await quiet();
    for (const [c, r] of [['constructor', 0], [0, '__proto__'], [0.5, 1], [-1, 0], [99, 99], [null, null], [{}, []], ['x', 'y']]) {
      admin.act('select', { c, r }); await sleep(40);
      assert.equal(admin.state.current, null, `select(${JSON.stringify(c)}, ${JSON.stringify(r)}) ble ignorert`);
    }
    assert.equal(srv.exited, false); assert.deepEqual(srv.errors(), []);
    admin.act('select', { c: '1', r: '2' }); await admin.waitState(s => s.current && s.current.c === 1 && s.current.r === 2);
    assert.equal(typeof admin.state.current.c, 'number');
    admin.act('close'); await admin.waitState(s => !s.current && s.used['1-2']);
  });

  it('adjust og setChooser: kun gyldige verdier', async () => {
    await quiet();
    const p = await mkPlayer(srv, 'Ola');
    const score = () => admin.state.players.find(x => x.id === p.id).score;
    admin.act('adjust', { id: p.id, delta: 100 }); await admin.waitState(() => score() === 100);
    for (const delta of ['abc', null, undefined, {}, [], 'Infinity', NaN]) admin.act('adjust', { id: p.id, delta });
    admin.act('adjust', { id: { toString: 'x' }, delta: 5 }); admin.act('adjust', { id: 'finnes-ikke', delta: 5 });
    await sleep(300); assert.equal(score(), 100);
    admin.act('adjust', { id: p.id, delta: 1e12 }); await admin.waitState(() => score() === 100100);
    admin.act('setChooser', { id: 'finnes-ikke' }); await sleep(100); assert.equal(admin.state.chooser, null);
    admin.act('setChooser', { id: p.id }); await admin.waitState(s => s.chooser === p.id);
    admin.act('setChooser', { id: null }); await admin.waitState(s => s.chooser === null);
    assert.equal(srv.exited, false); p.close();
  });
});

describe('skadet state.json', () => {
  it('feil typer får standardverdier, og brukte ruter lagres riktig etterpå', async () => {
    const dir = tmp('jeopardy-badstate-');
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      players: { a: { id: 'a', name: 'Anne', score: '120' }, b: { id: 'b', name: { x: 1 }, score: 'abc' }, c: 7, d: null, e: { id: '' } },
      usedAll: 'tekst', round: 'abc', started: 'yes', chooser: 5, settings: { buzzSecs: 'x', answerSecs: -5, chooserFirst: 'ja' },
    }));
    let srv = await startServer({ dir });
    let a = await mkAdmin(srv);
    assert.equal(a.state.round, 0); assert.equal(a.state.started, false); assert.equal(a.state.chooser, null);
    assert.deepEqual(a.state.settings, { buzzSecs: 15, answerSecs: 0, chooserFirst: false, mode: 'buzzer', penalty: true, doubles: 0 }); // doubles: standard fra DEFAULT_DOUBLES i testmiljøet
    assert.deepEqual(a.state.players.map(p => [p.id, p.score]).sort(), [['a', 120], ['b', 0]]);
    assert.ok(a.state.players.every(p => typeof p.name === 'string' && p.name.length <= 20));
    a.act('start'); await a.waitState(s => s.started);
    a.act('select', { c: 0, r: 0 }); await a.waitState(s => s.current);
    a.act('close'); await a.waitState(s => !s.current && s.used['0-0']);
    await sleep(700); await srv.kill();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(saved.usedAll['0'], { '0-0': true }, 'brukte ruter er et ordentlig objekt, ikke spredd tekst');
    srv = await startServer({ dir }); a = await mkAdmin(srv);
    assert.ok(a.state.used['0-0']); a.close(); await srv.cleanup();
  });

  it('usedAll med søppelnøkler og -verdier renses bort', async () => {
    const dir = tmp('jeopardy-badused-');
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      round: 0, usedAll: { 0: { '0-1': true, '__proto__': true, 'x-y': true, '1-1': 'ja', '2-2': true }, abc: { '0-0': true }, 1: 'tekst' },
    }));
    const srv = await startServer({ dir }); const a = await mkAdmin(srv);
    assert.deepEqual(Object.keys(a.state.used).sort(), ['0-1', '2-2']);
    a.close(); await srv.cleanup();
  });
});

describe('innloggingsvern', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { LOGIN_WINDOW_MS: '800' } }); });
  after(async () => { await srv.cleanup(); });
  const attempt = pw => postJson(srv, '/api/login', { password: pw });

  it('5 feil passord låser innlogging en stund (429), også for riktig passord; deretter åpnes det igjen', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await attempt('feil' + i)).status, 401);
    assert.equal((await attempt('feil')).status, 429);
    assert.equal((await attempt('testpw')).status, 429, 'riktig passord avvises mens låst');
    await sleep(900);
    assert.equal((await attempt('testpw')).status, 200, 'fungerer igjen etter ventetiden');
  });

  it('vellykket innlogging nullstiller telleren, og ugyldig/manglende body gir 401 uten å krasje', async () => {
    await sleep(900);
    for (let i = 0; i < 4; i++) assert.equal((await attempt('feil')).status, 401);
    assert.equal((await attempt('testpw')).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await attempt('feil')).status, 401, 'teller startet på nytt etter vellykket innlogging');
    await sleep(900);
    const r = await fetch(srv.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    const r2 = await fetch(srv.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
    assert.ok([400, 401].includes(r2.status)); assert.equal(srv.exited, false);
  });
});

describe('QR-endepunkt', () => {
  it('ugyldig JOIN_URL gir 500 som JSON – serveren henger ikke og kan fortsatt brukes', async () => {
    const srv = await startServer({ env: { JOIN_URL: 'x'.repeat(8000) } });
    const r = await fetch(srv.base + '/api/join', { signal: AbortSignal.timeout(4000) });
    assert.equal(r.status, 500); assert.ok((await r.json()).error);
    assert.ok((await fetch(srv.base + '/api/me')).ok);
    await srv.cleanup();
  });
  it('vanlig JOIN_URL brukes ordrett', async () => {
    const srv = await startServer({ env: { JOIN_URL: 'https://spill.example.com/play' } });
    const j = await (await fetch(srv.base + '/api/join')).json();
    assert.equal(j.url, 'https://spill.example.com/play'); assert.match(j.svg, /^<svg/);
    await srv.cleanup();
  });
});
