// Kaizen HQ — private team chat server
// Express + Socket.IO, JSON-file persistence (no database needed).

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const webpush = require('web-push');
const { mountMcp } = require('./mcp');
const { mountIntegrations } = require('./integrations');

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
  const db = { users: {}, sessions: {}, channels: {}, messages: [], botTokens: {} };
  for (const [name, topic] of DEFAULT_CHANNELS) {
    const id = uid();
    db.channels[id] = { id, name, topic, isDM: false, members: [], createdBy: null, createdAt: Date.now(), isDefault: true, parentId: null };
  }
  return db;
}

let db;
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    // Never silently overwrite saved data: keep the unreadable file aside so it can be recovered.
    const backup = DB_FILE.replace(/\.json$/, `.unreadable-${Date.now()}.json`);
    fs.renameSync(DB_FILE, backup);
    console.error(`Could not read ${DB_FILE} (${e.message}). Saved it as ${backup} and started fresh.`);
    db = freshDb();
  }
} else {
  db = freshDb();
}

// Storage check: on Render, data only survives updates and restarts when it lives on a persistent disk.
const storage = (() => {
  const onRender = !!process.env.RENDER;
  const persistent = !onRender || (!!process.env.DATA_DIR && DATA_DIR.startsWith('/var/data'));
  return {
    persistent,
    path: DATA_DIR,
    warning: persistent ? null : 'Messages and accounts are NOT being saved permanently. In Render, add a Disk mounted at /var/data and set DATA_DIR=/var/data, otherwise everything is erased on every update or restart.',
  };
})();
if (storage.warning) console.warn('WARNING: ' + storage.warning);
db.botTokens = db.botTokens || {};

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
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const COLORS = ['#c9a96e', '#7aa6c2', '#9bbf8a', '#d08770', '#b48ead', '#88c0d0', '#ebcb8b', '#a3be8c'];
const LEVELS = ['all', 'mentions', 'mute'];
const SOUNDS = ['chime', 'ding', 'pop', 'marimba', 'soft', 'none'];

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.isBot ? '' : u.email, title: u.title || '', color: u.color, isAdmin: !!u.isAdmin, isBot: !!u.isBot, integration: u.integration || null, status: u.status || '' };
}

function prefsOf(u) {
  u.prefs = u.prefs || {};
  u.prefs.notify = u.prefs.notify || {};
  if (!SOUNDS.includes(u.prefs.sound)) u.prefs.sound = 'chime';
  u.prefs.pauseUntil = u.prefs.pauseUntil || 0;
  return u.prefs;
}

function userFromToken(token) {
  const s = token && db.sessions[token];
  return s ? db.users[s.userId] : null;
}

// ---------- Core (shared by the app and the MCP connection) ----------
let io; // set below

function canSee(user, channel) {
  if (!channel || !user) return false;
  if (channel.members.includes(user.id)) return true;
  return !!user.isBot && !channel.isDM; // bots can read any public channel
}

function channelSlug(s) {
  return String(s || '').toLowerCase().trim().replace(/^#/, '').replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function displayName(c) {
  if (c.isDM) return 'Direct message';
  const own = c.label || c.name;
  const parent = c.parentId && db.channels[c.parentId];
  return parent ? `${parent.name} › ${own}` : own;
}

// Notification level for a user in a channel: own setting → parent channel's setting → "all".
function levelFor(u, c) {
  const n = prefsOf(u).notify;
  return n[c.id] || (c.parentId && n[c.parentId]) || 'all';
}

function channelView(c, user) {
  const msgs = db.messages.filter((m) => m.channelId === c.id && !m.parentId && !m.deleted);
  const lastRead = user.lastRead?.[c.id] || 0;
  const unread = msgs.filter((m) => m.ts > lastRead && m.userId !== user.id).length;
  const mentions = msgs.filter((m) => m.ts > lastRead && m.userId !== user.id && (m.mentions || []).some((id) => id === user.id || id === '*')).length;
  return {
    id: c.id, name: c.name, label: c.label || '', topic: c.topic, isDM: c.isDM, members: c.members, createdBy: c.createdBy,
    parentId: c.parentId || null, archived: !!c.archived, isDefault: !!c.isDefault, unread, mentions,
  };
}
const browseView = (c) => ({ id: c.id, name: c.name, label: c.label || '', topic: c.topic, parentId: c.parentId || null, archived: !!c.archived, memberCount: c.members.length });

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
    if (u.disabled) continue;
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
function emitToUser(userId, event, payload) {
  io.to('u:' + userId).emit(event, payload);
}

// True if the user has the app open and on screen somewhere.
function isWatching(userId) {
  for (const s of io.sockets.sockets.values()) if (s.data.userId === userId && s.data.visible) return true;
  return false;
}

function pushTo(userId, payload) {
  const u = db.users[userId];
  if (!u?.push?.length || isWatching(userId)) return;
  for (const sub of [...u.push]) {
    webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        u.push = u.push.filter((x) => x.endpoint !== sub.endpoint);
        save();
      }
    });
  }
}

// Should this user be notified about this message? Mirrors the logic in the app.
function shouldNotify(u, c, m) {
  if (!u || u.isBot || u.id === m.userId) return false;
  const prefs = prefsOf(u);
  if (prefs.pauseUntil > Date.now()) return false;
  const level = levelFor(u, c);
  if (level === 'mute') return false;
  const mentioned = (m.mentions || []).some((id) => id === u.id || id === '*');
  if (m.parentId) {
    const inThread = db.messages.some((x) => (x.id === m.parentId || x.parentId === m.parentId) && x.userId === u.id);
    return inThread || mentioned;
  }
  if (c.isDM || mentioned) return true;
  return level === 'all';
}

function notifyRecipients(c, m, sender) {
  const where = c.isDM ? sender.name : `${sender.name} in #${displayName(c)}`;
  for (const id of c.members) {
    if (!shouldNotify(db.users[id], c, m)) continue;
    pushTo(id, { title: m.parentId ? `${where} (thread)` : where, body: m.text.slice(0, 180), channelId: c.id, tag: c.id });
  }
}

function postMessage(user, channelId, text, parentId) {
  const c = db.channels[channelId];
  const clean = String(text || '').trim().slice(0, 4000);
  if (!canSee(user, c)) throw new Error('You are not a member of that channel.');
  if (c.archived) throw new Error('This channel is archived. Unarchive it to post.');
  if (!clean) throw new Error('Message is empty.');
  if (parentId) {
    const parent = db.messages.find((p) => p.id === parentId);
    if (!parent || parent.channelId !== c.id) throw new Error('Thread not found in that channel.');
  }
  if (user.isBot && !c.members.includes(user.id)) {
    c.members.push(user.id);
    emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members });
  }
  const m = { id: uid(), channelId: c.id, userId: user.id, text: clean, ts: Date.now(), parentId: parentId || null, reactions: {}, mentions: parseMentions(clean) };
  db.messages.push(m);
  user.lastRead = user.lastRead || {};
  user.lastRead[c.id] = m.ts;
  if (parentId) {
    const parent = db.messages.find((p) => p.id === parentId);
    parent.replyCount = (parent.replyCount || 0) + 1;
    parent.lastReplyTs = m.ts;
    emitToChannel(c, 'message:update', messageView(parent));
  }
  save();
  emitToChannel(c, 'message:new', messageView(m));
  notifyRecipients(c, m, user);
  return m;
}

function createChannel(user, { name, topic, parentId }) {
  const parent = parentId ? db.channels[parentId] : null;
  if (parentId && (!parent || parent.isDM || parent.parentId)) throw new Error('Sub-channels can only be added under a main channel.');
  if (parent && !canSee(user, parent)) throw new Error('Join the parent channel first.');
  const label = String(name || '').trim().replace(/^#/, '').slice(0, 80);
  const slug = channelSlug(label);
  if (!slug) throw new Error('Give the channel a name.');
  const clash = Object.values(db.channels).some((c) => !c.isDM && (c.parentId || null) === (parentId || null) && c.name === slug);
  if (clash) throw new Error(parent ? `#${parent.name} already has a sub-channel with that name.` : 'That channel already exists.');
  const id = uid();
  const members = parent ? [...new Set([...parent.members.filter((mid) => !db.users[mid]?.isBot), user.id])] : [user.id];
  const c = {
    id, name: slug, label: parent && label !== slug ? label : '', topic: String(topic || '').slice(0, 200), isDM: false,
    members, createdBy: user.id, createdAt: Date.now(), parentId: parent ? parent.id : null,
  };
  db.channels[id] = c;
  save();
  for (const mid of members) emitToUser(mid, 'channel:joined', channelView(c, db.users[mid]));
  for (const s of io.sockets.sockets.values()) if (!members.includes(s.data.userId)) s.emit('channel:available', browseView(c));
  return c;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true, storage: storage.persistent ? 'persistent' : 'NOT persistent: data is erased on every update/restart', users: Object.values(db.users).filter((u) => !u.isBot).length, messages: db.messages.length }));

app.get('/api/config', (req, res) => {
  res.json({ workspace: WORKSPACE_NAME, inviteRequired: !!INVITE_CODE, hasUsers: Object.values(db.users).some((u) => !u.isBot) });
});

app.get('/api/push-key', (req, res) => res.json({ key: vapid.publicKey }));

app.post('/api/register', (req, res) => {
  const { name, email, password, title, invite } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName || !cleanEmail || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (INVITE_CODE && invite !== INVITE_CODE) return res.status(403).json({ error: 'That invite code is not valid.' });
  if (Object.values(db.users).some((u) => !u.isBot && u.email === cleanEmail)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const isFirst = !Object.values(db.users).some((u) => !u.isBot);
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
    prefs: { notify: {}, sound: 'chime', pauseUntil: 0 },
    createdAt: Date.now(),
  };
  // Everyone joins the default channels and their sub-channels.
  const joined = Object.values(db.channels).filter((c) => !c.isDM && (c.isDefault || (c.parentId && db.channels[c.parentId]?.isDefault)) && !c.archived);
  for (const c of joined) c.members.push(id);
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: id, createdAt: Date.now() };
  save();
  io.emit('user:new', publicUser(db.users[id]));
  for (const c of joined) emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members });
  res.json({ token });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = Object.values(db.users).find((u) => !u.isBot && u.email === String(email || '').trim().toLowerCase());
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

// MCP endpoint for AI assistants (Grok, Claude, etc.), authenticated with a bot key.
mountMcp(app, {
  workspace: WORKSPACE_NAME,
  get db() { return db; },
  botFromKey(key) {
    const rec = key && db.botTokens[sha256(key)];
    const bot = rec && db.users[rec.userId];
    if (!bot || bot.disabled) return null;
    rec.lastUsed = Date.now();
    save();
    return bot;
  },
  canSee, displayName, messageView, postMessage, createChannel, channelSlug,
});

const integrations = mountIntegrations(app, {
  get db() { return db; },
  save, postMessage, publicUser,
  io: () => io,
});

const server = http.createServer(app);
io = new Server(server);

// ---------- Realtime ----------
const online = new Map(); // userId -> socket count

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

function botList() {
  return Object.entries(db.botTokens).map(([hash, rec]) => {
    const u = db.users[rec.userId];
    return u && !u.disabled ? { id: u.id, name: u.name, createdAt: rec.createdAt, lastUsed: rec.lastUsed || null, keyHint: rec.hint } : null;
  }).filter(Boolean);
}

io.on('connection', (socket) => {
  const me = () => db.users[socket.data.userId];
  const user = me();
  socket.join('u:' + user.id);
  online.set(user.id, (online.get(user.id) || 0) + 1);
  io.emit('presence', { userId: user.id, online: true });

  const ok = (cb, data = {}) => cb?.({ ok: true, ...data });
  const fail = (cb, err) => cb?.({ error: err.message || String(err) });

  socket.emit('init', {
    workspace: WORKSPACE_NAME,
    me: publicUser(user),
    storageWarning: user.isAdmin ? storage.warning : null,
    prefs: prefsOf(user),
    users: Object.values(db.users).filter((u) => !u.disabled).map(publicUser),
    online: [...online.keys()],
    channels: Object.values(db.channels).filter((c) => c.members.includes(user.id)).map((c) => channelView(c, user)),
    browse: Object.values(db.channels).filter((c) => !c.isDM && !c.members.includes(user.id)).map(browseView),
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
    try { postMessage(me(), channelId, text, parentId); ok(cb); } catch (e) { fail(cb, e); }
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
    for (const id of c.members) if (id !== me().id) emitToUser(id, 'typing', { channelId, parentId: parentId || null, userId: me().id });
  });

  socket.on('channel:create', ({ name, topic, parentId }, cb) => {
    try { const c = createChannel(me(), { name, topic, parentId }); ok(cb, { id: c.id }); } catch (e) { fail(cb, e); }
  });

  socket.on('channel:join', ({ channelId }, cb) => {
    const c = db.channels[channelId];
    if (!c || c.isDM) return cb?.({ error: 'Not found' });
    // Joining a main channel also joins its active sub-channels.
    const subs = Object.values(db.channels).filter((x) => x.parentId === c.id && !x.archived);
    for (const ch of [c, ...subs]) {
      if (!ch.members.includes(me().id)) ch.members.push(me().id);
      emitToChannel(ch, 'channel:members', { channelId: ch.id, members: ch.members });
      socket.emit('channel:joined', channelView(ch, me()));
    }
    save();
    cb?.({ id: c.id });
  });

  socket.on('channel:leave', ({ channelId }) => {
    const c = db.channels[channelId];
    if (!c || c.isDM) return;
    const subs = Object.values(db.channels).filter((x) => x.parentId === c.id);
    for (const ch of [c, ...subs]) {
      if (!ch.members.includes(me().id)) continue;
      ch.members = ch.members.filter((id) => id !== me().id);
      socket.emit('channel:left', { channelId: ch.id, ...browseView(ch) });
      emitToChannel(ch, 'channel:members', { channelId: ch.id, members: ch.members });
    }
    save();
  });

  socket.on('channel:topic', ({ channelId, topic }) => {
    const c = db.channels[channelId];
    if (!canSee(me(), c)) return;
    c.topic = String(topic || '').slice(0, 200);
    save();
    emitToChannel(c, 'channel:topic', { channelId, topic: c.topic });
  });

  socket.on('channel:archive', ({ channelId, archived }, cb) => {
    const c = db.channels[channelId];
    if (!c || c.isDM || c.isDefault) return cb?.({ error: 'This channel cannot be archived.' });
    if (c.createdBy !== me().id && !me().isAdmin) return cb?.({ error: 'Only the person who created it or an admin can archive this channel.' });
    c.archived = !!archived;
    save();
    io.emit('channel:archived', { channelId: c.id, archived: c.archived });
    cb?.({ ok: true });
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
      for (const m of members) emitToUser(m, 'channel:joined', channelView(c, db.users[m]));
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

  // Notification preferences: per-channel level, sound and pause.
  socket.on('prefs:update', (patch, cb) => {
    const prefs = prefsOf(me());
    if (patch?.channelId && LEVELS.includes(patch.level)) prefs.notify[patch.channelId] = patch.level;
    if (patch?.channelId && patch.level === null) delete prefs.notify[patch.channelId];
    if (SOUNDS.includes(patch?.sound)) prefs.sound = patch.sound;
    if (typeof patch?.pauseUntil === 'number') prefs.pauseUntil = Math.max(0, patch.pauseUntil);
    save();
    emitToUser(me().id, 'prefs', prefs); // keep the user's other devices in sync
    cb?.({ prefs });
  });

  socket.on('search', ({ q }, cb) => {
    const term = String(q || '').toLowerCase().trim();
    if (term.length < 2) return cb?.({ results: [] });
    const visible = new Set(Object.values(db.channels).filter((c) => c.members.includes(me().id)).map((c) => c.id));
    const results = db.messages
      .filter((m) => visible.has(m.channelId) && !m.deleted && m.text.toLowerCase().includes(term))
      .slice(-40).reverse().map(messageView);
    cb?.({ results });
  });

  // ----- Admin: AI assistants (bots) that connect over MCP -----
  socket.on('bot:list', (_, cb) => {
    if (!me().isAdmin) return cb?.({ error: 'Admins only.' });
    cb?.({ bots: botList() });
  });
  socket.on('bot:create', ({ name }, cb) => {
    if (!me().isAdmin) return cb?.({ error: 'Admins only.' });
    const clean = String(name || 'Grok').trim().slice(0, 40) || 'Grok';
    if (Object.values(db.users).some((u) => !u.disabled && u.name.toLowerCase() === clean.toLowerCase())) return cb?.({ error: 'Someone already uses that name.' });
    const id = uid();
    db.users[id] = { id, name: clean, email: '', title: 'AI assistant', color: '#1f1f1f', isBot: true, isAdmin: false, lastRead: {}, createdAt: Date.now() };
    const key = 'khq_' + crypto.randomBytes(24).toString('base64url');
    db.botTokens[sha256(key)] = { userId: id, createdAt: Date.now(), createdBy: me().id, hint: key.slice(0, 8) + '…' + key.slice(-4) };
    for (const c of Object.values(db.channels)) if (c.isDefault) { c.members.push(id); emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members }); }
    save();
    io.emit('user:new', publicUser(db.users[id]));
    cb?.({ bot: { id, name: clean }, key });
  });
  socket.on('bot:revoke', ({ botId }, cb) => {
    if (!me().isAdmin) return cb?.({ error: 'Admins only.' });
    const u = db.users[botId];
    if (!u?.isBot) return cb?.({ error: 'Not found' });
    for (const [hash, rec] of Object.entries(db.botTokens)) if (rec.userId === botId) delete db.botTokens[hash];
    u.disabled = true;
    save();
    io.emit('user:remove', { id: botId });
    cb?.({ ok: true });
  });

  // ----- Admin: Follow Up Boss lead alerts -----
  const adminOnly = (fn) => async (data, cb) => {
    if (!me().isAdmin) return cb?.({ error: 'Admins only.' });
    try { cb?.({ ok: true, ...(await fn(data || {})) }); } catch (e) { cb?.({ error: e.message }); }
  };
  socket.on('fub:status', adminOnly(async () => ({ status: integrations.status() })));
  socket.on('fub:connect', adminOnly(async (d) => ({ status: await integrations.connect(d) })));
  socket.on('fub:disconnect', adminOnly(async () => ({ status: await integrations.disconnect() })));
  socket.on('fub:test', adminOnly(async () => integrations.test()));

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

function flushAndExit() {
  try { if (saveTimer) { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(db)); } } catch {}
  process.exit(0);
}
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);

server.listen(PORT, () => console.log(`${WORKSPACE_NAME} running on http://localhost:${PORT}`));
