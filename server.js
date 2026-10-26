const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const QUIET = !!process.env.QUIET;
// Antall «dobbel poengsum»-ruter per brett (0–5). Kan endres i admin; env brukes bl.a. av testene.
// Ventetid før buzzerne åpnes automatisk etter at en rute er valgt (tilsvarer zoom + flip på storskjermen). 0 = av.
const AUTO_OPEN_MS = process.env.AUTO_OPEN_MS !== undefined && Number.isFinite(Number(process.env.AUTO_OPEN_MS))
  ? Math.max(0, Number(process.env.AUTO_OPEN_MS)) : 2700;
const DEFAULT_DOUBLES = process.env.DEFAULT_DOUBLES !== undefined && Number.isFinite(Number(process.env.DEFAULT_DOUBLES))
  ? Math.max(0, Math.min(5, Math.round(Number(process.env.DEFAULT_DOUBLES)))) : 2;
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
const AUDIO_TYPES = { 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a' };
const AUDIO_SLOTS = ['lobby', 'think'];
let audioInfo = {};
function refreshAudio() {
  audioInfo = {};
  for (const slot of AUDIO_SLOTS) {
    const f = fs.readdirSync(AUDIO_DIR).find(n => n.startsWith(slot + '.'));
    if (f) audioInfo[slot] = `/audio/${f}?v=${Math.round(fs.statSync(path.join(AUDIO_DIR, f)).mtimeMs)}`;
  }
}
refreshAudio();
const IMG_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

// Skriv til midlertidig fil og gi den nytt navn, så en krasj midt i skrivingen aldri gir en halv fil
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---------- Board ----------
const DEFAULT_ROUND_2 = [
  ['Historie', [
    ['Året andre verdenskrig sluttet i Europa', '1945'], ['Faraoen med den gylne dødsmasken', 'Tutankhamon'],
    ['Romerrikets første keiser', 'Augustus'], ['Landet Leif Eriksson kalte «Vinland» ligger i', 'Canada'],
    ['Året Berlinmuren falt', '1989']]],
  ['Dyr', [
    ['Verdens største landdyr', 'Afrikansk elefant'], ['Antall bein på en edderkopp', '8'],
    ['Pattedyret som sover opp ned og bruker ekkolodd', 'Flaggermus'], ['Verdens raskeste landdyr', 'Gepard'],
    ['Pattedyret som legger egg (australsk)', 'Nebbdyr']]],
  ['Musikk', [
    ['Bandet bak «Dancing Queen»', 'ABBA'], ['Instrumentet med svarte og hvite tangenter', 'Piano'],
    ['Antall strenger på en vanlig gitar', '6'], ['Komponisten av «Peer Gynt»', 'Edvard Grieg'],
    ['Artisten bak «Thriller»', 'Michael Jackson']]],
  ['Sport', [
    ['Antall spillere per lag på banen i fotball', '11'], ['Sporten som spilles i Wimbledon', 'Tennis'],
    ['Antall ringer i OL-symbolet', '5'], ['Byen som arrangerte vinter-OL i 1994', 'Lillehammer'],
    ['Sporten med racket og fjærball', 'Badminton']]],
  ['Teknologi', [
    ['«WWW» står for', 'World Wide Web'], ['Selskapet bak iPhone', 'Apple'],
    ['«USB» står for', 'Universal Serial Bus'], ['Programmeringsspråket oppkalt etter en slange', 'Python'],
    ['Året første iPhone ble lansert', '2007']]],
];

function defaultBoard(round = 0) {
  const v = [100, 200, 300, 400, 500].map(x => x * (round + 1));
  const cats = round ? DEFAULT_ROUND_2 : [
    ['Geografi', [
      ['Norges hovedstad', 'Oslo'], ['Verdens lengste elv (ofte oppgitt)', 'Nilen'],
      ['Landet med byen Timbuktu', 'Mali'], ['Hovedstaden i Australia', 'Canberra'],
      ['Det eneste kontinentet uten permanent befolkning', 'Antarktis']]],
    ['Mat & drikke', [
      ['Hovedingrediensen i guacamole', 'Avokado'], ['Italiensk ost som ofte brukes på pizza', 'Mozzarella'],
      ['Japansk risrett med rå fisk', 'Sushi'], ['Krydderet som er verdens dyreste', 'Safran'],
      ['Drikken som lages av fermentert te', 'Kombucha']]],
    ['Film', [
      ['Filmen med fisken Nemo — hva heter studioet?', 'Pixar'], ['Han spiller Jack i Titanic', 'Leonardo DiCaprio'],
      ['Navnet på trollmannsskolen i Harry Potter', 'Galtvort / Hogwarts'], ['Regissøren bak «Pulp Fiction»', 'Quentin Tarantino'],
      ['Han regisserte «Jurassic Park»', 'Steven Spielberg']]],
    ['Vitenskap', [
      ['Planeten nærmest solen', 'Merkur'], ['Kjemisk symbol for gull', 'Au'],
      ['Antall bein i en voksen menneskekropp', '206'], ['Hastigheten til lys (km/s, ca.)', '300 000'],
      ['Han formulerte relativitetsteorien', 'Albert Einstein']]],
    ['Norge', [
      ['Norges nasjonaldag', '17. mai'], ['Norges lengste elv', 'Glomma'],
      ['Norges høyeste fjell', 'Galdhøpiggen'], ['Kongen som ble valgt i 1905', 'Haakon VII'],
      ['Byen som kalles «Regnbyen»', 'Bergen']]],
  ];
  return {
    name: `Brett ${round + 1}`,
    categories: cats.map(([name, clues]) => ({
      name,
      clues: clues.map(([q, a], i) => ({ value: v[i], q, a })),
    })),
  };
}

function readBoardsFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw.boards) && raw.boards.length) return raw.boards;
  if (Array.isArray(raw.categories)) return [{ name: 'Brett 1', categories: raw.categories }, defaultBoard(1)]; // gammelt format
  throw new Error('ukjent brettformat');
}
function loadBoards() {
  let boards;
  if (fs.existsSync(BOARD_FILE)) {
    try { boards = readBoardsFile(BOARD_FILE); }
    catch (err) {
      // Aldri skriv standardbrett over en fil vi ikke klarte å lese: ta vare på den og prøv sikkerhetskopien
      const saved = BOARD_FILE + '.corrupt-' + Date.now();
      try { fs.renameSync(BOARD_FILE, saved); } catch { /* ignorer */ }
      console.error(`\n  ADVARSEL: board.json kunne ikke leses (${err.message}). Filen er lagret som ${path.basename(saved)}.`);
      try { boards = readBoardsFile(BOARD_FILE + '.bak'); console.error('  Bruker sikkerhetskopien board.json.bak.\n'); }
      catch { console.error('  Fant ingen brukbar sikkerhetskopi – bruker standardbrett.\n'); }
    }
  }
  if (!boards) boards = [defaultBoard(0), defaultBoard(1)];
  saveBoards(boards);
  return boards;
}
function saveBoards(b) {
  fs.mkdirSync(path.dirname(BOARD_FILE), { recursive: true });
  try { if (fs.existsSync(BOARD_FILE)) fs.copyFileSync(BOARD_FILE, BOARD_FILE + '.bak'); } catch { /* backup er best effort */ }
  writeFileAtomic(BOARD_FILE, JSON.stringify({ boards: b }, null, 2));
}


// ---------- Game state ----------
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ADMIN_TOKEN_TTL = 24 * 3600 * 1000;
let boards = loadBoards();
const game = {
  players: Object.create(null), // id -> {id,name,score,connected} (uten prototype: «__proto__» som id er ufarlig)
  round: 0,         // hvilket brett som spilles
  used: {},         // "c-r" -> true (for gjeldende brett)
  usedAll: {},      // round -> used-map (lagres når man bytter brett)
  started: false,   // false = lobby/hovedmeny
  current: null,    // {c,r,phase,answering,lockedOut[],deadline}
  chooser: null,    // player id that picks next clue
  settings: { buzzSecs: 15, answerSecs: 10, chooserFirst: false, mode: 'buzzer', penalty: true, doubles: DEFAULT_DOUBLES },
  doubles: {},      // round -> ["c-r", …] hvilke ruter som er dobbel poengsum (skjult for spillerne)
  event: { seq: 0, type: null },   // brukes av storskjermen til lyder
  timer: null,
};
const sockets = new Map(); // ws -> {role, pid}
const adminTokens = new Map(); // token -> expiry

// ----- Lagring til disk -----
// En skadet eller håndredigert state.json skal aldri gi stille feil: alt valideres, og ugyldige verdier får standard.
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
function cleanUsed(u) {
  const out = {};
  if (isObj(u)) for (const [k, v] of Object.entries(u)) if (/^\d+-\d+$/.test(k) && v === true) out[k] = true;
  return out;
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!isObj(s)) return;
    for (const p of Object.values(isObj(s.players) ? s.players : {})) {
      if (!isObj(p) || typeof p.id !== 'string' || !p.id) continue;
      const score = Number(p.score);
      game.players[p.id] = { id: p.id, name: String(p.name ?? 'Lag').slice(0, 20) || 'Lag', score: Number.isFinite(score) ? score : 0, connected: false };
    }
    game.usedAll = {};
    if (isObj(s.usedAll)) for (const [k, v] of Object.entries(s.usedAll)) if (/^\d+$/.test(k)) game.usedAll[k] = cleanUsed(v);
    const rd = Number(s.round);
    game.round = Number.isInteger(rd) && rd >= 0 ? Math.min(rd, boards.length - 1) : 0;
    game.used = game.usedAll[game.round] || {};
    game.started = s.started === true;
    game.chooser = typeof s.chooser === 'string' && game.players[s.chooser] ? s.chooser : null;
    const st = isObj(s.settings) ? s.settings : {};
    const secsOr = (v, d) => (v !== null && v !== '' && Number.isFinite(Number(v))) ? Math.max(0, Math.min(120, Math.round(Number(v)))) : d;
    const dbl = Number(st.doubles);
    game.settings = { buzzSecs: secsOr(st.buzzSecs, 15), answerSecs: secsOr(st.answerSecs, 10), chooserFirst: st.chooserFirst === true, mode: st.mode === 'turns' || st.mode === 'pick' ? 'turns' : 'buzzer', penalty: st.penalty !== false,
      doubles: st.doubles !== null && st.doubles !== '' && Number.isFinite(dbl) ? Math.max(0, Math.min(5, Math.round(dbl))) : DEFAULT_DOUBLES };
    game.doubles = {};
    if (isObj(s.doubles)) for (const [k, v] of Object.entries(s.doubles)) {
      if (!/^\d+$/.test(k) || !boards[k] || !Array.isArray(v)) continue;
      game.doubles[k] = v.filter(x => typeof x === 'string' && /^\d+-\d+$/.test(x) && boards[k].categories[x.split('-')[0]]?.clues?.[x.split('-')[1]]).slice(0, 5);
    }
  } catch { /* ingen tidligere tilstand */ }
}
let saveTimer = null;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { players, started, chooser, settings, round, doubles } = game;
    const usedAll = { ...game.usedAll, [round]: game.used };
    try { writeFileAtomic(STATE_FILE, JSON.stringify({ players, usedAll, round, started, chooser, settings, doubles })); }
    catch (err) { console.error('Kunne ikke lagre spilltilstand:', err.message); }
  }, 300);
}
loadState();

const curBoard = () => boards[Math.min(game.round, boards.length - 1)];
const clueAt = (c, r) => curBoard().categories[c]?.clues?.[r];
// Velger tilfeldige ruter (ikke øverste rad hvis brettet har nok rader, og ikke ruter som allerede er brukt)
function ensureDoubles(round) {
  if (Array.isArray(game.doubles[round])) return;
  const b = boards[round]; if (!b) return;
  const used = round === game.round ? game.used : (game.usedAll[round] || {});
  const rows = Math.max(...b.categories.map(c => c.clues.length));
  let cells = [];
  b.categories.forEach((cat, c) => cat.clues.forEach((_, r) => { if (!used[`${c}-${r}`] && (rows < 3 || r >= 1)) cells.push(`${c}-${r}`); }));
  for (let i = cells.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  game.doubles[round] = cells.slice(0, game.settings.doubles);
}
const clueValue = cur => clueAt(cur.c, cur.r).value * (cur.double ? 2 : 1);
const emit = type => { game.event = { seq: game.event.seq + 1, type }; };

// ----- Timer -----
function clearTimer() {
  clearTimeout(game.timer); game.timer = null;
  if (game.current) game.current.deadline = null;
}
function startTimer(secs, onExpire) {
  clearTimeout(game.timer);
  const cur = game.current;
  if (!cur || !(secs > 0)) { if (cur) cur.deadline = null; return; }
  cur.deadline = Date.now() + secs * 1000;
  cur.timerTotal = secs;
  game.timer = setTimeout(() => {
    game.timer = null;
    if (game.current === cur) { onExpire(); broadcast(); }
  }, secs * 1000 + 50);
}
// Alle veier til «svar vist» går hit: stopper timer og musikk (ellers spilte sangen videre etter at tiden var ute)
function revealClue(cur) {
  clearTimer();
  cur.phase = 'revealed'; cur.answering = null; cur.deadline = null; cur.media.playing = false;
}
function openBuzzers() {
  const cur = game.current;
  cur.phase = 'open'; cur.answering = null; cur.first = false;
  startTimer(game.settings.buzzSecs, () => { revealClue(cur); emit('timeout'); });
}
// Storskjermen har vist ruten ferdig: spørsmålet slippes til spillerne og buzzerne åpnes
function showClue(cur) {
  if (!cur.pending) return;
  cur.pending = false;
  if (game.settings.mode === 'buzzer' && cur.phase === 'read' && !clueAt(cur.c, cur.r).yt) openBuzzers();
}
// Musikken startes: buzzerne åpnes samtidig (og spørsmålet slippes til spillerne hvis det ennå ikke er vist)
function openWithMusic(cur) {
  cur.pending = false;
  if (game.settings.mode === 'buzzer' && cur.phase === 'read') openBuzzers();
}
function markWrong(type = 'wrong') {
  const cur = game.current;
  const p = game.players[cur.answering];
  if (p && game.settings.penalty) p.score -= Math.round(clueValue(cur) / 2); // feil svar koster halv verdi (kan skrus av)
  cur.lockedOut.push(cur.answering);
  cur.answering = null;
  emit(type);
  const remaining = Object.values(game.players).filter(x => x.connected && !cur.lockedOut.includes(x.id));
  if (remaining.length) openBuzzers();
  else revealClue(cur);
}

function publicState() {
  const cur = game.current;
  const clue = cur && clueAt(cur.c, cur.r);
  return {
    serverNow: Date.now(),
    audio: audioInfo,
    event: game.event,
    round: game.round,
    rounds: boards.map(b => b.name),
    roundDone: curBoard().categories.every((cat, c) => cat.clues.every((_, r) => game.used[`${c}-${r}`])),
    board: curBoard().categories.map(cat => ({
      name: cat.name,
      clues: cat.clues.map(cl => ({ value: cl.value })),
    })),
    used: game.used,
    started: game.started,
    players: Object.values(game.players).map(p => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
    })),
    chooser: game.chooser,
    settings: { mode: game.settings.mode, penalty: game.settings.penalty, chooserFirst: game.settings.chooserFirst }, // vises i «Slik spiller du»
    current: cur && {
      c: cur.c, r: cur.r, phase: cur.phase, answering: cur.answering,
      lockedOut: cur.lockedOut, first: !!cur.first, value: clueValue(cur), double: !!cur.double, deadline: cur.deadline, timerTotal: cur.timerTotal,
      category: curBoard().categories[cur.c].name,
      pending: !!cur.pending, // storskjermen har ikke vist ruten ferdig ennå: spørsmålet holdes igjen fra spillerne
      q: cur.pending ? undefined : clue.q,
      hasYt: !cur.pending && !!clue.yt,
      media: cur.media,
      img: cur.pending ? undefined : clue.img || undefined,
      aImg: cur.phase === 'revealed' ? clue.aImg || undefined : undefined,
      a: cur.phase === 'revealed' ? clue.a : undefined,
    },
  };
}
// Storskjermen får video-ID (spillerne får den ikke, så de ikke kan slå opp sangen)
function displayState() {
  const s = publicState();
  if (game.current) { const cl = clueAt(game.current.c, game.current.r); Object.assign(s.current, { q: cl.q, hasYt: !!cl.yt, img: cl.img || undefined, yt: ytInfo(cl) }); }
  return s;
}
function adminState() {
  const s = publicState();
  s.isAdmin = true;
  s.settings = game.settings;
  s.doubles = game.doubles[game.round] || []; // kun admin ser hvor de ligger
  if (game.current) {
    const cl = clueAt(game.current.c, game.current.r);
    s.current.a = cl.a; s.current.aImg = cl.aImg || undefined; s.current.yt = ytInfo(cl);
    s.current.q = cl.q; s.current.hasYt = !!cl.yt; s.current.img = cl.img || undefined;
  }
  s.fullBoard = { boards };
  return s;
}

function broadcast() {
  let pub, adm, dsp; // bygges først når en tilkobling med den rollen finnes (adminState er størst)
  for (const [ws, info] of sockets) {
    if (ws.readyState !== 1) continue;
    if (info.role === 'admin') ws.send(adm ??= JSON.stringify({ type: 'state', state: adminState() }));
    else if (info.role === 'display') ws.send(dsp ??= JSON.stringify({ type: 'state', state: displayState() }));
    else ws.send(pub ??= JSON.stringify({ type: 'state', state: publicState() }));
  }
  saveStateSoon();
}

// Neste tilkoblede lag etter `afterId` i spillerrekkefølgen (null hvis ingen er tilkoblet)
function nextTurn(afterId) {
  const list = Object.values(game.players);
  const i = list.findIndex(p => p.id === afterId);
  for (let k = 1; k <= list.length; k++) {
    const p = list[(i + k + list.length) % list.length];
    if (p.connected) return p;
  }
  return null;
}
function endClue() {
  clearTimer();
  if (game.settings.mode === 'turns' && game.current?.turn) { const n = nextTurn(game.current.turn); if (n) game.chooser = n.id; }
  if (game.current) game.used[`${game.current.c}-${game.current.r}`] = true;
  game.current = null;
}

// Tall fra klienten: bare ekte tall eller tallstrenger (Number(null) og Number([]) gir ellers 0)
const toInt = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;

function handleAdmin(msg) {
  const cur = game.current;
  switch (msg.action) {
    case 'start': game.started = true; ensureDoubles(game.round); break;
    case 'lobby': if (!cur) game.started = false; break;
    case 'select': {
      const c = toInt(msg.c), r = toInt(msg.r);
      if (!Number.isInteger(c) || !Number.isInteger(r)) return;
      if (!game.started || cur || game.used[`${c}-${r}`] || !clueAt(c, r)) return;
      ensureDoubles(game.round);
      game.current = { c, r, phase: 'read', answering: null, lockedOut: [], deadline: null, first: false, media: { playing: false, nonce: 0, error: null, status: null } };
      game.current.double = game.doubles[game.round].includes(`${c}-${r}`);
      if (game.current.double) emit('double');
      // Laget som valgte ruten får første sjanse til å svare, uten å buzze
      if (game.settings.mode === 'buzzer' && game.settings.chooserFirst && game.chooser && game.players[game.chooser]?.connected) {
        game.current.phase = 'answering'; game.current.answering = game.chooser; game.current.first = true;
      }
      // Tur for tur: laget som har tur svarer uten å buzze. Svartimeren starter når storskjermen er ferdig med zoom og flip.
      if (game.settings.mode === 'turns') {
        const ch = game.players[game.chooser];
        const turn = ch?.connected ? ch : nextTurn(game.chooser);
        if (turn) {
          const sel = game.current;
          game.chooser = turn.id; sel.turn = turn.id; sel.phase = 'answering'; sel.answering = turn.id; sel.first = true;
          if (!clueAt(c, r).yt) setTimeout(() => {
            if (game.current === sel && sel.phase === 'answering' && sel.answering === turn.id) {
              startTimer(game.settings.answerSecs, () => markWrong('timeout')); broadcast();
            }
          }, AUTO_OPEN_MS).unref();
        }
      }
      // Spillerne får ikke spørsmålet før storskjermen er ferdig med zoom og flip (melder «flipDone»).
      // Buzzerne åpnes samtidig (ikke for YouTube-ruter, der admin starter musikken). Reservetimer hvis ingen storskjerm er koblet til.
      if (AUTO_OPEN_MS > 0) {
        const sel = game.current;
        sel.pending = true;
        setTimeout(() => { if (game.current === sel && sel.pending) { showClue(sel); broadcast(); } }, AUTO_OPEN_MS + 1500).unref();
      }
      break;
    }
    case 'open':
      if (cur && (cur.phase === 'read' || cur.phase === 'answering')) openBuzzers();
      break;
    case 'mediaPlay':
      if (cur && clueAt(cur.c, cur.r).yt) { cur.media.playing = true; cur.media.error = null; openWithMusic(cur); }
      break;
    case 'mediaPause':
      if (cur) cur.media.playing = false;
      break;
    case 'mediaRestart':
      if (cur && clueAt(cur.c, cur.r).yt) { cur.media.nonce++; cur.media.playing = true; cur.media.error = null; openWithMusic(cur); }
      break;
    case 'correct': {
      // «who» = laget admin så svare. Har noen andre overtatt i mellomtiden, ignoreres kommandoen (ingen feil poeng).
      if (!cur || !cur.answering || (msg.who && msg.who !== cur.answering)) return;
      const p = game.players[cur.answering];
      if (p) { p.score += clueValue(cur); if (game.settings.mode !== 'turns') game.chooser = p.id; }
      emit('correct'); revealClue(cur);
      break;
    }
    case 'wrong':
      if (!cur || !cur.answering || (msg.who && msg.who !== cur.answering)) return;
      markWrong();
      break;
    case 'reveal':
      if (cur) revealClue(cur);
      break;
    case 'close': endClue(); break;
    case 'adjust': {
      const p = typeof msg.id === 'string' ? game.players[msg.id] : null;
      const d = Number(msg.delta);
      if (p && Number.isFinite(d)) p.score += Math.max(-100000, Math.min(100000, d));
      break;
    }
    case 'setChooser': game.chooser = typeof msg.id === 'string' && game.players[msg.id] ? msg.id : null; break;
    case 'setTimers': {
      const clamp = v => Math.max(0, Math.min(120, Math.round(Number(v) || 0)));
      const before = game.settings.doubles;
      const dbl = msg.doubles === undefined || msg.doubles === null || msg.doubles === '' ? NaN : Number(msg.doubles);
      const doubles = Number.isFinite(dbl) ? Math.max(0, Math.min(5, Math.round(dbl))) : before;
      game.settings = { buzzSecs: clamp(msg.buzzSecs), answerSecs: clamp(msg.answerSecs), chooserFirst: !!msg.chooserFirst, doubles,
        mode: msg.mode === 'turns' || msg.mode === 'buzzer' ? msg.mode : game.settings.mode,
        penalty: typeof msg.penalty === 'boolean' ? msg.penalty : game.settings.penalty };
      if (doubles !== before) { delete game.doubles[game.round]; if (game.started) ensureDoubles(game.round); } // ny plassering (ikke på brukte ruter)
      break;
    }
    case 'kick':
      delete game.players[msg.id];
      if (game.chooser === msg.id) game.chooser = null;
      if (cur) {
        cur.lockedOut = cur.lockedOut.filter(x => x !== msg.id);
        if (cur.answering === msg.id) openBuzzers();
      }
      for (const [ws, info] of sockets) if (info.pid === msg.id) { ws.send(JSON.stringify({ type: 'kicked' })); }
      break;
    case 'flip':
    case 'setRound': {
      // «flip» går til neste brett (og rundt til første etter siste)
      const n = msg.action === 'flip' ? (game.round + 1) % boards.length : toInt(msg.round);
      if (cur || !Number.isInteger(n) || !boards[n] || n === game.round) return;
      game.usedAll[game.round] = game.used;
      game.round = n; game.used = game.usedAll[n] || {};
      if (game.started) ensureDoubles(n);
      break;
    }
    case 'resetBoard': clearTimer(); game.used = {}; game.current = null; delete game.doubles[game.round]; if (game.started) ensureDoubles(game.round); break;
    case 'resetAll': clearTimer(); game.used = {}; game.usedAll = {}; game.doubles = {}; game.round = 0; game.current = null; game.chooser = null; game.started = false;
      for (const p of Object.values(game.players)) p.score = 0; break;
  }
}

function handlePlayer(info, msg) {
  if (msg.action === 'buzz') {
    const cur = game.current;
    const p = game.players[info.pid];
    if (!cur || !p || cur.phase !== 'open' || cur.lockedOut.includes(p.id)) return;
    cur.answering = p.id; cur.phase = 'answering'; cur.media.playing = false; // musikken pauses når noen buzzer
    emit('buzz');
    startTimer(game.settings.answerSecs, () => markWrong('timeout'));
  }
}

// ---------- Nettverk ----------
const VIRTUAL_IFACE = /vEthernet|WSL|VMware|VirtualBox|Hyper-V|Loopback|Bluetooth|docker|vbox/i;
function candidates() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
        out.push({ iface: name, ip: i.address, virtual: VIRTUAL_IFACE.test(name) });
  const rank = c => (c.virtual ? 10 : 0) + (c.ip.startsWith('192.168.') ? 0 : c.ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}
function joinUrl(req) {
  if (process.env.JOIN_URL) return process.env.JOIN_URL;
  const host = (req?.headers.host || '').replace(/:\d+$/, '');
  if (host && !/^(localhost|127\.|\[::1\])/.test(host)) return `http://${req.headers.host}/play`;
  return `http://${candidates()[0]?.ip || 'localhost'}:${PORT}/play`;
}

// ---------- HTTP ----------
const app = express();
if (!QUIET) app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => console.log(`  ${new Date().toLocaleTimeString('no')} ${req.socket.remoteAddress} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - t}ms`));
  next();
});
app.use(express.json({ limit: '2mb' }));

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function isAdminReq(req) {
  const t = parseCookies(req).admin;
  const exp = adminTokens.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(t); return false; }
  return true;
}

// Maks 5 feil passord per minutt per IP-adresse (vinduet kan kortes ned med LOGIN_WINDOW_MS, brukes i tester)
const LOGIN_WINDOW = Number(process.env.LOGIN_WINDOW_MS) || 60000;
const loginFails = new Map(); // ip -> { n, until }
setInterval(() => { const t = Date.now(); for (const [ip, f] of loginFails) if (f.until < t) loginFails.delete(ip); }, 60000).unref();

app.post('/api/login', (req, res) => {
  const ip = req.socket.remoteAddress;
  const rec = loginFails.get(ip);
  if (rec && rec.until > Date.now() && rec.n >= 5) return res.status(429).json({ error: 'For mange forsøk. Vent litt og prøv igjen.' });
  const given = Buffer.from(String(req.body?.password || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) {
    const fresh = !rec || rec.until <= Date.now();
    loginFails.set(ip, { n: fresh ? 1 : rec.n + 1, until: fresh ? Date.now() + LOGIN_WINDOW : rec.until });
    return res.status(401).json({ error: 'Feil passord' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL);
  res.setHeader('Set-Cookie', `admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_TOKEN_TTL / 1000}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  adminTokens.delete(parseCookies(req).admin);
  res.setHeader('Set-Cookie', 'admin=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ admin: isAdminReq(req) }));

const IMG_NAME = /^[\w-]+\.(png|jpg|gif|webp)$/;

// Henter YouTube-video-ID fra lenke (watch, youtu.be, embed, shorts, music.youtube.com) eller ren ID.
// Gir '' for tomt og null for ugyldig.
function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else { const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/); if (m) id = m[2]; }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
const secs = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 36000) : 0; };
const ytInfo = cl => cl && cl.yt ? { id: cl.yt, start: secs(cl.ytStart), end: secs(cl.ytEnd), hide: !!cl.ytHide } : undefined;
function validateBoard(b, prefix = '') {
  const errs = [];
  if (!b || !Array.isArray(b.categories) || !b.categories.length) return [`${prefix}Brettet må ha minst én kategori`];
  const names = new Set();
  b.categories.forEach((c, ci) => {
    const nm = String(c?.name ?? '').trim();
    const label = prefix + (nm || `Kategori ${ci + 1}`);
    if (!nm) errs.push(`${prefix}Kategori ${ci + 1} mangler navn`);
    else if (names.has(nm.toLowerCase())) errs.push(`${prefix}Kategorinavnet «${nm}» er brukt flere ganger`);
    names.add(nm.toLowerCase());
    if (!Array.isArray(c?.clues) || !c.clues.length) return errs.push(`${label} har ingen ruter`);
    c.clues.forEach((k, ki) => {
      const where = `${label}, rute ${ki + 1}`;
      for (const f of ['img', 'aImg'])
        if (k[f] && !IMG_NAME.test(k[f])) errs.push(`${where}: ugyldig bildenavn`);
      if (!(Number(k.value) > 0)) errs.push(`${where}: poeng må være over 0`);
      if (k.yt && parseYouTubeId(k.yt) === null) errs.push(`${where}: ugyldig YouTube-lenke`);
      if (secs(k.ytEnd) && secs(k.ytEnd) <= secs(k.ytStart)) errs.push(`${where}: slutt-tid må være etter start-tid`);
      if (!String(k.q || '').trim() && !k.img && !k.yt) errs.push(`${where}: mangler spørsmål`);
      if (!String(k.a || '').trim() && !k.aImg) errs.push(`${where}: mangler svar`);
    });
  });
  return errs;
}
function validateBoards(list) {
  if (!Array.isArray(list) || !list.length || list.length > 6) return ['Du må ha mellom 1 og 6 brett'];
  return list.flatMap((b, i) => validateBoard(b, list.length > 1 ? `${String(b?.name || '').trim() || 'Brett ' + (i + 1)}: ` : ''));
}
function cleanupUploads() {
  const used = new Set(boards.flatMap(b => b.categories.flatMap(c => c.clues.flatMap(k => [k.img, k.aImg]))).filter(Boolean));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const full = path.join(UPLOAD_DIR, f);
    // behold nylig opplastede filer (kan tilhøre en kladd som ikke er lagret ennå)
    if (!used.has(f) && Date.now() - fs.statSync(full).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(full);
  }
}

app.post('/api/board', (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Ikke innlogget' });
  // Godtar {boards:[...]} eller enkeltbrett {categories:[...]} (eldre eksportfiler)
  const list = Array.isArray(req.body?.boards) ? req.body.boards : req.body?.categories ? [{ name: 'Brett 1', categories: req.body.categories }] : null;
  const errs = validateBoards(list);
  if (errs.length) return res.status(400).json({ error: errs.slice(0, 6).join('\n') + (errs.length > 6 ? `\n…og ${errs.length - 6} til` : '') });
  boards = list.map((b, i) => ({
    name: String(b.name || '').trim() || `Brett ${i + 1}`,
    categories: b.categories.map(c => ({
      name: c.name.trim(),
      clues: c.clues.map(k => ({
        value: Number(k.value), q: String(k.q || ''), a: String(k.a || ''), img: k.img || '', aImg: k.aImg || '',
        yt: parseYouTubeId(k.yt) || '', ytStart: secs(k.ytStart), ytEnd: secs(k.ytEnd), ytHide: !!k.ytHide,
      })),
    })),
  }));
  saveBoards(boards);
  cleanupUploads();
  clearTimer(); game.used = {}; game.usedAll = {}; game.doubles = {}; game.round = 0; game.current = null;
  broadcast();
  res.json({ ok: true });
});

app.post('/api/upload', express.raw({ type: Object.keys(IMG_TYPES), limit: '10mb' }), (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Ikke innlogget' });
  const ext = IMG_TYPES[req.headers['content-type']];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Ugyldig bildefil' });
  const name = crypto.randomBytes(8).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ name });
});
// Kun for lasttesting (settes ikke i vanlig bruk): minne, CPU og antall tilkoblinger
if (process.env.TEST_STATS) app.get('/__stats', (req, res) => res.json({ mem: process.memoryUsage(), cpu: process.cpuUsage(), sockets: sockets.size, uptime: process.uptime() }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/audio', express.static(AUDIO_DIR));

app.post('/api/audio/:slot', express.raw({ type: Object.keys(AUDIO_TYPES), limit: '25mb' }), (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Ikke innlogget' });
  const ext = AUDIO_TYPES[req.headers['content-type']];
  if (!AUDIO_SLOTS.includes(req.params.slot) || !ext || !Buffer.isBuffer(req.body) || !req.body.length)
    return res.status(400).json({ error: 'Ugyldig lydfil (mp3, ogg, wav eller m4a, maks 25 MB)' });
  for (const n of fs.readdirSync(AUDIO_DIR)) if (n.startsWith(req.params.slot + '.')) fs.unlinkSync(path.join(AUDIO_DIR, n));
  fs.writeFileSync(path.join(AUDIO_DIR, req.params.slot + ext), req.body);
  refreshAudio(); broadcast();
  res.json({ ok: true });
});
app.delete('/api/audio/:slot', (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Ikke innlogget' });
  if (!AUDIO_SLOTS.includes(req.params.slot)) return res.status(400).json({ error: 'Ugyldig' });
  for (const n of fs.readdirSync(AUDIO_DIR)) if (n.startsWith(req.params.slot + '.')) fs.unlinkSync(path.join(AUDIO_DIR, n));
  refreshAudio(); broadcast();
  res.json({ ok: true });
});

app.get('/api/join', async (req, res) => {
  try {
    const url = joinUrl(req);
    res.json({ url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } }) });
  } catch (err) {
    console.error('Kunne ikke lage QR-kode:', err.message);
    res.status(500).json({ error: 'Kunne ikke lage QR-kode' });
  }
});
app.get('/api/diag', (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Ikke innlogget' });
  res.json({ port: PORT, candidates: candidates().map(c => ({ ...c, url: `http://${c.ip}:${PORT}/play` })), current: joinUrl(req) });
});

app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/play', (_, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/display', (_, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/', (_, res) => res.redirect('/play'));
app.use(express.static(path.join(__dirname, 'public')));

// Feil (f.eks. ugyldig JSON eller for stor fil) skal gi JSON-svar, ikke en HTML-feilside
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error('Feil i HTTP-forespørsel:', err);
  res.status(status).json({ error: status === 413 ? 'Filen er for stor' : status === 500 ? 'Intern feil' : 'Ugyldig forespørsel' });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 10 * 1024 });

const YT_STATUSES = new Set(['ready', 'notready', 'cued', 'unstarted', 'buffering', 'playing', 'paused', 'ended', 'soundoff', 'blocked']);

wss.on('connection', (ws, req) => {
  const info = { role: 'viewer', pid: null, stamps: [] };
  sockets.set(ws, info);
  ws.send(JSON.stringify({ type: 'state', state: publicState() }));

  ws.on('message', raw => {
    // enkel rate-limit: maks 20 meldinger per sekund per tilkobling
    const now = Date.now();
    info.stamps = info.stamps.filter(t => now - t < 1000);
    if (info.stamps.length >= 20) return;
    info.stamps.push(now);

    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return; // f.eks. «null» eller et tall
    try {
    if (msg.type === 'hello') {
      if (msg.role === 'admin') {
        if (!isAdminReq(req)) return ws.send(JSON.stringify({ type: 'unauthorized' }));
        info.role = 'admin';
      } else if (msg.role === 'player') {
        let p = typeof msg.pid === 'string' ? game.players[msg.pid] : null;
        if (!p) {
          const name = String(msg.name || '').trim().slice(0, 20);
          if (!name) return ws.send(JSON.stringify({ type: 'needName' }));
          const same = Object.values(game.players).find(x => x.name.toLowerCase() === name.toLowerCase());
          if (same && same.connected) return ws.send(JSON.stringify({ type: 'nameTaken' }));
          // samme navn som et frakoblet lag = gjenoppta det laget (f.eks. ny telefon)
          p = same || { id: crypto.randomBytes(6).toString('hex'), name, score: 0, connected: true };
          game.players[p.id] = p;
        }
        p.connected = true;
        info.role = 'player'; info.pid = p.id;
        ws.send(JSON.stringify({ type: 'joined', pid: p.id, name: p.name }));
      } else {
        info.role = 'display';
      }
    } else if (msg.type === 'admin' && info.role === 'admin') {
      handleAdmin(msg);
    } else if (msg.type === 'player' && info.role === 'player') {
      handlePlayer(info, msg);
    } else if (msg.type === 'display' && info.role === 'display' && game.current) {
      const media = game.current.media;
      if (msg.action === 'ytEnded') media.playing = false;
      else if (msg.action === 'ytError') { media.playing = false; media.error = Number(msg.code) || -1; }
      else if (msg.action === 'flipDone') showClue(game.current);
      else if (msg.action === 'ytStatus'&& YT_STATUSES.has(msg.status)) media.status = msg.status;
    }
    } catch (err) { console.error('Feil i meldingshåndtering:', err); return; }
    broadcast();
  });

  ws.on('close', () => {
    sockets.delete(ws);
    if (info.pid && game.players[info.pid]) {
      const still = [...sockets.values()].some(i => i.pid === info.pid);
      if (!still) game.players[info.pid].connected = false;
    }
    broadcast();
  });
});

// Hjerteslag: app-melding til klientene (de oppdager døde forbindelser) + ws-ping som rydder bort døde sockets
setInterval(() => {
  for (const [ws] of sockets) {
    if (ws.readyState !== 1) continue;
    if (ws.dead) { ws.terminate(); continue; }
    ws.dead = true; ws.ping();
    ws.send('{"type":"hb"}');
  }
}, 5000);
wss.on('connection', ws => ws.on('pong', () => { ws.dead = false; }));

// Ett uventet unntak skal aldri ta ned hele spillet midt i en runde
process.on('uncaughtException', err => console.error('Uventet feil (serveren fortsetter):', err));
process.on('unhandledRejection', err => console.error('Uventet avvist løfte (serveren fortsetter):', err));

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} er opptatt – en gammel Jeopardy-server kjører sannsynligvis allerede.\n  Lukk den (avslutt "node" i Oppgavebehandling) eller bruk en annen port: set PORT=3001\n`);
  } else console.error(err);
  process.exit(1);
});

// Uten host-argument lytter Node på både IPv4 og IPv6 (localhost kan peke på ::1)
server.listen(PORT, () => {
  if (QUIET) return;
  console.log('\n  JEOPARDY kjører!\n');
  console.log(`  Admin:      http://localhost:${PORT}/admin   (passord: ${ADMIN_PASSWORD})`);
  console.log(`  Storskjerm: http://localhost:${PORT}/display`);
  const cs = candidates();
  if (!cs.length) console.log('  (Fant ingen nettverkskort – er du koblet til Wi-Fi?)');
  cs.forEach(c => console.log(`  Spillere (mobil): http://${c.ip}:${PORT}/play   [${c.iface}${c.virtual ? ', virtuelt – trolig ikke riktig' : ''}]`));
  console.log('\n  Mobilene må være på samme Wi-Fi som denne PC-en.');
  console.log('  Får ikke mobilen kontakt? Se «Får ikke mobilen kontakt?» i admin-siden.\n');
});
