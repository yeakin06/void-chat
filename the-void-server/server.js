// The Void – Socket.IO backend. All state is in memory by design (chats vanish).
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

if (ADMIN_PASSWORD.length < 10) {
  console.error('Set ADMIN_PASSWORD (at least 10 characters) in your environment.');
  process.exit(1);
}
if (!ORIGINS.length) console.warn('CORS_ORIGIN not set: browsers from other origins will be blocked.');

// God mode: optional second password. Whoever unlocks it has no message-length limit and no cooldown.
const GOD_PASSWORD = process.env.GOD_PASSWORD || '';
const GOD_ON = GOD_PASSWORD.length >= 10 && GOD_PASSWORD !== ADMIN_PASSWORD;
if (GOD_PASSWORD && !GOD_ON) console.warn('GOD_PASSWORD ignored: it must be 10+ characters and different from ADMIN_PASSWORD.');
const GOD_MAX = 50000; // characters per message in God mode (server payload safety cap)

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = express();
app.set('trust proxy', 1); // behind Render's proxy: use the real client IP
app.use(cors({ origin: ORIGINS.length ? ORIGINS : false }));
app.get('/', (_, res) => res.send('The Void server is running.'));
app.get('/health', (_, res) => res.json({ ok: true }));

// ---- image upload (POST multipart field "image") ----
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }; // no SVG on purpose
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const upHits = new Map();
app.post('/upload', (req, res) => {
  const ip = req.ip, now = Date.now();
  const hits = (upHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 10) return res.status(429).json({ success: false });
  hits.push(now); upHits.set(ip, hits);
  upload.single('image')(req, res, err => {
    if (err || !req.file || !EXT[req.file.mimetype]) return res.status(400).json({ success: false });
    const name = crypto.randomBytes(12).toString('hex') + EXT[req.file.mimetype];
    fs.writeFileSync(path.join(UPLOAD_DIR, name), req.file.buffer);
    res.json({ success: true, data: { url: `${req.protocol}://${req.get('host')}/uploads/${name}` } }); // built from the request so it is always the real public address
  });
});
app.use('/uploads', express.static(UPLOAD_DIR, { setHeaders: r => { r.setHeader('X-Content-Type-Options', 'nosniff'); r.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); } }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGINS.length ? ORIGINS : false }, maxHttpBufferSize: 4e5 });

// ---- state ----
const users = new Map();      // socketId -> { alias, admin, room, global, lastGlobal, fails:[] }
const rooms = new Map();      // roomId -> { members:[id,id], max, used, isPrivate, lost }
let waiting = [];             // socketIds searching
let vanished = 0;
const history = [];           // global history (last 50)
const NEXUS = 'The Nexus';

// ---- Void Bot: labeled bot so nobody is left alone ----
const BOT_ID = 'void-bot';
const BOT_WAIT_MS = 6000; // wait this long for a real person before the bot steps in
const pick = a => a[crypto.randomInt(0, a.length)];
function botReply(t) {
  const x = String(t || '').toLowerCase();
  if (/^(hi|hey|hello|yo|sup|hola|hii+)\b/.test(x)) return pick(['Hey! Good to see you here 👋', 'Hello! What brings you to the Void?', 'Hi there! How is your day going?']);
  if (/how are you|how r u|wyd|what.?s up/.test(x)) return pick(["I'm a bot, so always floating in the Void. How about you?", 'Doing great, thanks for asking! You?']);
  if (/(are you|r u).*(bot|real|human|ai)|bot\?/.test(x)) return "Yes, I'm Void Bot, a program. A real person will show up when someone else joins!";
  if (/\b(bye|goodbye|cya|gtg)\b/.test(x)) return 'See you later! Come back anytime 👋';
  if (/\b(name|who are you)\b/.test(x)) return "I'm Void Bot 🤖. I keep the Void company when it's quiet.";
  if (/music|song/.test(x)) return 'Music is great. Try the music button to share a song!';
  if (/game|play|rps|tic|connect/.test(x)) return 'I love games! Tap the 🎮 button and challenge me: Rock Paper Scissors, Tic Tac Toe or Connect 4. I accept every challenge.';
  if (x.includes('?')) return pick(['Good question. What do you think?', "Hmm, I'm only a simple bot. What's your take?", 'Tell me more, I like that question.']);
  return pick(['Interesting, tell me more.', 'Ha, I like that.', 'Go on, I am listening.', 'That makes sense. What else is on your mind?', 'Nice! What else?', "I'm only a bot, but I'm happy to chat."]);
}
function botSay(s, t, delay) {
  setTimeout(() => {
    const u = users.get(s.id), r = u && rooms.get(u.room); if (!r || !r.bot) return;
    s.emit('typing');
    setTimeout(() => {
      const u2 = users.get(s.id), r2 = u2 && rooms.get(u2.room); if (!r2 || !r2.bot) return;
      s.emit('receive_message', { id: 'bot' + Date.now(), text: t, type: 'text' });
    }, 900);
  }, delay || 1200);
}
function scheduleBot(s) {
  const u = users.get(s.id); if (!u) return;
  clearTimeout(u.botTimer);
  u.botTimer = setTimeout(() => {
    const u2 = users.get(s.id);
    if (!u2 || u2.room || !waiting.includes(s.id)) return;
    waiting = waiting.filter(i => i !== s.id);
    const roomId = crypto.randomUUID();
    rooms.set(roomId, { members: [s.id, BOT_ID], max: 1500, used: 0, isPrivate: false, bot: true });
    u2.room = roomId;
    s.emit('match_found', { roomId, karma: '5.0', flag: '🤖' });
    botSay(s, "Hi! I'm Void Bot 🤖. Nobody else is online right now, so I'll keep you company. I can play games too, so tap the 🎮 button and challenge me! Click Next anytime to look for a real person.", 800);
  }, BOT_WAIT_MS);
}
// ---- Void Bot game AI (pure functions) ----
const WINS3 = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const t3win = b => { for (const [a, c, d] of WINS3) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a]; return null; };
function t3minimax(b, turn, depth) { // bot is 'O' (maximizes), human is 'X'
  const w = t3win(b);
  if (w) return { score: w === 'O' ? 10 - depth : depth - 10 };
  const free = []; b.forEach((v, i) => { if (v === '') free.push(i); });
  if (!free.length) return { score: 0 };
  let bestScore = turn === 'O' ? -Infinity : Infinity, moves = [];
  for (const i of free) {
    b[i] = turn; const sc = t3minimax(b, turn === 'O' ? 'X' : 'O', depth + 1).score; b[i] = '';
    if (turn === 'O' ? sc > bestScore : sc < bestScore) { bestScore = sc; moves = [i]; } else if (sc === bestScore) moves.push(i);
  }
  return { score: bestScore, move: pick(moves) };
}
function t3move(b) { // smart, but makes a random slip about 1 time in 5 so it can be beaten
  const free = []; b.forEach((v, i) => { if (v === '') free.push(i); });
  return crypto.randomInt(0, 100) < 20 ? pick(free) : t3minimax(b, 'O', 0).move;
}

const C4R = 6, C4C = 7;
const c4new = () => Array.from({ length: C4R }, () => Array(C4C).fill(''));
const c4row = (b, c) => { for (let r = C4R - 1; r >= 0; r--) if (b[r][c] === '') return r; return -1; };
const c4full = b => b[0].every(x => x !== '');
function c4win(b, r, c, p) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const sg of [1, -1]) for (let i = 1; i <= 3; i++) {
      const nr = r + dr * i * sg, nc = c + dc * i * sg;
      if (nr >= 0 && nr < C4R && nc >= 0 && nc < C4C && b[nr][nc] === p) n++; else break;
    }
    if (n >= 4) return true;
  }
  return false;
}
const C4WINDOWS = (() => {
  const w = [];
  for (let r = 0; r < C4R; r++) for (let c = 0; c < C4C; c++)
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const cells = []; for (let i = 0; i < 4; i++) cells.push([r + dr * i, c + dc * i]);
      if (cells.every(([y, x]) => y >= 0 && y < C4R && x >= 0 && x < C4C)) w.push(cells);
    }
  return w;
})();
function c4eval(b, p) {
  const o = p === 'p1' ? 'p2' : 'p1'; let s = 0;
  for (let r = 0; r < C4R; r++) if (b[r][3] === p) s += 3;
  for (const cells of C4WINDOWS) {
    let mine = 0, theirs = 0;
    for (const [y, x] of cells) { if (b[y][x] === p) mine++; else if (b[y][x] === o) theirs++; }
    if (mine && theirs) continue;
    if (mine === 3) s += 5; else if (mine === 2) s += 2; else if (theirs === 3) s -= 4;
  }
  return s;
}
function c4search(b, p, depth, alpha, beta) {
  const o = p === 'p1' ? 'p2' : 'p1';
  const cols = [3, 2, 4, 1, 5, 0, 6].filter(c => b[0][c] === '');
  if (!cols.length) return 0;
  if (depth === 0) return c4eval(b, p);
  let best = -Infinity;
  for (const c of cols) {
    const r = c4row(b, c); b[r][c] = p;
    const sc = c4win(b, r, c, p) ? 1000 + depth : -c4search(b, o, depth - 1, -beta, -alpha);
    b[r][c] = '';
    if (sc > best) best = sc; if (best > alpha) alpha = best; if (alpha >= beta) break;
  }
  return best;
}
function c4move(b, p) { // looks 4 moves ahead, with a random slip about 1 time in 7
  const o = p === 'p1' ? 'p2' : 'p1';
  const cols = [0, 1, 2, 3, 4, 5, 6].filter(c => b[0][c] === '');
  if (crypto.randomInt(0, 100) < 14) return pick(cols);
  let best = -Infinity, bests = [];
  for (const c of cols) {
    const r = c4row(b, c); b[r][c] = p;
    const sc = c4win(b, r, c, p) ? 100000 : -c4search(b, o, 3, -Infinity, Infinity);
    b[r][c] = '';
    if (sc > best) { best = sc; bests = [c]; } else if (sc === best) bests.push(c);
  }
  return pick(bests);
}

// ---- Void Bot plays the 1v1 games (same messages the page already uses) ----
function botGame(s, r, d) {
  if (!d || typeof d !== 'object') return;
  const alive = () => { const u = users.get(s.id); return !!u && rooms.get(u.room) === r; };
  const emitGA = (payload, delay) => setTimeout(() => { if (alive()) s.emit('game_action', payload); }, delay);

  if (d.type === 'invite') {
    const g = ['rps', 'ttt', 'c4'].includes(d.game) ? d.game : null; if (!g) return;
    r.game = { type: g, board: g === 'ttt' ? Array(9).fill('') : g === 'c4' ? c4new() : null, turn: 'human', rpsDone: false };
    emitGA({ type: 'accept', game: g }, 900);
    botSay(s, pick(['Challenge accepted! 🎮 Good luck.', "You're on! Let's see what you've got 😎", "Game on! I won't go easy on you."]), 1000);
    return;
  }
  const G = r.game; if (!G) return;
  const end = (msg, delay) => { r.game = null; botSay(s, msg, delay); };

  if (d.type === 'rps_move' && G.type === 'rps') {
    const m = d.move; if (!['Rock', 'Paper', 'Scissors'].includes(m) || G.rpsDone) return;
    G.rpsDone = true;
    const bm = pick(['Rock', 'Paper', 'Scissors']);
    const youWin = (m === 'Rock' && bm === 'Scissors') || (m === 'Paper' && bm === 'Rock') || (m === 'Scissors' && bm === 'Paper');
    emitGA({ type: 'rps_move', move: bm }, 800);
    setTimeout(() => end(m === bm ? `We both picked ${bm}! 🤝 Rematch?` : youWin ? `You got me! ${m} beats ${bm}. GG 👏` : `${bm} beats ${m}! 😎 Rematch?`, 100), 900);
    return;
  }

  if (d.type === 'ttt_move' && G.type === 'ttt' && G.turn === 'human') {
    const i = Number(d.index); if (!Number.isInteger(i) || i < 0 || i > 8 || G.board[i] !== '') return;
    G.board[i] = 'X';
    if (t3win(G.board)) return end('You win this one! GG 👏', 1200);
    if (!G.board.includes('')) return end("It's a draw! Well played 🤝", 1200);
    G.turn = 'bot';
    const mv = t3move(G.board);
    setTimeout(() => {
      if (!alive() || r.game !== G) return;
      G.board[mv] = 'O'; s.emit('game_action', { type: 'ttt_move', index: mv });
      if (t3win(G.board)) end('I win this round! 😈 Rematch?', 900);
      else if (!G.board.includes('')) end("It's a draw! Well played 🤝", 900);
      else G.turn = 'human';
    }, 800);
    return;
  }

  if (d.type === 'c4_move' && G.type === 'c4' && G.turn === 'human') {
    const c = Number(d.col); if (!Number.isInteger(c) || c < 0 || c > 6) return;
    const row = c4row(G.board, c); if (row === -1) return;
    G.board[row][c] = 'p1';
    if (c4win(G.board, row, c, 'p1')) return end('Nice connect! You win 👏 GG', 1200);
    if (c4full(G.board)) return end("The board is full. It's a draw! 🤝", 1200);
    G.turn = 'bot';
    const bc = c4move(G.board, 'p2');
    setTimeout(() => {
      if (!alive() || r.game !== G) return;
      const br = c4row(G.board, bc); G.board[br][bc] = 'p2'; s.emit('game_action', { type: 'c4_move', col: bc });
      if (c4win(G.board, br, bc, 'p2')) end('Four in a row! I win 😈 Rematch?', 900);
      else if (c4full(G.board)) end("The board is full. It's a draw! 🤝", 900);
      else G.turn = 'human';
    }, 900);
  }
}

const nexusSize = () => (io.sockets.adapter.rooms.get(NEXUS) || { size: 0 }).size;
function globalBot(s, t) {
  setTimeout(() => {
    const u = users.get(s.id); if (!u || !u.global || nexusSize() > 1) return;
    s.emit('receive_global', { id: 'bot' + Date.now(), sender: 'Void Bot 🤖', text: t, type: 'text' });
  }, 1800);
}

const me = s => users.get(s.id);
const peerOf = s => { const u = me(s); const r = u && rooms.get(u.room); return r ? r.members.find(i => i !== s.id) : null; };
const text = (v, n = 5000) => (typeof v === 'string' ? v.slice(0, n) : '');
const spy = (roomId, m, sid) => io.to('admins').emit('spy_feed', { roomId, uid: sid ? uidOf(sid) : undefined, text: esc(m.text || ''), type: m.type, url: m.type === 'image' || m.type === 'music' ? esc(m.url || '') : undefined, cover: esc(m.cover || ''), title: esc(m.title || ''), artist: esc(m.artist || '') });
const failsByIp = new Map();
const ipOf = s => String((s.handshake.headers['x-forwarded-for'] || s.handshake.address || '')).split(',').pop().trim();
const authFail = (u, s) => { const ip = ipOf(s), n = Date.now(); const f = (failsByIp.get(ip) || []).filter(t => n - t < 300000); f.push(n); failsByIp.set(ip, f); return f.length > 8; };
// ---- admin tools ----
const T0 = Date.now(); let peak = 0, msgCount = 0, nexusLocked = false, banSeq = 0;
const bans = new Map(); // id -> { ip, label, ts } (memory only: cleared when the server restarts)
const uidOf = id => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 6);
const maskIp = ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.split('.').slice(0, 2).join('.') + '.*.*' : String(ip).slice(0, 6) + '…';
const banList = () => [...bans].map(([id, b]) => ({ id, label: b.label, ts: b.ts }));
const isBanned = ip => [...bans.values()].some(b => b.ip === ip);
const adminStats = () => ({ online: io.engine.clientsCount, waiting: waiting.length, rooms: rooms.size, bots: [...rooms.values()].filter(r => r.bot).length,
  nexus: nexusSize(), vanished, peak, msgs: msgCount, up: Math.floor((Date.now() - T0) / 1000), mem: Math.round(process.memoryUsage().rss / 1048576), locked: nexusLocked, bans: bans.size });
setInterval(() => { peak = Math.max(peak, io.engine.clientsCount); io.to('admins').emit('admin_stats', adminStats()); }, 3000);
const stats = () => ({ activeUsers: io.engine.clientsCount, vanishedChats: vanished });
setInterval(() => io.emit('stats_update', stats()), 4000);

function endRoom(roomId, exceptId) {
  const r = rooms.get(roomId); if (!r) return;
  rooms.delete(roomId); vanished++;
  r.members.forEach(id => {
    const u = users.get(id); if (u) u.room = null;
    if (id !== exceptId) io.to(id).emit('stranger_disconnected');
  });
}
function leave(s) {
  waiting = waiting.filter(i => i !== s.id);
  const u = me(s); if (u) clearTimeout(u.botTimer); if (u && u.room) endRoom(u.room, s.id);
  if (u && u.global) { s.leave(NEXUS); u.global = false; }
}
function makeRoom(a, b, isPrivate) {
  const roomId = crypto.randomUUID();
  rooms.set(roomId, { members: [a.id, b.id], max: isPrivate ? 500 : 1500, used: 0, isPrivate });
  [a, b].forEach(s => { const u = users.get(s.id); u.room = roomId; if (u.global) { s.leave(NEXUS); u.global = false; } });
  return roomId;
}

io.on('connection', socket => {
  if (isBanned(ipOf(socket))) { socket.emit('banned'); return socket.disconnect(true); }
  peak = Math.max(peak, io.engine.clientsCount);
  users.set(socket.id, { alias: null, admin: false, god: false, room: null, global: false, lastGlobal: 0 });
  socket.emit('stats_update', stats());

  socket.on('get_admin_data', pass => {
    const u = me(socket); if (authFail(u, socket)) return socket.emit('admin_error');
    if (typeof pass === 'string' && safeEq(pass, ADMIN_PASSWORD)) {
      u.admin = true; socket.join('admins');
      socket.emit('admin_bans', banList()); socket.emit('admin_stats', adminStats()); socket.emit('admin_dashboard', { totalUsers: io.engine.clientsCount, waitingUsers: waiting.length, activeRooms: rooms.size, totalVanished: vanished });
    } else socket.emit('admin_error');
  });

  const adm = () => { const u = me(socket); return u && u.admin ? u : null; };
  socket.on('admin_broadcast', t => { if (!adm()) return; t = text(t, 200).trim(); if (t) io.emit('announcement', { text: t }); });
  socket.on('admin_end_room', id => { if (adm() && typeof id === 'string' && rooms.has(id)) endRoom(id); });
  socket.on('admin_nexus', a => {
    if (!adm()) return;
    if (a === 'lock') { nexusLocked = !nexusLocked; io.emit('announcement', { text: nexusLocked ? 'The Nexus is locked by an admin.' : 'The Nexus is open again.' }); }
    else if (a === 'clear') history.length = 0;
    io.to('admins').emit('admin_stats', adminStats());
  });
  socket.on('admin_ban', uid => {
    if (!adm() || typeof uid !== 'string') return;
    for (const [id, u] of users) if (!u.admin && uidOf(id) === uid) {
      const t = io.sockets.sockets.get(id); if (!t) continue;
      const ip = ipOf(t); bans.set('b' + (++banSeq), { ip, label: maskIp(ip), ts: Date.now() });
      t.emit('banned'); t.disconnect(true);
      io.to('admins').emit('admin_bans', banList()); io.to('admins').emit('admin_stats', adminStats()); break;
    }
  });
  socket.on('admin_unban', id => { if (adm() && bans.delete(id)) { io.to('admins').emit('admin_bans', banList()); io.to('admins').emit('admin_stats', adminStats()); } });

  socket.on('god_auth', pass => {
    const u = me(socket); if (!GOD_ON) return socket.emit('god_error');
    if (authFail(u, socket)) return socket.emit('god_error');
    if (typeof pass === 'string' && safeEq(pass, GOD_PASSWORD)) { u.god = true; socket.emit('god_ok'); }
    else socket.emit('god_error');
  });

  socket.on('find_match', () => {
    const u = me(socket); leave(socket);
    const otherId = waiting.find(i => i !== socket.id && users.has(i));
    if (!otherId) { waiting.push(socket.id); scheduleBot(socket); return; }
    waiting = waiting.filter(i => i !== otherId);
    const other = io.sockets.sockets.get(otherId), ou = users.get(otherId);
    const roomId = makeRoom(socket, other, false);
    socket.emit('match_found', { roomId, karma: '5.0', flag: '🌍' });
    other.emit('match_found', { roomId, karma: '5.0', flag: '🌍' });
  });

  socket.on('join_global', () => {
    const u = me(socket); leave(socket);
    u.global = true; socket.join(NEXUS);
    if (!u.alias) u.alias = 'Void-' + crypto.randomInt(1000, 9999);
    socket.emit('global_joined', { alias: u.alias });
    socket.emit('global_history', history);
    if (nexusSize() <= 1) globalBot(socket, "Hey! I'm Void Bot 🤖. You're the only one in The Nexus right now. Say something and I'll reply until real people arrive.");
  });

  socket.on('send_global', m => {
    const u = me(socket); if (!u.global || !m) return;
    if (nexusLocked && !u.admin && !u.god) return socket.emit('announcement', { text: 'The Nexus is locked right now.' });
    const now = Date.now();
    if (!u.god && now - u.lastGlobal < 10000) return;
    u.lastGlobal = now;
    const msg = { id: text(m.id).slice(0, 60), sender: u.alias,
      text: text(m.text, u.god ? GOD_MAX : 5000), type: ['image', 'music'].includes(m.type) ? m.type : 'text', url: text(m.url).slice(0, 500),
      cover: text(m.cover).slice(0, 500), title: text(m.title).slice(0, 200), artist: text(m.artist).slice(0, 200), replyTo: m.replyTo };
    history.push(msg); if (history.length > 50) history.shift();
    socket.to(NEXUS).emit('receive_global', msg); spy(NEXUS, msg, socket.id); msgCount++;
    if (nexusSize() <= 1) globalBot(socket, botReply(msg.text));
  });

  socket.on('send_message', m => {
    const u = me(socket), r = u && rooms.get(u.room); if (!r || !m) return;
    const t = text(m.text, u.god ? GOD_MAX : 5000);
    if (!u.god && r.used + t.length > r.max) return;
    if (!u.god) r.used += t.length;
    const msg = { id: text(m.id).slice(0, 60), text: t, type: ['image', 'music'].includes(m.type) ? m.type : 'text', url: text(m.url).slice(0, 500),
      cover: text(m.cover).slice(0, 500), title: text(m.title).slice(0, 200), artist: text(m.artist).slice(0, 200),
      replyTo: m.replyTo };
    const p = peerOf(socket); if (p) io.to(p).emit('receive_message', msg);
    if (msg.type !== 'text') socket.emit('receive_message', msg); // echo photos/music back so the sender sees them too
    spy(u.room, msg, socket.id); msgCount++;
    io.to(r.members).emit('sync_chars', { max: r.max, used: r.used });
    if (!u.god && r.used >= r.max) io.to(r.members).emit('force_shatter');
    if (r.bot) botSay(socket, botReply(t));
  });

  socket.on('typing', () => { const p = peerOf(socket); if (p) io.to(p).emit('typing'); });
  socket.on('react_message', d => { const p = peerOf(socket); if (p && d) io.to(p).emit('receive_reaction', { msgId: text(d.msgId), emoji: text(d.emoji).slice(0, 8) }); });
  socket.on('user_status', st => { const p = peerOf(socket); if (p) io.to(p).emit('stranger_status', st === 'offline' ? 'offline' : 'online'); });
  socket.on('game_action', d => {
    const u = me(socket), r = u && rooms.get(u.room);
    if (r && r.bot) return botGame(socket, r, d);
    const p = peerOf(socket); if (p) io.to(p).emit('game_action', d);
  });

  socket.on('request_extend', () => { const p = peerOf(socket); if (p) io.to(p).emit('extend_requested'); });
  socket.on('accept_extend', () => {
    const u = me(socket), r = u && rooms.get(u.room); if (!r) return;
    r.max += 500; io.to(r.members).emit('extend_accepted', { max: r.max, used: r.used });
  });

  socket.on('invite_private', alias => {
    const u = me(socket); if (!u.global) return;
    for (const [id, t] of users) if (t.global && t.alias === alias && id !== socket.id)
      io.to(id).emit('private_request', { from: u.alias, to: alias, fromId: socket.id });
  });
  socket.on('accept_private', d => {
    const u = me(socket), from = d && io.sockets.sockets.get(d.fromId), fu = from && users.get(d.fromId);
    if (!from || !fu.global || u.alias !== d.to) return;
    leave(socket); leave(from);
    const roomId = makeRoom(socket, from, true);
    [socket, from].forEach(s => s.emit('match_found', { roomId, isPrivateSide: true }));
  });

  socket.on('game_invite_global', d => {
    const u = me(socket); if (!u.global || !d) return;
    socket.to(NEXUS).emit('global_game_invite', { game: text(d.game).slice(0, 10), inviteId: text(d.inviteId).slice(0, 60), fromId: socket.id, fromAlias: u.alias });
  });
  socket.on('accept_global_game', d => {
    if (!d || !io.sockets.sockets.has(d.fromId)) return;
    io.to(d.fromId).emit('start_game_directly', { game: d.game, isPlayer1: true });
    socket.emit('start_game_directly', { game: d.game, isPlayer1: false });
  });

  socket.on('reclaim_session', roomId => {
    const r = rooms.get(roomId), u = me(socket); if (!r || r.lost == null) return;
    r.members = r.members.map(i => (i === r.lost ? socket.id : i)); clearTimeout(r.timer); r.lost = null; u.room = roomId;
  });
  socket.on('chat_shattered', () => { const u = me(socket); if (u && u.room) endRoom(u.room, socket.id); });
  socket.on('leave_chat', () => leave(socket));

  socket.on('disconnect', () => {
    const u = me(socket), r = u && rooms.get(u.room);
    waiting = waiting.filter(i => i !== socket.id);
    if (r) { // 15s grace so a brief network drop doesn't kill the chat
      r.lost = socket.id; const p = r.members.find(i => i !== socket.id); if (p) io.to(p).emit('stranger_status', 'offline');
      r.timer = setTimeout(() => endRoom(u.room, socket.id), 15000);
    }
    users.delete(socket.id);
  });
});

server.listen(PORT, () => console.log(`Void server on :${PORT}`));
