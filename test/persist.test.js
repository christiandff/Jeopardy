// Lagring til disk: spillet skal overleve at serveren dør midt i en runde.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, mkAdmin, mkPlayer, until, sleep } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-persist-'));
const validJson = f => { try { JSON.parse(fs.readFileSync(f, 'utf8')); return true; } catch { return false; } };

describe('lagring og gjenoppretting', () => {
  it('lag, poeng, brukte ruter, valgt brett og innstillinger overlever SIGKILL', async () => {
    const dir = tmp();
    let srv = await startServer({ dir });
    let admin = await mkAdmin(srv);
    const a = await mkPlayer(srv, 'Alfa'), b = await mkPlayer(srv, 'Beta');
    admin.act('setTimers', { buzzSecs: 7, answerSecs: 8, chooserFirst: true });
    admin.act('start'); await admin.waitState(s => s.started);
    admin.act('select', { c: 0, r: 0 }); await admin.waitState(s => s.current);
    admin.act('setTimers', { buzzSecs: 7, answerSecs: 8, chooserFirst: true });
    admin.act('open'); a.buzz(); await admin.waitState(s => s.current.answering === a.id);
    admin.act('correct'); await admin.waitState(s => s.current.phase === 'revealed');
    admin.act('close'); await admin.waitState(s => !s.current);
    await sleep(100);
    admin.act('flip'); await admin.waitState(s => s.round === 1);
    admin.act('select', { c: 1, r: 1 }); await admin.waitState(s => s.current);
    admin.act('close'); await admin.waitState(s => !s.current && s.used['1-1']);
    await sleep(700); // la lagringen (utsatt 300 ms) skrive til disk
    await srv.kill();

    srv = await startServer({ dir });
    admin = await mkAdmin(srv);
    const s = admin.state;
    assert.equal(s.started, true); assert.equal(s.round, 1);
    assert.deepEqual(Object.keys(s.used), ['1-1']);
    assert.equal(s.players.find(p => p.name === 'Alfa').score, 100);
    assert.equal(s.chooser, a.id);
    assert.deepEqual(s.settings, { buzzSecs: 7, answerSecs: 8, chooserFirst: true, mode: 'buzzer', penalty: true, doubles: 0 });
    assert.ok(s.players.every(p => p.connected === false), 'lagene er frakoblet til de kobler til igjen');
    admin.act('flip'); await admin.waitState(s => s.round === 0 && s.used['0-0'], 3000, 'brukt rute på brett 1 er husket');

    // telefonen kobler til igjen med lagret id og får samme lag og poeng
    const again = await mkPlayer(srv, '', a.id);
    assert.equal(again.id, a.id);
    await admin.waitState(s => s.players.find(p => p.id === a.id).connected);
    assert.equal(admin.state.players.find(p => p.id === a.id).score, 100);
    again.close(); admin.close(); await srv.cleanup();
  });

  it('aktivt spørsmål overlever ikke restart, men spillet er i orden (brett vises)', async () => {
    const dir = tmp();
    let srv = await startServer({ dir });
    let admin = await mkAdmin(srv);
    admin.act('start'); await admin.waitState(s => s.started);
    admin.act('select', { c: 2, r: 2 }); await admin.waitState(s => s.current);
    await sleep(700); await srv.kill();
    srv = await startServer({ dir }); admin = await mkAdmin(srv);
    assert.equal(admin.state.current, null); assert.equal(admin.state.started, true);
    assert.ok(!admin.state.used['2-2'], 'ruten som var åpen er ikke markert som brukt');
    admin.close(); await srv.cleanup();
  });

  it('SIGKILL midt i en lagringsstorm gir aldri en halv fil', async () => {
    const dir = tmp();
    for (let round = 0; round < 6; round++) {
      const srv = await startServer({ dir });
      const admin = await mkAdmin(srv);
      const p = await mkPlayer(srv, 'P' + round);
      const t0 = Date.now();
      // hold serveren opptatt med endringer (hver endring planlegger en lagring), og drep den midt i det
      const spam = setInterval(() => admin.act('adjust', { id: p.id, delta: 1 }), 30);
      await sleep(350 + round * 40);
      await srv.kill(); clearInterval(spam);
      for (const f of ['state.json', 'board.json']) {
        const full = path.join(dir, f);
        if (fs.existsSync(full)) assert.ok(validJson(full), `${f} er gyldig JSON etter SIGKILL (runde ${round})`);
      }
      admin.close(); p.close();
      assert.ok(Date.now() - t0 < 5000);
    }
    // og etter alt dette starter serveren fint
    const srv = await startServer({ dir }); const admin = await mkAdmin(srv);
    assert.ok(admin.state.rounds.length >= 1); admin.close(); await srv.cleanup();
  });

  it('nullstill alt tømmer også lagret tilstand', async () => {
    const dir = tmp();
    let srv = await startServer({ dir });
    let admin = await mkAdmin(srv);
    const a = await mkPlayer(srv, 'Alfa');
    admin.act('start'); admin.act('adjust', { id: a.id, delta: 500 });
    await admin.waitState(s => s.players[0].score === 500); await sleep(100);
    admin.act('resetAll'); await admin.waitState(s => !s.started && s.players[0].score === 0);
    await sleep(700); await srv.kill();
    srv = await startServer({ dir }); admin = await mkAdmin(srv);
    assert.equal(admin.state.started, false); assert.equal(admin.state.players[0].score, 0);
    admin.close(); await srv.cleanup();
  });
});
