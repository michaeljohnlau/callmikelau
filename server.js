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
const { mountTasks, dueInDays } = require('./tasks');

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
for (const rec of Object.values(db.botTokens)) {
  const b = db.users?.[rec.userId];
  if (b && b.isBot && !b.integration && !b.access) { b.access = 'full'; b.isAdmin = true; }
}
db.goals = db.goals || {};   // { [year]: { [userId]: { goalGci, goalDeals, closedGci, closedDeals, pendingGci, pendingDeals } } }
db.urgent = db.urgent || []; // custom urgent items added by the team
db.settings = db.settings || {}; // admin settings: inviteCode, workspaceName, logo, showName

// Checklist templates (editable by admins). Lines starting with "#" are section headings.
const DEFAULT_TEMPLATES = {
  listing: { id: 'listing', name: 'New listing', text: [
    '# Before listing',
    'Listing agreement signed',
    'FINTRAC ID verification completed',
    'CMA & pricing strategy reviewed with seller',
    'Pre-listing repairs & staging plan agreed',
    'Room measurements & floor plan',
    'Photos, video & drone booked',
    '# Launch',
    'Listing remarks & feature sheet written',
    'MLS listing submitted & double-checked',
    'Lockbox, sign & showing system set up',
    'Instagram Reel, post & stories',
    'Email to database & agent network',
    'First open house scheduled',
    '# On the market',
    'Weekly seller report sent',
    'Showing feedback collected & shared',
    '# Offer to close',
    'Offers reviewed with seller',
    'Conditions tracked until waived',
    'Sold sign & "Just Sold" marketing',
    'Closing gift & review request',
  ].join('\n') },
  openhouse: { id: 'openhouse', name: 'Open house', text: [
    '# Open house: before',
    'Open house added to MLS & showing system',
    'Social post & story announcing it',
    'Invite neighbours (door knock or flyers)',
    'Directional signs ready',
    'QR sign-in sheet & feature sheets printed',
    'Home prepped: lights on, music, fresh scent',
    '# Open house: on the day',
    'Greet every visitor & collect contact info',
    'Note buyer feedback',
    '# Open house: after',
    'Add every visitor to Follow Up Boss',
    'Follow up with every visitor within 24 hours',
    'Send the seller an open house recap',
  ].join('\n') },
};
db.checklistTemplates = db.checklistTemplates || JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));

const inviteCode = () => (db.settings.inviteCode || INVITE_CODE || '').trim();
const workspaceName = () => db.settings.workspaceName || WORKSPACE_NAME;
const branding = () => ({
  name: workspaceName(),
  logo: db.settings.logo === 'none' ? '' : db.settings.logo ? '/uploads/' + db.settings.logo : '/brand/logo.png',
  showName: db.settings.showName === true,
});

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
  return { id: u.id, avatar: u.avatar ? '/uploads/' + u.avatar : '', name: u.name, email: u.isBot ? '' : u.email, title: u.title || '', color: u.color, isAdmin: !!u.isAdmin, isBot: !!u.isBot, integration: u.integration || null, status: u.status || '' };
}

function prefsOf(u) {
  u.prefs = u.prefs || {};
  u.prefs.notify = u.prefs.notify || {};
  if (!SOUNDS.includes(u.prefs.sound)) u.prefs.sound = 'chime';
  u.prefs.pauseUntil = u.prefs.pauseUntil || 0;
  u.prefs.quiet = { on: true, start: '21:00', end: '07:00', ...(u.prefs.quiet || {}) };
  u.prefs.summary = { on: true, time: '07:30', ...(u.prefs.summary || {}) };
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
  if (channel.isDM) return false;
  if (user.integration) return true; // e.g. Follow Up Boss can post lead alerts to any channel it's set up for
  return !!user.isBot && !channel.isPrivate; // AI assistants can read public channels only
}
// Channels a person can find in "Browse": public ones, plus private ones for admins.
const canBrowse = (user, c) => !c.isDM && !c.members.includes(user.id) && (!c.isPrivate || user.isAdmin);

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
    checklist: c.checklist || null, isPrivate: !!c.isPrivate, stage: c.stage || null, links: c.links || null,
  };
}
const browseView = (c) => ({ id: c.id, name: c.name, label: c.label || '', topic: c.topic, parentId: c.parentId || null, archived: !!c.archived, isPrivate: !!c.isPrivate, memberCount: c.members.length });

function messageView(m) {
  return {
    id: m.id, channelId: m.channelId, userId: m.userId, text: m.deleted ? '' : m.text, ts: m.ts,
    parentId: m.parentId || null, edited: !!m.edited, deleted: !!m.deleted,
    reactions: m.reactions || {}, replyCount: m.replyCount || 0, lastReplyTs: m.lastReplyTs || null,
    pinned: !!m.pinned, mentions: m.mentions || [],
    tasks: m.tasks || null, leadType: m.leadType || null, lead: m.lead || null, hot: !!m.hot,
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

function badgeCount(u) {
  let total = 0;
  for (const c of Object.values(db.channels)) {
    if (!c.members.includes(u.id)) continue;
    const lvl = levelFor(u, c);
    if (lvl === 'mute') continue;
    const last = u.lastRead?.[c.id] || 0;
    for (const m of db.messages) {
      if (m.channelId !== c.id || m.parentId || m.deleted || m.ts <= last || m.userId === u.id) continue;
      if (c.isDM || lvl === 'all' || (m.mentions || []).some((id) => id === u.id || id === '*')) total++;
    }
  }
  return total;
}

let quietCheck = () => false; // set by the tasks module
function pushTo(userId, payload) {
  const u = db.users[userId];
  if (!u?.push?.length || isWatching(userId)) return;
  if (!payload.urgent && quietCheck(u)) return; // quiet hours: it waits for the daily summary / next app open
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
    pushTo(id, { title: m.parentId ? `${where} (thread)` : where, body: m.text.slice(0, 180), channelId: c.id, tag: c.id, badge: badgeCount(db.users[id]) });
  }
}

function postMessage(user, channelId, text, parentId, opts = {}) {
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
  // Optional first-steps checklist (e.g. "Prepare CMA") and auto-pin, used for new leads.
  const tasks = (Array.isArray(opts.tasks) ? opts.tasks : []).map((t) => String(t || '').trim().slice(0, 200)).filter(Boolean).slice(0, 10);
  if (tasks.length && !parentId) {
    m.tasks = tasks.map((label) => ({ id: uid(), label, claimedBy: null, claimedAt: null, doneBy: null, doneAt: null }));
    m.autoUnpin = !!opts.pin;
  }
  if (opts.pin && !parentId) m.pinned = true;
  if (opts.leadType) m.leadType = String(opts.leadType).slice(0, 20);
  if (opts.lead && typeof opts.lead === 'object') {
    const l = opts.lead;
    m.lead = { personId: l.personId || null, name: String(l.name || '').slice(0, 80), url: String(l.url || '').slice(0, 300), type: l.type || null, address: String(l.address || '').slice(0, 160) };
  }
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
  if (!opts.silent) notifyRecipients(c, m, user);
  if (m.tasks || m.lead) dashboardChanged();
  return m;
}

// Claim / complete a first-step task. Posts a short thread reply so the whole team sees who's on it.
function updateTask(user, messageId, taskId, action) {
  const m = db.messages.find((x) => x.id === messageId);
  const c = m && db.channels[m.channelId];
  if (!m || !canSee(user, c)) throw new Error('Message not found.');
  const t = (m.tasks || []).find((x) => x.id === taskId);
  if (!t) throw new Error('Task not found.');
  const name = (id) => db.users[id]?.name || 'someone';
  let note = null;
  if (action === 'claim') {
    if (t.claimedBy && t.claimedBy !== user.id) throw new Error(`${name(t.claimedBy)} already has this one.`);
    if (t.claimedBy === user.id) return m;
    t.claimedBy = user.id; t.claimedAt = Date.now();
    note = `🙋 I'm on it: **${t.label}**`;
  } else if (action === 'unclaim') {
    if (t.claimedBy !== user.id && !user.isAdmin) throw new Error('Only the person who claimed it (or an admin) can release it.');
    t.claimedBy = null; t.claimedAt = null;
    note = `↩️ Released: **${t.label}**. Who can take it?`;
  } else if (action === 'done') {
    if (t.doneBy) return m;
    t.doneBy = user.id; t.doneAt = Date.now();
    if (!t.claimedBy) { t.claimedBy = user.id; t.claimedAt = t.doneAt; }
    note = `✅ Done: **${t.label}**`;
  } else if (action === 'undo') {
    t.doneBy = null; t.doneAt = null;
    note = `🔄 Reopened: **${t.label}**`;
  } else throw new Error('Unknown action.');
  const allDone = m.tasks.every((x) => x.doneBy);
  if (allDone && m.pinned && m.autoUnpin) { m.pinned = false; note += '\n🎉 All first steps are done. Unpinned.'; }
  if (!allDone && action === 'undo' && m.autoUnpin && !m.pinned) m.pinned = true;
  save();
  emitToChannel(c, 'message:update', messageView(m));
  if (note) postMessage(user, c.id, note, m.id);
  dashboardChanged();
  return m;
}

// ---------- Dashboard: forecast, goals, urgent items, hot leads ----------
const currentYear = () => Number(new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', year: 'numeric' }));
const GOAL_FIELDS = ['goalGci', 'goalDeals', 'closedGci', 'closedDeals', 'pendingGci', 'pendingDeals'];
let hotFromFub = () => []; // replaced by the Follow Up Boss integration
let urgentExtra = () => []; // replaced by the tasks module

function dashboard(viewer) {
  const visible = (c) => !viewer || canSee(viewer, c);
  const year = currentYear();
  const g = db.goals[year] || {};
  const people = Object.values(db.users).filter((u) => !u.isBot && !u.disabled);
  const agents = people.map((u) => {
    const r = g[u.id] || {};
    const row = Object.fromEntries(GOAL_FIELDS.map((f) => [f, Number(r[f]) || 0]));
    return { userId: u.id, name: u.name, ...row, forecastGci: row.closedGci + row.pendingGci, forecastDeals: row.closedDeals + row.pendingDeals, updatedAt: r.updatedAt || null };
  });
  const sum = (f) => agents.reduce((n, a) => n + a[f], 0);
  const team = { goalGci: sum('goalGci'), goalDeals: sum('goalDeals'), closedGci: sum('closedGci'), closedDeals: sum('closedDeals'), pendingGci: sum('pendingGci'), pendingDeals: sum('pendingDeals') };
  team.forecastGci = team.closedGci + team.pendingGci;
  team.forecastDeals = team.closedDeals + team.pendingDeals;

  // Urgent: lead steps nobody has claimed, and claimed steps still open after 24 hours.
  const now = Date.now();
  const since = now - 30 * 864e5;
  const urgent = [];
  for (const m of db.messages) {
    if (!m.tasks || m.deleted || m.ts < since) continue;
    const c = db.channels[m.channelId];
    if (!c || c.archived || !visible(c)) continue;
    for (const t of m.tasks) {
      if (t.doneBy) continue;
      const overdue = t.claimedBy && now - (t.claimedAt || m.ts) > 864e5;
      if (t.claimedBy && !overdue) continue;
      urgent.push({
        kind: 'task', id: t.id, messageId: m.id, channelId: m.channelId, label: t.label,
        lead: m.lead?.name || '', since: t.claimedBy ? t.claimedAt : m.ts,
        status: t.claimedBy ? `Overdue · ${db.users[t.claimedBy]?.name.split(' ')[0] || ''}` : 'Needs an owner',
      });
    }
  }
  for (const u of db.urgent) {
    if (u.doneAt) continue;
    urgent.push({ kind: 'custom', id: u.id, label: u.text, link: u.link || '', since: u.createdAt, status: `Added by ${db.users[u.createdBy]?.name.split(' ')[0] || 'team'}` });
  }
  urgent.sort((a, b) => (a.kind === 'custom' ? 0 : 1) - (b.kind === 'custom' ? 0 : 1) || a.since - b.since);

  // Hot leads: "Hot" in Follow Up Boss (stage or tag), plus leads the team marked 🔥 in the app.
  const hot = [];
  const seen = new Set();
  for (const h of hotFromFub()) { if (!seen.has(h.personId)) { seen.add(h.personId); hot.push(h); } }
  for (const m of db.messages) {
    if (!m.hot || m.deleted || !m.lead || !visible(db.channels[m.channelId])) continue;
    const key = m.lead.personId || m.id;
    if (seen.has(key)) continue;
    seen.add(key);
    hot.push({ personId: m.lead.personId, name: m.lead.name, detail: [m.lead.type && m.lead.type[0].toUpperCase() + m.lead.type.slice(1), m.lead.address].filter(Boolean).join(' · '), url: m.lead.url, messageId: m.id, channelId: m.channelId, source: 'team' });
  }
  urgent.push(...urgentExtra(viewer));
  urgent.sort((a, b) => (a.kind === 'custom' ? 0 : 1) - (b.kind === 'custom' ? 0 : 1) || a.since - b.since);
  return { year, team, agents, urgent: urgent.slice(0, 30), hot: hot.slice(0, 40) };
}

let dashTimer = null;
function dashboardChanged() {
  if (dashTimer || !io) return;
  dashTimer = setTimeout(() => {
    dashTimer = null;
    for (const s of io.sockets.sockets.values()) { const u = db.users[s.data.userId]; if (u) s.emit('dashboard', dashboard(u)); }
  }, 250);
}

function parseTemplate(t) {
  let section = '';
  const items = [];
  for (const raw of String(t?.text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { section = line.replace(/^#+\s*/, '').slice(0, 60); continue; }
    const due = /\s*\|\s*(\d{1,3})\s*d(?:ays?)?\s*$/i.exec(line);
    const label = (due ? line.slice(0, due.index) : line).replace(/^[-*•]\s*/, '').trim().slice(0, 160);
    if (label) items.push({ section, label, dueDays: due ? Number(due[1]) : null });
  }
  return items.slice(0, 100);
}

function applyTemplate(c, templateId, user) {
  const t = db.checklistTemplates[templateId];
  if (!t) throw new Error('Checklist template not found.');
  c.checklist = c.checklist || [];
  const items = parseTemplate(t);
  for (const it of items) {
    c.checklist.push({
      id: uid(), label: it.label, section: it.section, doneBy: null, doneAt: null, addedBy: user?.id || null, custom: false,
      assigneeId: null, dueAt: it.dueDays !== null ? dueInDays(it.dueDays) : null, handoff: null, blocked: null, sourceMessageId: null, createdAt: Date.now(),
    });
  }
  c.checklist = c.checklist.slice(0, 200);
  return items.length;
}

function checklistChanged(c) {
  save();
  emitToChannel(c, 'channel:checklist', { channelId: c.id, checklist: c.checklist || null });
}

function createChannel(user, { name, topic, parentId, templateId, isPrivate, memberIds }) {
  const parent = parentId ? db.channels[parentId] : null;
  if (parentId && (!parent || parent.isDM || parent.parentId)) throw new Error('Sub-channels can only be added under a main channel.');
  if (parent && !canSee(user, parent)) throw new Error('Join the parent channel first.');
  const label = String(name || '').trim().replace(/^#/, '').slice(0, 80);
  const slug = channelSlug(label);
  if (!slug) throw new Error('Give the channel a name.');
  const clash = Object.values(db.channels).some((c) => !c.isDM && (c.parentId || null) === (parentId || null) && c.name === slug);
  if (clash) throw new Error(parent ? `#${parent.name} already has a sub-channel with that name.` : 'That channel already exists.');
  const id = uid();
  // Private channels: only the people chosen (sub-channels of a private channel are private too).
  const priv = !!isPrivate || !!parent?.isPrivate;
  const chosen = Array.isArray(memberIds) ? memberIds.filter((mid) => db.users[mid] && !db.users[mid].disabled && !db.users[mid].integration) : null;
  let members;
  if (priv && chosen) members = [...new Set([...chosen, user.id])];
  else if (parent) members = [...new Set([...parent.members.filter((mid) => !db.users[mid]?.isBot), user.id])];
  else members = [user.id];
  const c = {
    id, name: slug, label: parent && label !== slug ? label : '', topic: String(topic || '').slice(0, 200), isDM: false,
    members, createdBy: user.id, createdAt: Date.now(), parentId: parent ? parent.id : null, isPrivate: priv,
  };
  // Sub-channels under #listings get the "New listing" checklist unless told otherwise.
  if (templateId === undefined && parent?.name === 'listings' && db.checklistTemplates.listing) templateId = 'listing';
  if (templateId && db.checklistTemplates[templateId]) {
    applyTemplate(c, templateId, user);
    c.appliedTemplates = [templateId];
    if (templateId === 'listing') c.stage = 'listing';
  }
  db.channels[id] = c;
  save();
  for (const mid of members) emitToUser(mid, 'channel:joined', channelView(c, db.users[mid]));
  for (const s of io.sockets.sockets.values()) { const u = db.users[s.data.userId]; if (u && canBrowse(u, c)) s.emit('channel:available', browseView(c)); }
  return c;
}

// ---------- HTTP ----------
const app = express();

// ----- Uploads: profile photos and the workspace logo (resized in the browser first, so they stay small) -----
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '365d', immutable: true, fallthrough: false }));

function decodeImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Please choose a PNG, JPG or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1.5 * 1024 * 1024) throw new Error('That image is too large.');
  const sig = buf.subarray(0, 12).toString('hex');
  const ok = (m[1] === 'png' && sig.startsWith('89504e47')) || (m[1] === 'jpeg' && sig.startsWith('ffd8ff')) || (m[1] === 'webp' && sig.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP');
  if (!ok) throw new Error('That file is not a valid image.');
  return { buf, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
}
function removeUpload(file) {
  if (!file || file.includes('/') || file.includes('..')) return;
  fs.unlink(path.join(UPLOAD_DIR, file), () => {});
}

app.post('/api/upload', express.json({ limit: '2mb' }), (req, res) => {
  const user = userFromToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  const { kind, dataUrl, remove } = req.body || {};
  try {
    if (kind === 'avatar') {
      const old = user.avatar;
      if (remove) user.avatar = '';
      else {
        const { buf, ext } = decodeImage(dataUrl);
        const file = `a-${user.id}-${Date.now().toString(36)}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
        user.avatar = file;
      }
      removeUpload(old);
      save();
      io.emit('user:update', publicUser(user));
      return res.json({ ok: true, avatar: user.avatar ? '/uploads/' + user.avatar : '' });
    }
    if (kind === 'logo') {
      if (!user.isAdmin) return res.status(403).json({ error: 'Admins only.' });
      const old = db.settings.logo;
      if (req.body.reset) db.settings.logo = '';
      else if (remove) db.settings.logo = 'none';
      else {
        const { buf, ext } = decodeImage(dataUrl);
        const file = `logo-${Date.now().toString(36)}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
        db.settings.logo = file;
      }
      removeUpload(old);
      save();
      io.emit('branding', branding());
      return res.json({ ok: true, branding: branding() });
    }
    res.status(400).json({ error: 'Unknown upload.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true, storage: storage.persistent ? 'persistent' : 'NOT persistent: data is erased on every update/restart', users: Object.values(db.users).filter((u) => !u.isBot).length, messages: db.messages.length }));

app.get('/api/config', (req, res) => {
  const hasUsers = Object.values(db.users).some((u) => !u.isBot);
  res.json({ workspace: workspaceName(), branding: branding(), inviteRequired: !!inviteCode() && (hasUsers || !!INVITE_CODE), hasUsers });
});

app.get('/api/push-key', (req, res) => res.json({ key: vapid.publicKey }));

app.post('/api/register', (req, res) => {
  const { name, email, password, title, invite } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName || !cleanEmail || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const needsCode = !!inviteCode() && (Object.values(db.users).some((u) => !u.isBot) || !!INVITE_CODE);
  if (needsCode && String(invite || '').trim().toLowerCase() !== inviteCode().toLowerCase()) return res.status(403).json({ error: 'That sign-up code is not right. Ask your team leader for it.' });
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
  dashboardChanged();
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

// Sign out everywhere: ends every session for this person (lost phone, shared computer) and
// stops push notifications to all their devices.
app.post('/api/logout-all', (req, res) => {
  const user = userFromToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  let ended = 0;
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === user.id) { delete db.sessions[t]; ended++; }
  user.push = [];
  save();
  for (const s of io.sockets.sockets.values()) if (s.data.userId === user.id) { s.emit('signed-out'); s.disconnect(true); }
  res.json({ ok: true, ended });
});

// MCP endpoint for AI assistants (Grok, Claude, etc.), authenticated with a bot key.
mountMcp(app, {
  botAction: (bot, event, payload) => botAction(bot, event, payload),
  fubPerson: (id) => integrations.getPerson(id),
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
  canSee, displayName, messageView, postMessage, createChannel, channelSlug, updateTask,
  checklistChanged, applyTemplate, uid, templates: () => db.checklistTemplates,
  dashboard: (viewer) => dashboard(viewer),
  get tasks() { return tasks; },
});

const integrations = mountIntegrations(app, {
  get db() { return db; },
  save, postMessage, publicUser, dashboardChanged,
  io: () => io,
});
hotFromFub = () => integrations.hotLeads();

const tasks = mountTasks({
  get db() { return db; },
  save, uid, canSee, displayName, postMessage, pushTo, prefsOf, publicUser, applyTemplate, checklistChanged, dashboardChanged,
  emitToChannel, emitToUser, channelView: (c, u) => channelView(c, u), io: () => io,
  fubPerson: (id) => integrations.getPerson(id),
});
quietCheck = (u) => tasks.inQuietHours(u);
urgentExtra = (viewer) => tasks.urgentFor(viewer);

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
    return u && !u.disabled ? { id: u.id, name: u.name, createdAt: rec.createdAt, lastUsed: rec.lastUsed || null, keyHint: rec.hint, access: u.access || 'standard' } : null;
  }).filter(Boolean);
}

// ---------- AI assistants act through the same actions as people ----------
// Each bot gets a "virtual" connection that runs the exact same handlers the app uses,
// so a bot can do what a person can, with the same rules. Only the actions below are open
// to bots; owner-level settings (bot keys, sign-up code, Follow Up Boss, templates) never are.
const BOT_ACTIONS = new Set([
  'history', 'thread', 'search', 'today:get',
  'message:send', 'message:edit', 'message:delete', 'message:pin', 'reaction', 'read', 'dm:open',
  'channel:create', 'channel:join', 'channel:leave', 'channel:topic', 'channel:addMembers',
  'channel:links', 'channel:stage',
  'checklist:toggle', 'checklist:add', 'checklist:remove', 'checklist:apply',
  'task:create', 'task:edit', 'task:update', 'lead:hot',
  'urgent:add', 'urgent:done',
  // full access only:
  'channel:archive', 'channel:delete', 'channel:privacy', 'channel:removeMember', 'checklist:clear',
  'goal:update', 'team:get', 'task:nudge',
]);
const FULL_ONLY = new Set(['channel:archive', 'channel:delete', 'channel:privacy', 'channel:removeMember', 'checklist:clear', 'goal:update', 'team:get', 'task:nudge']);
const botSockets = new Map();
function botSocket(bot) {
  let s = botSockets.get(bot.id);
  if (s) return s;
  const handlers = {};
  s = { virtual: true, data: { userId: bot.id }, handshake: { auth: {} }, join() {}, emit() {}, broadcast: { emit() {} }, on(ev, fn) { handlers[ev] = fn; }, handlers };
  onConnection(s);
  botSockets.set(bot.id, s);
  return s;
}
function botAction(bot, event, payload = {}) {
  if (!BOT_ACTIONS.has(event)) return Promise.resolve({ error: 'That action is not available to assistants.' });
  if (FULL_ONLY.has(event) && bot.access !== 'full') return Promise.resolve({ error: 'This assistant has standard access. An admin can give it full access in Settings → AI & API.' });
  const fn = botSocket(bot).handlers[event];
  if (!fn) return Promise.resolve({ error: 'Unknown action.' });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r || { ok: true }); } };
    try {
      const out = fn(payload, finish);
      Promise.resolve(out).then(() => setTimeout(() => finish({ ok: true }), 30), (e) => finish({ error: e.message }));
    } catch (e) { finish({ error: e.message }); }
  });
}

io.on('connection', onConnection);
function onConnection(socket) {
  const me = () => db.users[socket.data.userId];
  const user = me();
  if (!socket.virtual) {
    socket.join('u:' + user.id);
    online.set(user.id, (online.get(user.id) || 0) + 1);
    io.emit('presence', { userId: user.id, online: true });
  }

  const ok = (cb, data = {}) => cb?.({ ok: true, ...data });
  const fail = (cb, err) => cb?.({ error: err.message || String(err) });

  socket.emit('init', {
    workspace: workspaceName(),
    branding: branding(),
    templates: Object.values(db.checklistTemplates).map((t) => ({ id: t.id, name: t.name })),
    me: publicUser(user),
    storageWarning: user.isAdmin ? storage.warning : null,
    prefs: prefsOf(user),
    dashboard: dashboard(user),
    users: Object.values(db.users).filter((u) => !u.disabled).map(publicUser),
    online: [...online.keys()],
    channels: Object.values(db.channels).filter((c) => c.members.includes(user.id)).map((c) => channelView(c, user)),
    browse: Object.values(db.channels).filter((c) => canBrowse(user, c)).map(browseView),
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

  // ----- Dashboard -----
  socket.on('goal:update', ({ userId, values }, cb) => {
    const target = userId || me().id;
    if (target !== me().id && !me().isAdmin) return cb?.({ error: 'You can only edit your own goal.' });
    if (!db.users[target] || db.users[target].isBot) return cb?.({ error: 'Not found' });
    const year = currentYear();
    db.goals[year] = db.goals[year] || {};
    const row = db.goals[year][target] || {};
    for (const f of GOAL_FIELDS) {
      if (values?.[f] === undefined) continue;
      const n = Math.round(Number(String(values[f]).replace(/[$,\s]/g, '')));
      if (!Number.isFinite(n) || n < 0 || n > 1e10) return cb?.({ error: 'Please enter numbers only.' });
      row[f] = n;
    }
    row.updatedAt = Date.now();
    db.goals[year][target] = row;
    save();
    dashboardChanged();
    cb?.({ ok: true });
  });

  socket.on('urgent:add', ({ text, link }, cb) => {
    const t = String(text || '').trim().slice(0, 140);
    if (!t) return cb?.({ error: 'Describe the urgent item.' });
    const l = String(link || '').trim();
    db.urgent.push({ id: uid(), text: t, link: /^https?:\/\//.test(l) ? l.slice(0, 300) : '', createdBy: me().id, createdAt: Date.now(), doneAt: null });
    if (db.urgent.length > 300) db.urgent = db.urgent.filter((u) => !u.doneAt || Date.now() - u.doneAt < 30 * 864e5);
    save();
    dashboardChanged();
    cb?.({ ok: true });
  });

  socket.on('urgent:done', ({ id }, cb) => {
    const u = db.urgent.find((x) => x.id === id);
    if (!u) return cb?.({ error: 'Not found' });
    u.doneAt = Date.now();
    u.doneBy = me().id;
    save();
    dashboardChanged();
    cb?.({ ok: true });
  });

  socket.on('lead:hot', ({ messageId, hot }, cb) => {
    const m = db.messages.find((x) => x.id === messageId);
    if (!m || !m.lead || !canSee(me(), db.channels[m.channelId])) return cb?.({ error: 'Not found' });
    m.hot = !!hot;
    save();
    emitToChannel(db.channels[m.channelId], 'message:update', messageView(m));
    dashboardChanged();
    cb?.({ ok: true });
  });

  // ----- Channel checklists -----
  const clChannel = (channelId) => {
    const c = db.channels[channelId];
    if (!canSee(me(), c)) throw new Error('Channel not found.');
    return c;
  };
  const clHandler = (fn) => (data, cb) => { try { fn(data || {}); cb?.({ ok: true }); } catch (e) { cb?.({ error: e.message }); } };
  socket.on('checklist:toggle', clHandler(({ channelId, itemId }) => {
    const c = clChannel(channelId);
    const it = (c.checklist || []).find((x) => x.id === itemId);
    if (!it) throw new Error('Task not found.');
    tasks.editTask(me(), { channelId, itemId, done: !it.doneBy });
  }));
  socket.on('checklist:add', clHandler(({ channelId, label, section }) => {
    const c = clChannel(channelId);
    const l = String(label || '').trim().slice(0, 160);
    if (!l) throw new Error('Type the task first.');
    c.checklist = c.checklist || [];
    if (c.checklist.length >= 200) throw new Error('This checklist is full.');
    c.checklist.push({ id: uid(), label: l, section: String(section || 'Our tasks').slice(0, 60), doneBy: null, doneAt: null, addedBy: me().id, custom: true, assigneeId: null, dueAt: null, handoff: null, blocked: null, sourceMessageId: null, createdAt: Date.now() });
    checklistChanged(c);
  }));
  socket.on('checklist:remove', clHandler(({ channelId, itemId }) => {
    const c = clChannel(channelId);
    const it = (c.checklist || []).find((x) => x.id === itemId);
    if (!it) throw new Error('Task not found.');
    if (it.addedBy !== me().id && c.createdBy !== me().id && !me().isAdmin) throw new Error('Only the person who added it, the channel creator or an admin can remove this task.');
    c.checklist = c.checklist.filter((x) => x.id !== itemId);
    checklistChanged(c);
  }));
  socket.on('checklist:apply', clHandler(({ channelId, templateId }) => {
    const c = clChannel(channelId);
    applyTemplate(c, templateId, me());
    c.appliedTemplates = [...new Set([...(c.appliedTemplates || []), templateId])];
    checklistChanged(c);
    dashboardChanged();
  }));
  socket.on('checklist:clear', clHandler(({ channelId }) => {
    const c = clChannel(channelId);
    if (c.createdBy !== me().id && !me().isAdmin) throw new Error('Only the channel creator or an admin can remove the checklist.');
    c.checklist = null;
    checklistChanged(c);
  }));

  // ----- Admin: checklist templates & workspace settings -----
  tasks.registerSocket(socket, me);
  socket.on('templates:get', (_, cb) => cb?.({ templates: Object.values(db.checklistTemplates) }));
  socket.on('templates:save', ({ templates }, cb) => {
    if (!me().isAdmin || me().isBot) return cb?.({ error: 'Admins only.' });
    const next = {};
    for (const t of (Array.isArray(templates) ? templates : []).slice(0, 20)) {
      const name = String(t?.name || '').trim().slice(0, 40);
      if (!name) continue;
      const id = /^[a-z0-9_-]{2,30}$/.test(t.id || '') ? t.id : channelSlug(name).slice(0, 30) || uid();
      next[id] = { id, name, text: String(t.text || '').slice(0, 8000) };
    }
    if (!Object.keys(next).length) return cb?.({ error: 'Keep at least one checklist.' });
    // Remember built-in checklists an admin deleted, so they don't come back on the next update.
    db.settings.deletedTemplates = [...new Set([...(db.settings.deletedTemplates || []), ...Object.keys(db.checklistTemplates).filter((id) => !next[id])])];
    db.checklistTemplates = next;
    save();
    io.emit('templates', Object.values(next).map((t) => ({ id: t.id, name: t.name })));
    cb?.({ ok: true });
  });
  socket.on('settings:get', (_, cb) => {
    if (!me().isAdmin || me().isBot) return cb?.({ error: 'Admins only.' });
    cb?.({ inviteCode: inviteCode(), envCode: !!INVITE_CODE && !db.settings.inviteCode, workspaceName: workspaceName(), showName: db.settings.showName === true });
  });
  socket.on('settings:update', (patch, cb) => {
    if (!me().isAdmin || me().isBot) return cb?.({ error: 'Admins only.' });
    if (patch?.inviteCode !== undefined) {
      const code = String(patch.inviteCode).trim().slice(0, 40);
      if (code && code.length < 4) return cb?.({ error: 'Use at least 4 characters for the sign-up code.' });
      db.settings.inviteCode = code;
    }
    if (patch?.workspaceName !== undefined) db.settings.workspaceName = String(patch.workspaceName).trim().slice(0, 40) || '';
    if (patch?.showName !== undefined) db.settings.showName = !!patch.showName;
    save();
    io.emit('branding', branding());
    cb?.({ ok: true });
  });

  socket.on('task:update', ({ messageId, taskId, action }, cb) => {
    try { updateTask(me(), messageId, taskId, action); cb?.({ ok: true }); } catch (e) { cb?.({ error: e.message }); }
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

  socket.on('channel:create', ({ name, topic, parentId, templateId, isPrivate, memberIds }, cb) => {
    try { const c = createChannel(me(), { name, topic, parentId, templateId, isPrivate, memberIds }); ok(cb, { id: c.id }); } catch (e) { fail(cb, e); }
  });

  // ----- Private channels: who can see a channel -----
  const canManage = (c) => c && !c.isDM && (c.createdBy === me().id || me().isAdmin);
  function grant(c, uid2) {
    if (c.members.includes(uid2)) return;
    c.members.push(uid2);
    emitToUser(uid2, 'channel:joined', channelView(c, db.users[uid2]));
  }
  function revoke(c, uid2) {
    if (!c.members.includes(uid2)) return;
    c.members = c.members.filter((x) => x !== uid2);
    const u = db.users[uid2];
    emitToUser(uid2, 'channel:removed', { channelId: c.id, browse: u && canBrowse(u, c) ? browseView(c) : null });
  }
  socket.on('channel:privacy', ({ channelId, isPrivate }, cb) => {
    const c = db.channels[channelId];
    if (!canManage(c)) return cb?.({ error: 'Only the person who created this channel or an admin can change who sees it.' });
    if (c.name === 'general' && !c.parentId && isPrivate) return cb?.({ error: '#general is always open to everyone.' });
    c.isPrivate = !!isPrivate;
    save();
    emitToChannel(c, 'channel:privacy', { channelId: c.id, isPrivate: c.isPrivate });
    for (const s of io.sockets.sockets.values()) {
      const u = db.users[s.data.userId];
      if (!u || c.members.includes(u.id)) continue;
      if (canBrowse(u, c)) s.emit('channel:available', browseView(c)); else s.emit('channel:removed', { channelId: c.id, browse: null });
    }
    dashboardChanged();
    cb?.({ ok: true });
  });
  socket.on('channel:addMembers', ({ channelId, userIds }, cb) => {
    const c = db.channels[channelId];
    if (!c || c.isDM || !canSee(me(), c)) return cb?.({ error: 'Not found' });
    if (c.isPrivate && !canManage(c)) return cb?.({ error: 'Only the person who created this channel or an admin can add people.' });
    const ids = (Array.isArray(userIds) ? userIds : []).filter((x) => db.users[x] && !db.users[x].disabled);
    for (const x of ids) {
      grant(c, x);
      // Adding someone to a channel also gives them its sub-channels that share its privacy.
      for (const sub of Object.values(db.channels)) if (sub.parentId === c.id && !sub.archived && !!sub.isPrivate === !!c.isPrivate) grant(sub, x);
    }
    save();
    emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members });
    dashboardChanged();
    cb?.({ ok: true });
  });
  socket.on('channel:removeMember', ({ channelId, userId }, cb) => {
    const c = db.channels[channelId];
    if (!canManage(c)) return cb?.({ error: 'Only the person who created this channel or an admin can remove people.' });
    if (userId === c.createdBy && !me().isAdmin) return cb?.({ error: "The channel's creator can't be removed." });
    revoke(c, userId);
    for (const sub of Object.values(db.channels)) if (sub.parentId === c.id && sub.isPrivate) revoke(sub, userId);
    save();
    emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members });
    dashboardChanged();
    cb?.({ ok: true });
  });

  socket.on('channel:join', ({ channelId }, cb) => {
    const c = db.channels[channelId];
    if (!c || c.isDM) return cb?.({ error: 'Not found' });
    if (c.isPrivate && !me().isAdmin) return cb?.({ error: 'This channel is private. Ask its creator to add you.' });
    // Joining a main channel also joins its active public sub-channels.
    const subs = Object.values(db.channels).filter((x) => x.parentId === c.id && !x.archived && !x.isPrivate);
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
      socket.emit('channel:removed', { channelId: ch.id, browse: canBrowse(me(), ch) ? browseView(ch) : null });
      emitToChannel(ch, 'channel:members', { channelId: ch.id, members: ch.members });
    }
    save();
    dashboardChanged();
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

  // Permanently delete a channel (and everything in it). Sub-channels first, then their main channel.
  socket.on('channel:delete', ({ channelId, confirm }, cb) => {
    const c = db.channels[channelId];
    if (!c || c.isDM) return cb?.({ error: 'Channel not found.' });
    if (c.isDefault) return cb?.({ error: `#${c.name} is a built-in channel and can't be deleted.` });
    if (c.createdBy !== me().id && !me().isAdmin) return cb?.({ error: 'Only the person who created this channel or an admin can delete it.' });
    if (String(confirm || '').trim().toUpperCase() !== 'DELETE') return cb?.({ error: 'Type DELETE to confirm.' });
    const subs = Object.values(db.channels).filter((x) => x.parentId === c.id);
    if (subs.length) return cb?.({ error: `#${c.name} still has ${subs.length} sub-channel${subs.length === 1 ? '' : 's'}. Delete ${subs.length === 1 ? 'it' : 'them'} first (archived ones too).` });
    if (db.integrations?.fub?.channelId === c.id) return cb?.({ error: 'Follow Up Boss posts new leads here. Pick a different channel in Settings → Integrations first.' });
    const removed = db.messages.filter((m) => m.channelId === c.id).length;
    db.messages = db.messages.filter((m) => m.channelId !== c.id);
    delete db.channels[c.id];
    for (const u of Object.values(db.users)) {
      if (u.lastRead) delete u.lastRead[c.id];
      if (u.prefs?.notify) delete u.prefs.notify[c.id];
    }
    save();
    io.emit('channel:deleted', { channelId: c.id, name: displayName(c), by: me().name });
    dashboardChanged();
    cb?.({ ok: true, removed });
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
    const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : null);
    if (patch?.quiet) {
      if (typeof patch.quiet.on === 'boolean') prefs.quiet.on = patch.quiet.on;
      if (hhmm(patch.quiet.start)) prefs.quiet.start = patch.quiet.start;
      if (hhmm(patch.quiet.end)) prefs.quiet.end = patch.quiet.end;
    }
    if (patch?.summary) {
      if (typeof patch.summary.on === 'boolean') prefs.summary.on = patch.summary.on;
      if (hhmm(patch.summary.time)) prefs.summary.time = patch.summary.time;
    }
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
    if (!me().isAdmin || me().isBot) return cb?.({ error: 'Admins only.' });
    cb?.({ bots: botList() });
  });
  socket.on('bot:access', ({ botId, access }, cb) => {
    if (!me().isAdmin || me().isBot) return cb?.({ error: 'Admins only.' });
    const u = db.users[botId];
    if (!u?.isBot || u.integration) return cb?.({ error: 'Not found' });
    u.access = access === 'full' ? 'full' : 'standard';
    u.isAdmin = u.access === 'full';
    save();
    io.emit('user:update', publicUser(u));
    cb?.({ ok: true });
  });
  socket.on('bot:create', ({ name, access }, cb) => {
    if (!me().isAdmin || me().isBot) return cb?.({ error: 'Admins only.' });
    const clean = String(name || 'Grok').trim().slice(0, 40) || 'Grok';
    if (Object.values(db.users).some((u) => !u.disabled && u.name.toLowerCase() === clean.toLowerCase())) return cb?.({ error: 'Someone already uses that name.' });
    const id = uid();
    const level = access === 'standard' ? 'standard' : 'full';
    db.users[id] = { id, name: clean, email: '', title: 'AI assistant', color: '#1f1f1f', isBot: true, isAdmin: level === 'full', access: level, lastRead: {}, createdAt: Date.now() };
    const key = 'khq_' + crypto.randomBytes(24).toString('base64url');
    db.botTokens[sha256(key)] = { userId: id, createdAt: Date.now(), createdBy: me().id, hint: key.slice(0, 8) + '…' + key.slice(-4) };
    for (const c of Object.values(db.channels)) if (c.isDefault) { c.members.push(id); emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members }); }
    save();
    io.emit('user:new', publicUser(db.users[id]));
    cb?.({ bot: { id, name: clean }, key });
  });
  socket.on('bot:revoke', ({ botId }, cb) => {
    if (!me().isAdmin || me().isBot) return cb?.({ error: 'Admins only.' });
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
    if (!me().isAdmin || me().isBot) return cb?.({ error: 'Admins only.' });
    try { cb?.({ ok: true, ...(await fn(data || {})) }); } catch (e) { cb?.({ error: e.message }); }
  };
  socket.on('fub:status', adminOnly(async () => ({ status: integrations.status() })));
  socket.on('fub:connect', adminOnly(async (d) => ({ status: await integrations.connect(d) })));
  socket.on('fub:disconnect', adminOnly(async () => ({ status: await integrations.disconnect() })));
  socket.on('fub:test', adminOnly(async () => integrations.test()));
  socket.on('fub:playbooks', adminOnly(async (d) => ({ status: integrations.savePlaybooks(d.playbooks) })));

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
}

function flushAndExit() {
  try { if (saveTimer) { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(db)); } } catch {}
  process.exit(0);
}
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);

server.listen(PORT, () => console.log(`${WORKSPACE_NAME} running on http://localhost:${PORT}`));
