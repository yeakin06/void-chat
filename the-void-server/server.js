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
    res.json({ success: true, data: { url: `${PUBLIC_URL}/uploads/${name}` } });
  });
});
app.use('/uploads', express.static(UPLOAD_DIR, { setHeaders: r => r.setHeader('X-Content-Type-Options', 'nosniff') }));

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
  if (/game|play/.test(x)) return 'Games are fun. Try the game button to start one!';
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
    botSay(s, "Hi! I'm Void Bot 🤖. Nobody else is online right now, so I'll keep you company. Click Next anytime to look for a real person.", 800);
  }, BOT_WAIT_MS);
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
const spy = (roomId, m) => io.to('admins').emit('spy_feed', { roomId, text: esc(m.text || ''), type: m.type, url: m.type === 'image' || m.type === 'music' ? esc(m.url || '') : undefined, cover: esc(m.cover || ''), title: esc(m.title || ''), artist: esc(m.artist || '') });
const failsByIp = new Map();
const ipOf = s => String((s.handshake.headers['x-forwarded-for'] || s.handshake.address || '')).split(',')[0].trim();
const authFail = (u, s) => { const ip = ipOf(s), n = Date.now(); const f = (failsByIp.get(ip) || []).filter(t => n - t < 300000); f.push(n); failsByIp.set(ip, f); return f.length > 8; };
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
  users.set(socket.id, { alias: null, admin: false, god: false, room: null, global: false, lastGlobal: 0 });
  socket.emit('stats_update', stats());

  socket.on('get_admin_data', pass => {
    const u = me(socket); if (authFail(u, socket)) return socket.emit('admin_error');
    if (typeof pass === 'string' && safeEq(pass, ADMIN_PASSWORD)) {
      u.admin = true; socket.join('admins');
      socket.emit('admin_dashboard', { totalUsers: io.engine.clientsCount, waitingUsers: waiting.length, activeRooms: rooms.size, totalVanished: vanished });
    } else socket.emit('admin_error');
  });

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
    const now = Date.now();
    if (!u.god && now - u.lastGlobal < 10000) return;
    u.lastGlobal = now;
    const msg = { id: text(m.id).slice(0, 60), sender: u.alias,
      text: text(m.text, u.god ? GOD_MAX : 5000), type: ['image', 'music'].includes(m.type) ? m.type : 'text', url: text(m.url).slice(0, 500),
      cover: text(m.cover).slice(0, 500), title: text(m.title).slice(0, 200), artist: text(m.artist).slice(0, 200), replyTo: m.replyTo };
    history.push(msg); if (history.length > 50) history.shift();
    socket.to(NEXUS).emit('receive_global', msg); spy(NEXUS, msg);
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
    spy(u.room, msg);
    io.to(r.members).emit('sync_chars', { max: r.max, used: r.used });
    if (!u.god && r.used >= r.max) io.to(r.members).emit('force_shatter');
    if (r.bot) botSay(socket, botReply(t));
  });

  socket.on('typing', () => { const p = peerOf(socket); if (p) io.to(p).emit('typing'); });
  socket.on('react_message', d => { const p = peerOf(socket); if (p && d) io.to(p).emit('receive_reaction', { msgId: text(d.msgId), emoji: text(d.emoji).slice(0, 8) }); });
  socket.on('user_status', st => { const p = peerOf(socket); if (p) io.to(p).emit('stranger_status', st === 'offline' ? 'offline' : 'online'); });
  socket.on('game_action', d => { const p = peerOf(socket); if (p) io.to(p).emit('game_action', d); });

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
