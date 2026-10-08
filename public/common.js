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

async function loadJoin() { return (await fetch('/api/join')).json(); }
const imgTag = (n, cls = 'clue-img') => n ? `<img class="${cls}" src="/uploads/${esc(n)}" alt="">` : '';
