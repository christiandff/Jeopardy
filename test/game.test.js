// Spillregler og robusthet i WebSocket-laget. Kjør: npm test
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, mkAdmin, mkPlayer, mkDisplay, until, sleep } = require('./helpers');

describe('spillregler', () => {
  let srv, admin, clients;
  const open = async (...names) => { const ps = []; for (const n of names) { const p = await mkPlayer(srv, n); clients.push(p); ps.push(p); } return ps; };
  const startClue = async (c, r) => { admin.act('select', { c, r }); await admin.waitState(s => s.current && s.current.c === c && s.current.r === r, 3000, 'valgt rute'); };
  const score = name => admin.state.players.find(p => p.name === name).score;

  before(async () => { srv = await startServer(); admin = await mkAdmin(srv); });
  after(async () => { admin.close(); await srv.cleanup(); });
  beforeEach(async () => {
    clients = [];
    admin.act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: false });
    await sleep(1100); // la rate-limit-vinduet (20 meldinger/s per tilkobling) tømmes mellom testene
    admin.act('resetAll');
    for (const p of admin.state.players) { admin.act('kick', { id: p.id }); await sleep(60); }
    await admin.waitState(s => s.players.length === 0 && !s.started && !s.current, 3000, 'ren tilstand');
  });
  const closeAll = () => clients.forEach(c => c.close());

  it('lobby: spørsmål kan ikke velges før spillet er startet', async () => {
    admin.act('select', { c: 0, r: 0 }); await sleep(150);
    assert.equal(admin.state.current, null);
    admin.act('start'); await admin.waitState(s => s.started);
    await startClue(0, 0);
    admin.act('lobby'); await sleep(150);
    assert.equal(admin.state.started, true, 'kan ikke gå til lobby mens spørsmål er åpent');
    admin.act('close'); await admin.waitState(s => !s.current);
    admin.act('lobby'); await admin.waitState(s => !s.started);
  });

  it('buzz-kappløp: 20 spillere buzzer samtidig, nøyaktig én vinner', async () => {
    const ps = await open(...Array.from({ length: 20 }, (_, i) => 'P' + i));
    admin.act('start'); await startClue(0, 0); admin.act('open');
    await admin.waitState(s => s.current.phase === 'open');
    ps.forEach(p => p.buzz());
    const s = await admin.waitState(s => s.current.phase === 'answering');
    assert.ok(ps.some(p => p.id === s.current.answering), 'en av spillerne svarer');
    await sleep(200);
    assert.equal(admin.state.current.lockedOut.length, 0);
    // alle ser samme vinner
    for (const p of ps) assert.equal(p.state.current.answering, s.current.answering);
    closeAll();
  });

  it('feil svar: minuspoeng, utestengt, andre kan stjele for pluss og får valgretten', async () => {
    const [a, b, c] = await open('A', 'B', 'C');
    admin.act('start'); await startClue(0, 2); // 300
    admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    a.buzz(); await admin.waitState(s => s.current.answering === a.id);
    admin.act('wrong');
    await admin.waitState(s => s.current.phase === 'open' && s.current.lockedOut.includes(a.id));
    assert.equal(score('A'), -300);
    a.buzz(); await sleep(150);
    assert.equal(admin.state.current.answering, null, 'utestengt spiller kan ikke buzze');
    b.buzz(); await admin.waitState(s => s.current.answering === b.id);
    admin.act('correct');
    await admin.waitState(s => s.current.phase === 'revealed');
    assert.equal(score('B'), 300);
    assert.equal(admin.state.chooser, b.id);
    assert.equal(score('C'), 0);
    closeAll();
  });

  it('utdatert Riktig/Feil fra admin (noen andre har overtatt) ignoreres – ingen feil poeng', async () => {
    const [a, b] = await open('A', 'B');
    admin.act('start'); await startClue(0, 1); admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    a.buzz(); await admin.waitState(s => s.current.answering === a.id);
    admin.act('wrong', { who: a.id }); await admin.waitState(s => s.current.lockedOut.includes(a.id));
    b.buzz(); await admin.waitState(s => s.current.answering === b.id);
    admin.act('correct', { who: a.id }); admin.act('wrong', { who: a.id }); // admin så fortsatt A på skjermen
    await sleep(250);
    assert.equal(admin.state.current.answering, b.id, 'B svarer fortsatt');
    assert.equal(score('B'), 0); assert.equal(score('A'), -200);
    admin.act('correct', { who: b.id }); await admin.waitState(s => s.current.phase === 'revealed');
    assert.equal(score('B'), 200);
    closeAll();
  });

  it('alle svarer feil → svaret vises', async () => {
    const [a, b] = await open('A', 'B');
    admin.act('start'); await startClue(1, 0); admin.act('open');
    a.buzz(); await admin.waitState(s => s.current.answering === a.id); admin.act('wrong');
    await admin.waitState(s => s.current.phase === 'open');
    b.buzz(); await admin.waitState(s => s.current.answering === b.id); admin.act('wrong');
    const s = await admin.waitState(s => s.current.phase === 'revealed');
    assert.ok(s.current.a, 'svaret er med');
    closeAll();
  });

  it('svaret lekker ikke til spillere/storskjerm før det vises', async () => {
    const [a] = await open('A'); const d = await mkDisplay(srv);
    admin.act('start'); await startClue(0, 0);
    await a.waitState(s => s.current);
    assert.equal(a.state.current.a, undefined); assert.equal(d.state.current.a, undefined);
    assert.ok(admin.state.current.a);
    admin.act('reveal'); await a.waitState(s => s.current.phase === 'revealed');
    assert.ok(a.state.current.a); d.close(); closeAll();
  });

  it('timer: buzz-tid går ut → svaret vises', async () => {
    await open('A');
    admin.act('setTimers', { buzzSecs: 1, answerSecs: 1, chooserFirst: false });
    admin.act('start'); await startClue(0, 0); admin.act('open');
    const s = await admin.waitState(s => s.current.phase === 'open' && s.current.deadline);
    assert.equal(s.current.timerTotal, 1);
    await admin.waitState(s => s.current.phase === 'revealed', 2500, 'buzz-timeout');
    closeAll();
  });

  it('timer: svar-tid går ut → regnes som feil, buzzerne åpnes', async () => {
    const [a, b] = await open('A', 'B');
    admin.act('setTimers', { buzzSecs: 5, answerSecs: 1, chooserFirst: false });
    admin.act('start'); await startClue(0, 0); admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    a.buzz(); await admin.waitState(s => s.current.phase === 'answering');
    await admin.waitState(s => s.current.phase === 'open' && s.current.lockedOut.includes(a.id), 2500, 'svar-timeout');
    assert.equal(score('A'), -100);
    b.buzz(); await admin.waitState(s => s.current.answering === b.id);
    closeAll();
  });

  it('timer 0 = av: ingen frist og ingen automatikk', async () => {
    await open('A');
    admin.act('start'); await startClue(0, 0); admin.act('open');
    await admin.waitState(s => s.current.phase === 'open');
    await sleep(1300);
    assert.equal(admin.state.current.phase, 'open'); assert.equal(admin.state.current.deadline, null);
    closeAll();
  });

  it('husregel «valgt lag svarer først» (av som standard)', async () => {
    const [a, b] = await open('A', 'B');
    admin.act('start'); admin.act('setChooser', { id: a.id });
    await startClue(0, 0);
    assert.equal(admin.state.current.phase, 'read', 'av: vanlig oppstart');
    admin.act('close'); await admin.waitState(s => !s.current);
    admin.act('setTimers', { buzzSecs: 0, answerSecs: 0, chooserFirst: true });
    await startClue(0, 1);
    assert.equal(admin.state.current.answering, a.id); assert.equal(admin.state.current.first, true);
    b.buzz(); await sleep(150); assert.equal(admin.state.current.answering, a.id, 'andre kan ikke buzze forbi');
    admin.act('wrong'); await admin.waitState(s => s.current.phase === 'open');
    closeAll();
  });

  it('fjerning av svarende spiller åpner buzzerne igjen', async () => {
    const [a, b] = await open('A', 'B');
    admin.act('start'); await startClue(0, 0); admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    a.buzz(); await admin.waitState(s => s.current.answering === a.id);
    admin.act('kick', { id: a.id });
    await admin.waitState(s => s.current.phase === 'open' && s.current.answering === null);
    await a.waitState(() => true); assert.ok(a.types.includes('kicked'));
    b.buzz(); await admin.waitState(s => s.current.answering === b.id);
    closeAll();
  });

  it('frakobling og gjenkobling med lagret id beholder poeng', async () => {
    const [a] = await open('A');
    admin.act('start'); await startClue(0, 0); admin.act('open'); a.buzz();
    await admin.waitState(s => s.current.answering === a.id); admin.act('correct');
    await admin.waitState(s => s.current.phase === 'revealed');
    a.terminate(); // brå frakobling uten lukk-melding
    await admin.waitState(s => s.players[0].connected === false, 3000, 'frakobling');
    const again = await mkPlayer(srv, '', a.id); clients.push(again);
    assert.equal(again.id, a.id);
    await admin.waitState(s => s.players[0].connected && s.players[0].score === 100);
    closeAll();
  });

  it('lagnavn: duplikat avvises mens laget er tilkoblet, og gjenopptas når det er borte', async () => {
    const [a] = await open('Ola');
    const dup = await mkPlayer(srv, 'ola'); clients.push(dup);
    assert.ok(dup.types.includes('nameTaken')); assert.equal(admin.state.players.length, 1);
    a.close(); await admin.waitState(s => s.players[0].connected === false);
    const back = await mkPlayer(srv, 'OLA'); clients.push(back);
    assert.equal(back.id, a.id, 'samme lag gjenopptas');
    closeAll();
  });

  it('lagnavn kuttes til 20 tegn og tomt navn avvises', async () => {
    const long = await mkPlayer(srv, 'x'.repeat(50)); clients.push(long);
    assert.equal(long.joined.name.length, 20);
    const empty = await mkPlayer(srv, '   '); clients.push(empty);
    assert.ok(empty.types.includes('needName'));
    closeAll();
  });

  it('flere brett: flip, brukte ruter huskes per brett, flip blokkert med åpent spørsmål', async () => {
    await open('A');
    admin.act('start');
    await startClue(0, 0); admin.act('flip'); await sleep(150);
    assert.equal(admin.state.round, 0, 'flip blokkert mens spørsmål er åpent');
    admin.act('close'); await admin.waitState(s => !s.current && s.used['0-0']);
    admin.act('flip'); await admin.waitState(s => s.round === 1);
    assert.ok(admin.state.rounds.length >= 2); assert.equal(Object.keys(admin.state.used).length, 0);
    assert.equal(admin.state.board[0].clues[0].value, 200, 'brett 2 har dobbel verdi');
    await startClue(1, 1); admin.act('close'); await admin.waitState(s => s.used['1-1']);
    admin.act('flip'); await admin.waitState(s => s.round === 0, 3000, 'rundt til brett 1');
    assert.ok(admin.state.used['0-0']); assert.ok(!admin.state.used['1-1']);
    admin.act('setRound', { round: 1 }); await admin.waitState(s => s.round === 1 && s.used['1-1']);
    admin.act('setRound', { round: 99 }); await sleep(100); assert.equal(admin.state.round, 1);
    closeAll();
  });

  it('«brett ferdig» og nullstilling', async () => {
    await open('A');
    admin.act('start');
    for (let c = 0; c < 5; c++) for (let r = 0; r < 5; r++) {
      await startClue(c, r); admin.act('close'); await admin.waitState(s => !s.current && s.used[`${c}-${r}`]);
      await sleep(70); // under rate-limit på 20 meldinger/s
    }
    assert.equal(admin.state.roundDone, true);
    admin.act('resetBoard'); await admin.waitState(s => Object.keys(s.used).length === 0);
    assert.equal(admin.state.players.length, 1, 'resetBoard beholder lag');
    admin.act('resetAll'); await admin.waitState(s => !s.started && s.round === 0);
    closeAll();
  });

  it('poengjustering og valgrett fra admin', async () => {
    const [a] = await open('A');
    admin.act('adjust', { id: a.id, delta: 250 }); await admin.waitState(s => s.players[0].score === 250);
    admin.act('adjust', { id: a.id, delta: 'abc' }); await sleep(100); assert.equal(score('A'), 250);
    admin.act('setChooser', { id: a.id }); await admin.waitState(s => s.chooser === a.id);
    closeAll();
  });
});

describe('robusthet', () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = await mkAdmin(srv); });
  after(async () => { admin.close(); await srv.cleanup(); });

  it('hjerteslag («hb») sendes til alle klienter', async () => {
    const d = await mkDisplay(srv);
    await until(() => d.types.includes('hb'), 7000, 'hjerteslag');
    d.close();
  });

  it('ugyldige meldinger tar ikke ned serveren', async () => {
    const d = await mkDisplay(srv);
    for (const bad of ['null', '123', '"tekst"', '[]', 'true', '{', '{"type":null}', '{"type":"hello"}',
      '{"type":"hello","role":"player","pid":"__proto__"}', '{"type":"hello","role":"player","pid":{"a":1},"name":{"b":2}}',
      '{"type":"hello","role":"player","pid":"constructor"}', '{"type":"admin","action":"select","c":"constructor","r":0}']) d.send(bad);
    await sleep(400);
    assert.equal(srv.exited, false, 'serveren kjører fortsatt');
    assert.ok((await fetch(srv.base + '/api/me')).ok);
    assert.deepEqual(srv.errors(), [], 'ingen uventede feil i serverloggen');
    assert.equal(({}).connected, undefined);
    // et vanlig lag kan fortsatt bli med
    const p = await mkPlayer(srv, 'Etterpå'); assert.ok(p.id); p.close(); d.close();
  });

  it('ikke-admin kan ikke sende admin-kommandoer', async () => {
    const p = await mkPlayer(srv, 'Lurendreier');
    p.send({ type: 'admin', action: 'start' }); p.send({ type: 'hello', role: 'admin' });
    p.send({ type: 'admin', action: 'start' });
    await sleep(300);
    assert.equal(admin.state.started, false);
    assert.ok(p.types.includes('unauthorized'));
    p.close();
  });

  it('for store meldinger (>10 KB) lukker tilkoblingen', async () => {
    const d = await mkDisplay(srv);
    d.send(JSON.stringify({ type: 'hello', role: 'display', junk: 'x'.repeat(20000) }));
    await until(() => d.closed, 3000, 'at serveren lukker tilkoblingen');
    assert.equal(srv.exited, false);
  });

  it('rate-limit: spam fra én tilkobling gir ikke 100 endringer', async () => {
    admin.act('start'); await admin.waitState(s => s.started);
    const p = await mkPlayer(srv, 'Spam');
    admin.act('resetAll'); await admin.waitState(s => !s.started);
    const adm2 = await mkAdmin(srv);
    for (let i = 0; i < 100; i++) adm2.act('adjust', { id: p.id, delta: 1 });
    await sleep(500);
    const sc = admin.state.players.find(x => x.id === p.id).score;
    assert.ok(sc > 0 && sc <= 30, `maks ~20 meldinger/s slipper gjennom, fikk ${sc}`);
    adm2.close(); p.close();
  });

  it('mange tilkoblinger som kobler til og fra raskt gir ingen lekkasje av «tilkoblede» lag', async () => {
    const ps = [];
    for (let i = 0; i < 25; i++) ps.push(await mkPlayer(srv, 'R' + i));
    ps.forEach(p => p.terminate());
    await admin.waitState(s => s.players.filter(p => p.name.startsWith('R')).every(p => !p.connected), 4000, 'alle frakoblet');
  });
});

describe('YouTube-ruter', () => {
  const { login } = require('./helpers');
  const ID = 'dQw4w9WgXcQ';
  let srv, admin, ck;
  before(async () => {
    srv = await startServer(); ck = await login(srv);
    const board = { boards: [{ name: 'Musikk', categories: [{ name: 'Sanger', clues: [
      { value: 100, q: '', a: 'Svaret', yt: `https://youtu.be/${ID}?t=5`, ytStart: 5, ytEnd: 30, ytHide: true },
      { value: 200, q: 'Vanlig spørsmål', a: 'x' },
    ] }] }] };
    const r = await fetch(srv.base + '/api/board', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(board) });
    assert.equal(r.status, 200);
    admin = await mkAdmin(srv);
  });
  after(async () => { admin.close(); await srv.cleanup(); });

  it('video-ID er kun synlig for admin og storskjerm, aldri for spillere', async () => {
    const p = await mkPlayer(srv, 'Lytter'), d = await mkDisplay(srv);
    admin.act('start'); await admin.waitState(s => s.started);
    admin.act('select', { c: 0, r: 0 }); await admin.waitState(s => s.current);
    await p.waitState(s => s.current); await d.waitState(s => s.current && s.current.yt);
    assert.deepEqual(admin.state.current.yt, { id: ID, start: 5, end: 30, hide: true });
    assert.deepEqual(d.state.current.yt, { id: ID, start: 5, end: 30, hide: true });
    assert.equal(p.state.current.yt, undefined);
    assert.equal(p.state.current.hasYt, true);
    assert.ok(!JSON.stringify(p.state).includes(ID), 'spillerens state inneholder ikke video-ID');
    p.close(); d.close();
  });

  it('avspilling styres fra admin og pauses når noen buzzer', async () => {
    const p = await mkPlayer(srv, 'Buzzer');
    const media = () => admin.state.current.media;
    admin.act('mediaPlay'); await admin.waitState(s => s.current.media.playing);
    await p.waitState(s => s.current.media.playing);
    admin.act('mediaPause'); await admin.waitState(s => !s.current.media.playing);
    admin.act('mediaRestart'); await admin.waitState(s => s.current.media.playing && s.current.media.nonce === 1);
    admin.act('open'); await admin.waitState(s => s.current.phase === 'open');
    assert.equal(media().playing, true, 'musikken fortsetter mens buzzerne åpnes');
    p.buzz(); await admin.waitState(s => s.current.phase === 'answering');
    assert.equal(media().playing, false, 'pauset av buzz');
    p.close();
  });

  it('storskjermen melder fra om ferdig/feil; andre kan ikke påvirke avspillingen', async () => {
    const d = await mkDisplay(srv), p = await mkPlayer(srv, 'Lurer');
    admin.act('mediaPlay'); await admin.waitState(s => s.current.media.playing);
    p.send({ type: 'display', action: 'ytEnded' }); await sleep(200);
    assert.equal(admin.state.current.media.playing, true, 'spillere kan ikke stoppe videoen');
    d.send({ type: 'display', action: 'ytEnded' }); await admin.waitState(s => !s.current.media.playing);
    admin.act('mediaPlay'); await admin.waitState(s => s.current.media.playing);
    d.send({ type: 'display', action: 'ytError', code: 150 });
    await admin.waitState(s => s.current.media.error === 150 && !s.current.media.playing);
    admin.act('mediaPlay'); await admin.waitState(s => s.current.media.playing && s.current.media.error === null);
    admin.act('reveal'); await admin.waitState(s => s.current.phase === 'revealed' && !s.current.media.playing);
    d.close(); p.close();
  });

  it('vanlige ruter uten video: avspillingskommandoer gjør ingenting', async () => {
    admin.act('close'); await admin.waitState(s => !s.current);
    admin.act('select', { c: 0, r: 1 }); await admin.waitState(s => s.current);
    assert.equal(admin.state.current.yt, undefined); assert.equal(admin.state.current.hasYt, false);
    admin.act('mediaPlay'); admin.act('mediaRestart'); await sleep(200);
    assert.equal(admin.state.current.media.playing, false); assert.equal(admin.state.current.media.nonce, 0);
  });
});
