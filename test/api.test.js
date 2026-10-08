// HTTP-grensesnittet: innlogging, brettvalidering, opplasting, korrupte filer og XSS-beskyttelse.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, login, mkAdmin, until, sleep, ROOT } = require('./helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const J = cookie => ({ 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) });
const post = (srv, url, body, cookie) => fetch(srv.base + url, { method: 'POST', headers: J(cookie), body: JSON.stringify(body) });
const clue = (v = 100, q = 'Spørsmål', a = 'Svar') => ({ value: v, q, a });
const board = (name = 'Brett 1', cats = [['Kat A', [clue(), clue(200)]], ['Kat B', [clue(), clue(200)]]]) =>
  ({ name, categories: cats.map(([n, clues]) => ({ name: n, clues })) });

describe('innlogging og tilgang', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.cleanup(); });

  it('feil passord gir 401, riktig gir cookie', async () => {
    assert.equal(await login(srv, 'feil'), null);
    const ck = await login(srv); assert.match(ck, /^admin=/);
    assert.equal((await (await fetch(srv.base + '/api/me', { headers: { Cookie: ck } })).json()).admin, true);
    assert.equal((await (await fetch(srv.base + '/api/me')).json()).admin, false);
  });

  it('beskyttede endepunkter krever admin', async () => {
    const calls = [
      post(srv, '/api/board', { boards: [board()] }),
      fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG }),
      fetch(srv.base + '/api/audio/lobby', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(100) }),
      fetch(srv.base + '/api/audio/lobby', { method: 'DELETE' }),
      fetch(srv.base + '/api/diag'),
    ];
    for (const r of await Promise.all(calls)) assert.equal(r.status, 401);
  });

  it('logg ut ugyldiggjør cookien', async () => {
    const ck = await login(srv);
    await fetch(srv.base + '/api/logout', { method: 'POST', headers: { Cookie: ck } });
    assert.equal((await (await fetch(srv.base + '/api/me', { headers: { Cookie: ck } })).json()).admin, false);
  });

  it('/api/join gir QR (svg) og adresse; /api/diag lister adresser for admin', async () => {
    const j = await (await fetch(srv.base + '/api/join')).json();
    assert.match(j.url, /\/play$/); assert.match(j.svg, /^<svg/);
    const d = await (await fetch(srv.base + '/api/diag', { headers: { Cookie: await login(srv) } })).json();
    assert.ok(Array.isArray(d.candidates));
  });

  it('sidene serveres', async () => {
    for (const p of ['/admin', '/play', '/display', '/style.css', '/common.js']) assert.equal((await fetch(srv.base + p)).status, 200, p);
  });
});

describe('brett: validering og lagring', () => {
  let srv, ck;
  before(async () => { srv = await startServer(); ck = await login(srv); });
  after(async () => { await srv.cleanup(); });
  const save = body => post(srv, '/api/board', body, ck);
  const err = async r => (await r.json()).error;

  it('avviser ugyldige brett med tydelig melding', async () => {
    const bad = [
      [{ boards: [] }, /1 og 6/],
      [{ boards: Array.from({ length: 7 }, () => board()) }, /1 og 6/],
      [{ boards: [board('B', [['A', [clue(100, '')]]])] }, /mangler spørsmål/],
      [{ boards: [board('B', [['A', [clue(100, 'q', '')]]])] }, /mangler svar/],
      [{ boards: [board('B', [['A', [clue(0)]]])] }, /poeng/],
      [{ boards: [board('B', [['A', [clue()]], ['a', [clue()]]])] }, /flere ganger/],
      [{ boards: [board('B', [['', [clue()]]])] }, /mangler navn/],
      [{ boards: [board('B', [['A', []]])] }, /ingen ruter/],
      [{ boards: [board('B', [['A', [{ ...clue(), img: '../server.js' }]]])] }, /bildenavn/],
      [{ boards: [board('B', [['A', [{ ...clue(), img: 'a/b.png' }]]])] }, /bildenavn/],
      [{ boards: [{ name: 'X' }] }, /minst én kategori/],
      [{}, /1 og 6/],
      [null, /Ugyldig|1 og 6/],
    ];
    for (const [body, re] of bad) {
      const r = await save(body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(await err(r), re);
    }
  });

  it('godtar gyldige brett, inkl. bare bilde uten tekst og eldre enkeltbrett-format', async () => {
    assert.equal((await save({ boards: [board('Runde 1'), board('Runde 2')] })).status, 200);
    assert.equal((await save({ boards: [board('B', [['A', [{ value: 100, q: '', a: '', img: 'abc123.png', aImg: 'def456.webp' }]]])] })).status, 200);
    assert.equal((await save({ categories: board().categories })).status, 200, 'gammelt format {categories}');
  });

  it('YouTube-lenker normaliseres til video-ID, tider lagres, ugyldige avvises', async () => {
    const ID = 'dQw4w9WgXcQ';
    const variants = [
      `https://www.youtube.com/watch?v=${ID}&t=43s`, `https://youtu.be/${ID}?si=abc`, `youtube.com/shorts/${ID}`,
      `https://music.youtube.com/watch?v=${ID}&list=RDx`, `https://www.youtube.com/embed/${ID}`,
      `https://m.youtube.com/watch?v=${ID}`, ID,
    ];
    const mk = yt => ({ boards: [board('B', [['A', [{ value: 100, q: '', a: 'svar', yt, ytStart: '12', ytEnd: 40.4, ytHide: true }]]])] });
    const a = await mkAdmin(srv);
    for (const v of variants) {
      assert.equal((await save(mk(v))).status, 200, v);
      await a.waitState(s => s.fullBoard.boards[0].categories[0].clues[0].yt === ID, 3000, 'normalisert ID for ' + v);
      const c = a.state.fullBoard.boards[0].categories[0].clues[0];
      assert.deepEqual([c.ytStart, c.ytEnd, c.ytHide], [12, 40, true]);
    }
    for (const bad of ['https://evil.com/watch?v=' + ID, 'https://youtube.com/watch?v=kort', 'javascript:alert(1)', 'https://youtu.be/<script>x</script>', 'ikke en lenke']) {
      const r = await save(mk(bad)); assert.equal(r.status, 400, bad); assert.match(await err(r), /YouTube-lenke/);
    }
    const b2 = mk(ID); b2.boards[0].categories[0].clues[0].ytStart = 30; b2.boards[0].categories[0].clues[0].ytEnd = 20;
    const r2 = await save(b2); assert.equal(r2.status, 400); assert.match(await err(r2), /slutt-tid/);
    a.close();
  });

  it('lagrer navn, rydder opp og skriver filen til disk', async () => {
    await save({ boards: [board('Alfa'), board('Beta')] });
    const onDisk = JSON.parse(fs.readFileSync(path.join(srv.dir, 'board.json'), 'utf8'));
    assert.deepEqual(onDisk.boards.map(b => b.name), ['Alfa', 'Beta']);
    assert.equal(fs.readdirSync(srv.dir).filter(f => f.endsWith('.tmp')).length, 0, 'ingen .tmp-filer igjen');
  });

  it('lagring nullstiller spillet og går til brett 1', async () => {
    const a = await mkAdmin(srv);
    a.act('start'); await a.waitState(s => s.started);
    await save({ boards: [board('Alfa'), board('Beta')] });
    const s = await a.waitState(s => Object.keys(s.used).length === 0 && s.round === 0);
    assert.deepEqual(s.rounds, ['Alfa', 'Beta']); a.close();
  });
});

describe('opplasting av bilder og lyd', () => {
  let srv, ck;
  before(async () => { srv = await startServer(); ck = await login(srv); });
  after(async () => { await srv.cleanup(); });
  const up = (type, body, c = ck) => fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'Content-Type': type, ...(c ? { Cookie: c } : {}) }, body });

  it('godtar bilde, serverer det, avviser feil filtype og tomme filer', async () => {
    const r = await up('image/png', PNG); assert.equal(r.status, 200);
    const { name } = await r.json(); assert.match(name, /^[0-9a-f]{16}\.png$/);
    const got = await fetch(`${srv.base}/uploads/${name}`); assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal((await up('text/html', '<script>alert(1)</script>')).status, 400);
    assert.equal((await up('image/svg+xml', '<svg onload=alert(1)>')).status, 400, 'SVG kan inneholde skript og er ikke tillatt');
    assert.equal((await up('image/png', Buffer.alloc(0))).status, 400);
  });

  it('avviser for store bilder (>10 MB)', async () => {
    const r = await up('image/png', Buffer.alloc(11 * 1024 * 1024));
    assert.equal(r.status, 413);
    assert.equal(srv.exited, false);
  });

  it('sti-triks mot /uploads og /audio gir ikke tilgang til andre filer', async () => {
    for (const p of ['/uploads/../board.json', '/uploads/%2e%2e/board.json', '/audio/..%2fstate.json', '/uploads/..%5cboard.json']) {
      const r = await fetch(srv.base + p);
      assert.notEqual(r.status, 200, p);
    }
  });

  it('lyd: gyldig plass og type godtas, ugyldig plass/type avvises, kan slettes', async () => {
    const put = (slot, type, body = Buffer.alloc(400, 1)) => fetch(`${srv.base}/api/audio/${slot}`, { method: 'POST', headers: { 'Content-Type': type, Cookie: ck }, body });
    assert.equal((await put('think', 'audio/wav')).status, 200);
    assert.equal((await put('evil', 'audio/wav')).status, 400);
    assert.equal((await put('..%2fx', 'audio/wav')).status, 400);
    assert.equal((await put('think', 'text/html')).status, 400);
    const a = await mkAdmin(srv);
    assert.match((await a.waitState(s => s.audio && s.audio.think)).audio.think, /^\/audio\/think\.wav/);
    assert.equal((await fetch(srv.base + '/api/audio/think', { method: 'DELETE', headers: { Cookie: ck } })).status, 200);
    await a.waitState(s => !s.audio.think); a.close();
  });

  it('ubrukte bilder ryddes bort ved lagring, brukte beholdes, nye (<10 min) beholdes', async () => {
    const mk = async () => (await (await up('image/png', PNG)).json()).name;
    const used = await mk(), stale = await mk(), fresh = await mk();
    const old = new Date(Date.now() - 3600 * 1000);
    for (const n of [used, stale]) fs.utimesSync(path.join(srv.dir, 'uploads', n), old, old);
    const b = board('B', [['A', [{ value: 100, q: 'q', a: 'a', img: used }]]]);
    assert.equal((await post(srv, '/api/board', { boards: [b] }, ck)).status, 200);
    const files = fs.readdirSync(path.join(srv.dir, 'uploads'));
    assert.ok(files.includes(used), 'brukt bilde beholdes');
    assert.ok(!files.includes(stale), 'gammelt ubrukt bilde slettes');
    assert.ok(files.includes(fresh), 'nylig opplastet bilde beholdes (kan tilhøre en kladd)');
  });
});

describe('XSS: bruker-tekst skal alltid escapes i nettleseren', () => {
  // Statisk sjekk: hvert ${…}-uttrykk i HTML-malene som inneholder brukertekst må gå gjennom esc()
  const USER_FIELDS = /\b(name|q|a|category|myName|iface)\b|\.url\b/;
  for (const file of ['admin.html', 'display.html', 'play.html']) {
    it(`${file}: brukerstyrte felt i innerHTML-maler bruker esc()`, () => {
      const src = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
      const offenders = [];
      for (const m of src.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
        const expr = m[1];
        if (!USER_FIELDS.test(expr)) continue;
        // uttrykk som kun bruker feltet i en betingelse eller som tall er ufarlige
        if (/esc\(/.test(expr) || /\.length|\? *'|\.score|\.value/.test(expr) && !/\bname\b.*[^c]\)/.test(expr)) continue;
        offenders.push(expr.trim().slice(0, 80));
      }
      assert.deepEqual(offenders, [], 'uten esc(): ' + offenders.join(' | '));
    });
  }
});

describe('korrupte og manglende datafiler', () => {
  it('korrupt board.json: brukerens fil bevares, sikkerhetskopien brukes, serveren starter', async () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jeopardy-corrupt-'));
    let srv = await startServer({ dir });
    const ck = await login(srv);
    await post(srv, '/api/board', { boards: [board('Alfa')] }, ck);
    await post(srv, '/api/board', { boards: [board('Beta')] }, ck); // .bak = Alfa
    await srv.stop();
    assert.ok(fs.existsSync(path.join(dir, 'board.json.bak')), 'sikkerhetskopi finnes');
    fs.writeFileSync(path.join(dir, 'board.json'), '{"boards":[{"name":"halv fil');
    srv = await startServer({ dir });
    const a = await mkAdmin(srv);
    assert.equal(a.state.rounds[0], 'Alfa', 'gjenopprettet fra .bak');
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('board.json.corrupt-')), 'den ødelagte filen er lagret, ikke slettet');
    a.close(); await srv.cleanup();
  });

  it('korrupt board.json uten sikkerhetskopi: standardbrett, men den ødelagte filen bevares', async () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jeopardy-corrupt2-'));
    fs.writeFileSync(path.join(dir, 'board.json'), 'søppel');
    const srv = await startServer({ dir });
    const a = await mkAdmin(srv);
    assert.ok(a.state.rounds.length >= 1);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('board.json.corrupt-')));
    a.close(); await srv.cleanup();
  });

  it('korrupt state.json: serveren starter med tom tilstand', async () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jeopardy-corrupt3-'));
    fs.writeFileSync(path.join(dir, 'state.json'), '{"players":{"a":{"id":');
    const srv = await startServer({ dir });
    const a = await mkAdmin(srv);
    assert.equal(a.state.players.length, 0); a.close(); await srv.cleanup();
  });

  it('state.json med rare verdier (feil typer) krasjer ikke serveren', async () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jeopardy-weird-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ players: { x: null, y: { id: 5 }, z: { id: 'ok', name: 'Z', score: 10 } }, usedAll: 'tekst', round: 'abc', chooser: 'finnes-ikke', settings: { buzzSecs: 'x' } }));
    const srv = await startServer({ dir });
    const a = await mkAdmin(srv);
    assert.ok(a.state.players.some(p => p.name === 'Z')); assert.equal(srv.exited, false); a.close(); await srv.cleanup();
  });
});
