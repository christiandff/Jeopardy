// Delt WebSocket-klient med automatisk gjenkobling og hjerteslag-vakt
function connect(hello, onMessage) {
  let ws, lastMsg = Date.now();
  const status = document.getElementById('conn');
  function open() {
    if (ws) { ws.onclose = ws.onmessage = ws.onopen = null; try { ws.close(); } catch {} }
    const sock = ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    lastMsg = Date.now();
    sock.onopen = () => { if (status) status.hidden = true; sock.send(JSON.stringify({ type: 'hello', ...hello() })); };
    sock.onmessage = e => {
      lastMsg = Date.now();
      const m = JSON.parse(e.data);
      if (m.type !== 'hb') onMessage(m);
    };
    sock.onclose = () => { if (status) status.hidden = false; setTimeout(() => { if (ws === sock) open(); }, 1000); };
  }
  open();
  // Serveren sender «hb» hvert 5. sekund. Stille i 15 s = døde forbindelsen uten å si fra (vanlig på mobilnett).
  setInterval(() => {
    if (Date.now() - lastMsg > 15000) { if (status) status.hidden = false; open(); }
  }, 3000);
  const wake = () => { if (!ws || ws.readyState > 1 || Date.now() - lastMsg > 15000) open(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  addEventListener('online', wake);
  return { send: m => ws && ws.readyState === 1 && ws.send(JSON.stringify(m)) };
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Skriver spørsmålet bokstav for bokstav i elementet som `sel` peker på. Klientene bygger siden på nytt ved hver state-melding,
// så fremdriften huskes per `key` og elementet slås opp på nytt for hvert tegn. `ready()` kan holde effekten igjen (f.eks. under flip).
const typer = { key: null, n: 0, timer: null };
function typeQ(sel, text, key, ready = () => true, ms = 35) {
  if (typer.key !== key) { typer.key = key; typer.n = 0; }
  clearInterval(typer.timer);
  const paint = () => {
    const el = document.querySelector(sel); if (!el) return;
    el.innerHTML = esc(text.slice(0, typer.n)) + `<span style="visibility:hidden">${esc(text.slice(typer.n))}</span>`; // skjult rest så teksten ikke hopper
  };
  paint();
  if (typer.n >= text.length || matchMedia('(prefers-reduced-motion: reduce)').matches) { typer.n = text.length; paint(); return; }
  typer.timer = setInterval(() => {
    if (!ready()) return;
    typer.n++; paint();
    if (typer.n >= text.length) clearInterval(typer.timer);
  }, ms);
}

async function loadJoin() { return (await fetch('/api/join')).json(); }
const imgTag = (n, cls = 'clue-img') => n ? `<img class="${cls}" src="/uploads/${esc(n)}" alt="">` : '';
