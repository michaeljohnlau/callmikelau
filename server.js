// Kaizen HQ — private team chat server
// Express + Socket.IO, JSON-file persistence (no database needed).

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Optional: require this code to create an account (keeps the workspace private).
const INVITE_CODE = process.env.INVITE_CODE || '';
const WORKSPACE_NAME = process.env.WORKSPACE_NAME || 'Kaizen HQ';

// ---------- Storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_CHANNELS = [
  ['general', 'Team-wide updates and announcements'],
  ['wins', 'Celebrate progress — deals, reviews, 1% better'],
  ['listings', 'Active listings, showings and feedback'],
  ['leads', 'New leads, follow-ups and hand-offs'],
  ['marketing', 'Reels, blogs, photos and campaigns'],
];

function freshDb() {
  const db = { users: {}, sessions: {}, channels: {}, messages: [] };
  for (const [name, topic] of DEFAULT_CHANNELS) {
    const id = uid();
    db.channels[id] = { id, name, topic, isDM: false, members: [], createdBy: null, createdAt: Date.now(), isDefault: true };
  }
  return db;
}

let db;
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  db = freshDb();
}

// ---------- Push notifications (VAPID keys are generated once and saved) ----------
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else {
  try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch {
    vapid = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid));
  }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@kaizenrealestate.ca', vapid.publicKey, vapid.privateKey);

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 300);
}

function uid() {
  return crypto.randomBytes(9).toString('base64url');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const COLORS = ['#c9a96e', '#7aa6c2', '#9bbf8a', '#d08770', '#b48ead', '#88c0d0', '#ebcb8b', '#a3be8c'];

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, title: u.title || '', color: u.color, isAdmin: !!u.isAdmin, status: u.status || '' };
}

function userFromToken(token) {
  const s = token && db.sessions[token];
  return s ? db.users[s.userId] : null;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) => {
  res.json({ workspace: WORKSPACE_NAME, inviteRequired: !!INVITE_CODE, hasUsers: Object.keys(db.users).length > 0 });
});

app.get('/api/push-key', (req, res) => res.json({ key: vapid.publicKey }));

app.post('/api/register', (req, res) => {
  const { name, email, password, title, invite } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName || !cleanEmail || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (INVITE_CODE && invite !== INVITE_CODE) return res.status(403).json({ error: 'That invite code is not valid.' });
  if (Object.values(db.users).some((u) => u.email === cleanEmail)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const isFirst = Object.keys(db.users).length === 0;
  const id = uid();
  db.users[id] = {
    id,
    name: cleanName,
    email: cleanEmail,
    title: String(title || '').trim().slice(0, 60),
    password: hashPassword(String(password)),
    color: COLORS[Object.keys(db.users).length % COLORS.length],
    isAdmin: isFirst,
    lastRead: {},
    createdAt: Date.now(),
  };
  // Everyone joins the default channels.
  for (const c of Object.values(db.channels)) if (c.isDefault) c.members.push(id);
  const announce = () => { for (const c of Object.values(db.channels)) if (c.isDefault) emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members }); };
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: id, createdAt: Date.now() };
  save();
  io.emit('user:new', publicUser(db.users[id]));
  announce();
  res.json({ token });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = Object.values(db.users).find((u) => u.email === String(email || '').trim().toLowerCase());
  if (!user || !checkPassword(String(password || ''), user.password)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: user.id, createdAt: Date.now() };
  save();
  res.json({ token });
});

app.post('/api/logout', (req, res) => {
  const token = req.get('authorization')?.replace('Bearer ', '');
  if (token) delete db.sessions[token];
  save();
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server);

// ---------- Realtime ----------
const online = new Map(); // userId -> socket count

// True if the user has the app open and on screen somewhere.
function isWatching(userId) {
  for (const s of io.sockets.sockets.values()) if (s.data.userId === userId && s.data.visible) return true;
  return false;
}

function pushTo(userId, payload) {
  const u = db.users[userId];
  if (!u?.push?.length || isWatching(userId)) return;
  for (const sub of [...u.push]) {
    webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 }).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        u.push = u.push.filter((x) => x.endpoint !== sub.endpoint);
        save();
      }
    });
  }
}

function notifyRecipients(c, m, sender) {
  const recipients = new Set();
  if (c.isDM) c.members.forEach((id) => recipients.add(id));
  const mentions = m.mentions || [];
  if (mentions.includes('*')) c.members.forEach((id) => recipients.add(id));
  mentions.forEach((id) => c.members.includes(id) && recipients.add(id));
  if (m.parentId) {
    const parent = db.messages.find((p) => p.id === m.parentId);
    if (parent) recipients.add(parent.userId);
    db.messages.filter((r) => r.parentId === m.parentId).forEach((r) => recipients.add(r.userId));
  }
  recipients.delete(sender.id);
  const where = c.isDM ? sender.name : `${sender.name} in #${c.name}`;
  for (const id of recipients) {
    pushTo(id, { title: m.parentId ? `${where} (thread)` : where, body: m.text.slice(0, 180), channelId: c.id, tag: c.id });
  }
}

function canSee(user, channel) {
  return channel && channel.members.includes(user.id);
}

function channelView(c, user) {
  const msgs = db.messages.filter((m) => m.channelId === c.id && !m.parentId && !m.deleted);
  const lastRead = user.lastRead?.[c.id] || 0;
  const unread = msgs.filter((m) => m.ts > lastRead && m.userId !== user.id).length;
  const mentions = msgs.filter((m) => m.ts > lastRead && m.userId !== user.id && (m.mentions || []).includes(user.id)).length;
  return { id: c.id, name: c.name, topic: c.topic, isDM: c.isDM, members: c.members, createdBy: c.createdBy, unread, mentions };
}

function messageView(m) {
  return {
    id: m.id, channelId: m.channelId, userId: m.userId, text: m.deleted ? '' : m.text, ts: m.ts,
    parentId: m.parentId || null, edited: !!m.edited, deleted: !!m.deleted,
    reactions: m.reactions || {}, replyCount: m.replyCount || 0, lastReplyTs: m.lastReplyTs || null,
    pinned: !!m.pinned, mentions: m.mentions || [],
  };
}

function parseMentions(text) {
  const ids = new Set();
  const lower = text.toLowerCase();
  for (const u of Object.values(db.users)) {
    const handle = '@' + u.name.toLowerCase();
    const first = '@' + u.name.split(' ')[0].toLowerCase();
    if (lower.includes(handle) || lower.includes(first)) ids.add(u.id);
  }
  if (/@(here|channel|everyone)\b/i.test(text)) ids.add('*');
  return [...ids];
}

function emitToChannel(channel, event, payload) {
  for (const memberId of channel.members) io.to('u:' + memberId).emit(event, payload);
}

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const me = () => db.users[socket.data.userId];
  const user = me();
  socket.join('u:' + user.id);
  online.set(user.id, (online.get(user.id) || 0) + 1);
  io.emit('presence', { userId: user.id, online: true });

  socket.emit('init', {
    workspace: WORKSPACE_NAME,
    me: publicUser(user),
    users: Object.values(db.users).map(publicUser),
    online: [...online.keys()],
    channels: Object.values(db.channels).filter((c) => canSee(user, c)).map((c) => channelView(c, user)),
    browse: Object.values(db.channels).filter((c) => !c.isDM && !canSee(user, c)).map((c) => ({ id: c.id, name: c.name, topic: c.topic, memberCount: c.members.length })),
  });

  socket.on('history', ({ channelId, before }, cb) => {
    const c = db.channels[channelId];
    if (!canSee(me(), c)) return cb?.({ error: 'Not a member' });
    let list = db.messages.filter((m) => m.channelId === channelId && !m.parentId && (!before || m.ts < before));
    const hasMore = list.length > 50;
    list = list.slice(-50);
    cb?.({ messages: list.map(messageView), hasMore });
  });

  socket.on('thread', ({ messageId }, cb) => {
    const parent = db.messages.find((m) => m.id === messageId);
    if (!parent || !canSee(me(), db.channels[parent.channelId])) return cb?.({ error: 'Not found' });
    cb?.({ parent: messageView(parent), replies: db.messages.filter((m) => m.parentId === messageId).map(messageView) });
  });

  socket.on('message:send', ({ channelId, text, parentId }, cb) => {
    const c = db.channels[channelId];
    const clean = String(text || '').trim().slice(0, 4000);
    if (!canSee(me(), c) || !clean) return cb?.({ error: 'Cannot send' });
    const m = { id: uid(), channelId, userId: me().id, text: clean, ts: Date.now(), parentId: parentId || null, reactions: {}, mentions: parseMentions(clean) };
    db.messages.push(m);
    me().lastRead[channelId] = m.ts;
    if (parentId) {
      const parent = db.messages.find((p) => p.id === parentId);
      if (parent) {
        parent.replyCount = (parent.replyCount || 0) + 1;
        parent.lastReplyTs = m.ts;
        emitToChannel(c, 'message:update', messageView(parent));
      }
    }
    save();
    emitToChannel(c, 'message:new', messageView(m));
    notifyRecipients(c, m, me());
    cb?.({ ok: true });
  });

  socket.on('message:edit', ({ messageId, text }) => {
    const m = db.messages.find((x) => x.id === messageId);
    const clean = String(text || '').trim().slice(0, 4000);
    if (!m || m.userId !== me().id || !clean) return;
    m.text = clean;
    m.edited = true;
    m.mentions = parseMentions(clean);
    save();
    emitToChannel(db.channels[m.channelId], 'message:update', messageView(m));
  });

  socket.on('message:delete', ({ messageId }) => {
    const m = db.messages.find((x) => x.id === messageId);
    if (!m || (m.userId !== me().id && !me().isAdmin)) return;
    m.deleted = true;
    m.text = '';
    save();
    emitToChannel(db.channels[m.channelId], 'message:update', messageView(m));
  });

  socket.on('message:pin', ({ messageId }) => {
    const m = db.messages.find((x) => x.id === messageId);
    if (!m || !canSee(me(), db.channels[m.channelId])) return;
    m.pinned = !m.pinned;
    save();
    emitToChannel(db.channels[m.channelId], 'message:update', messageView(m));
  });

  socket.on('reaction', ({ messageId, emoji }) => {
    const m = db.messages.find((x) => x.id === messageId);
    if (!m || !canSee(me(), db.channels[m.channelId])) return;
    const e = String(emoji).slice(0, 8);
    m.reactions = m.reactions || {};
    const list = m.reactions[e] || [];
    m.reactions[e] = list.includes(me().id) ? list.filter((id) => id !== me().id) : [...list, me().id];
    if (!m.reactions[e].length) delete m.reactions[e];
    save();
    emitToChannel(db.channels[m.channelId], 'message:update', messageView(m));
  });

  socket.on('read', ({ channelId }) => {
    if (!db.channels[channelId]) return;
    me().lastRead[channelId] = Date.now();
    save();
  });

  socket.on('typing', ({ channelId, parentId }) => {
    const c = db.channels[channelId];
    if (!canSee(me(), c)) return;
    for (const id of c.members) if (id !== me().id) io.to('u:' + id).emit('typing', { channelId, parentId: parentId || null, userId: me().id });
  });

  socket.on('channel:create', ({ name, topic }, cb) => {
    const clean = String(name || '').toLowerCase().trim().replace(/^#/, '').replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!clean) return cb?.({ error: 'Give the channel a name.' });
    if (Object.values(db.channels).some((c) => !c.isDM && c.name === clean)) return cb?.({ error: 'That channel already exists.' });
    const id = uid();
    const c = { id, name: clean, topic: String(topic || '').slice(0, 200), isDM: false, members: [me().id], createdBy: me().id, createdAt: Date.now() };
    db.channels[id] = c;
    save();
    socket.emit('channel:joined', channelView(c, me()));
    socket.broadcast.emit('channel:available', { id, name: c.name, topic: c.topic, memberCount: 1 });
    cb?.({ id });
  });

  socket.on('channel:join', ({ channelId }, cb) => {
    const c = db.channels[channelId];
    if (!c || c.isDM) return cb?.({ error: 'Not found' });
    if (!c.members.includes(me().id)) c.members.push(me().id);
    save();
    emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members });
    socket.emit('channel:joined', channelView(c, me()));
    cb?.({ id: c.id });
  });

  socket.on('channel:leave', ({ channelId }) => {
    const c = db.channels[channelId];
    if (!c || c.isDM) return;
    c.members = c.members.filter((id) => id !== me().id);
    save();
    socket.emit('channel:left', { channelId, name: c.name, topic: c.topic, memberCount: c.members.length });
    emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members });
  });

  socket.on('channel:topic', ({ channelId, topic }) => {
    const c = db.channels[channelId];
    if (!canSee(me(), c)) return;
    c.topic = String(topic || '').slice(0, 200);
    save();
    emitToChannel(c, 'channel:topic', { channelId, topic: c.topic });
  });

  socket.on('dm:open', ({ userId }, cb) => {
    const other = db.users[userId];
    if (!other) return cb?.({ error: 'Not found' });
    const pair = [me().id, other.id].sort();
    let c = Object.values(db.channels).find((x) => x.isDM && x.members.length === pair.length && pair.every((id) => x.members.includes(id)) && (pair[0] !== pair[1] || x.members.length === 1));
    if (!c) {
      const members = pair[0] === pair[1] ? [pair[0]] : pair;
      const id = uid();
      c = { id, name: '', topic: '', isDM: true, members, createdBy: me().id, createdAt: Date.now() };
      db.channels[id] = c;
      save();
      for (const m of members) io.to('u:' + m).emit('channel:joined', channelView(c, db.users[m]));
    }
    cb?.({ id: c.id });
  });

  socket.on('profile:update', ({ name, title, status }) => {
    const u = me();
    if (name && String(name).trim()) u.name = String(name).trim().slice(0, 60);
    if (title !== undefined) u.title = String(title).slice(0, 60);
    if (status !== undefined) u.status = String(status).slice(0, 80);
    save();
    io.emit('user:update', publicUser(u));
  });

  socket.on('search', ({ q }, cb) => {
    const term = String(q || '').toLowerCase().trim();
    if (term.length < 2) return cb?.({ results: [] });
    const visible = new Set(Object.values(db.channels).filter((c) => canSee(me(), c)).map((c) => c.id));
    const results = db.messages
      .filter((m) => visible.has(m.channelId) && !m.deleted && m.text.toLowerCase().includes(term))
      .slice(-40).reverse().map(messageView);
    cb?.({ results });
  });

  socket.data.visible = true;
  socket.on('visible', ({ visible }) => { socket.data.visible = !!visible; });

  socket.on('push:subscribe', ({ subscription }) => {
    if (!subscription?.endpoint) return;
    const u = me();
    u.push = (u.push || []).filter((x) => x.endpoint !== subscription.endpoint);
    u.push.push(subscription);
    // One endpoint belongs to one device: remove it from any other account that used this phone.
    for (const other of Object.values(db.users)) if (other.id !== u.id && other.push) other.push = other.push.filter((x) => x.endpoint !== subscription.endpoint);
    save();
  });
  socket.on('push:unsubscribe', ({ endpoint }) => {
    const u = me();
    u.push = (u.push || []).filter((x) => x.endpoint !== endpoint);
    save();
  });

  socket.on('disconnect', () => {
    const n = (online.get(user.id) || 1) - 1;
    if (n <= 0) {
      online.delete(user.id);
      io.emit('presence', { userId: user.id, online: false });
    } else online.set(user.id, n);
  });
});

server.listen(PORT, () => console.log(`${WORKSPACE_NAME} running on http://localhost:${PORT}`));
