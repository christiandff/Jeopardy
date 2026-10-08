// Felles verktøy for testene: starter en isolert server (egen port + midlertidig datamappe)
// og tilbyr enkle WebSocket-klienter for admin, spillere og storskjerm.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'testpw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Poller til betingelsen er sann (eller kaster etter timeout)
async function until(fn, ms = 3000, what = 'betingelsen') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timeout (${ms} ms) mens vi ventet på ${what}`);
    await sleep(15);
  }
}

// Alle startede servere registreres, så de alltid stoppes når testprosessen avsluttes (også etter en feilet test)
const spawned = new Set();
process.on('exit', () => { for (const p of spawned) { try { p.kill('SIGKILL'); } catch { /* allerede borte */ } } });

async function startServer({ dir, port, env = {} } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-test-'));
  port = port || await freePort();
  const logs = [];
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, QUIET: '1', TEST_STATS: '1', DEFAULT_DOUBLES: '0', ADMIN_PASSWORD: PASSWORD, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.add(proc);
  proc.unref(); proc.stdout.unref(); proc.stderr.unref(); // barneprosessen skal ikke holde testen i live
  proc.stdout.on('data', d => logs.push(String(d)));
  proc.stderr.on('data', d => logs.push(String(d)));
  const srv = {
    dir, port, proc, logs,
    base: `http://127.0.0.1:${port}`,
    errors: () => logs.join('').split('\n').filter(l => /Uventet|Feil i|TypeError|ReferenceError|at .*server\.js/.test(l)),
    exited: false,
  };
  proc.on('exit', () => { srv.exited = true; });
  await until(async () => { try { return (await fetch(srv.base + '/api/me')).ok; } catch { return false; } }, 8000, 'at serveren starter');
  srv.stop = async () => { if (!srv.exited) { proc.kill(); await until(() => srv.exited, 3000, 'at serveren stopper').catch(() => {}); } };
  srv.kill = async () => { if (!srv.exited) { proc.kill('SIGKILL'); await until(() => srv.exited, 3000, 'at serveren dør').catch(() => {}); } };
  srv.cleanup = async () => { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return srv;
}

async function login(srv, password = PASSWORD) {
  const r = await fetch(srv.base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  if (!r.ok) return null;
  return r.headers.get('set-cookie').split(';')[0];
}

// WebSocket-klient som husker siste state og alle meldinger
class Client {
  constructor(srv, hello, { cookie } = {}) {
    this.srv = srv; this.hello = hello; this.cookie = cookie;
    this.state = null; this.types = []; this.joined = null; this.closed = false; this.times = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(`ws://127.0.0.1:${this.srv.port}/ws`, { headers: this.cookie ? { Cookie: this.cookie } : {} });
      ws.on('message', d => {
        const m = JSON.parse(d); this.types.push(m.type);
        if (m.type === 'state') { (this.sizes = this.sizes || []).push(d.length); this.state = m.state; this.times.push(Date.now()); this.seq = (this.seq || 0) + 1; }
        if (m.type === 'joined') this.joined = m;
        this.last = m;
      });
      ws.on('close', () => { this.closed = true; });
      ws.on('error', reject);
      ws.on('open', () => { this.send({ type: 'hello', ...this.hello }); resolve(this); });
    });
  }
  send(m) { if (this.ws.readyState === 1) this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  close() { this.ws.close(); }
  terminate() { this.ws.terminate(); }
  waitState(pred, ms = 3000, what = 'ønsket tilstand') { return until(() => this.state && pred(this.state) && this.state, ms, what); }
}

async function mkAdmin(srv) {
  const cookie = await login(srv);
  const c = new Client(srv, { role: 'admin' }, { cookie });
  await c.connect();
  await c.waitState(s => s.isAdmin, 3000, 'admin-state');
  c.act = (action, extra = {}) => c.send({ type: 'admin', action, ...extra });
  return c;
}
async function mkPlayer(srv, name, pid) {
  const c = new Client(srv, { role: 'player', name, pid });
  await c.connect();
  await until(() => c.joined || c.types.includes('nameTaken') || c.types.includes('needName'), 3000, 'join-svar');
  c.buzz = () => c.send({ type: 'player', action: 'buzz' });
  c.id = c.joined && c.joined.pid;
  return c;
}
async function mkDisplay(srv) {
  const c = new Client(srv, { role: 'display' });
  await c.connect();
  await c.waitState(() => true);
  return c;
}

module.exports = { startServer, login, mkAdmin, mkPlayer, mkDisplay, Client, until, sleep, PASSWORD, ROOT };
