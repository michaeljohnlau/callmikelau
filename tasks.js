// Tasks, handoffs, listing stages, record links, the "Today" screen and the daily summary.
//
// A task is a checklist item on a channel (a listing sub-channel, a DM, any channel), with:
//   assigneeId   who owns it
//   dueAt        when it's due (ms)
//   handoff      { fromId, note, at, state: 'pending' | 'accepted' | 'declined', reason }
//                Work passed to someone else waits for them to accept it.
//   blocked      { reason, by, at }   "blocked / needs a decision"
//   sourceMessageId   the chat message it was created from (the discussion stays attached)
//
// Follow Up Boss stays the client record: channels only store a link to the FUB contact and
// the app shows live details from FUB instead of keeping its own copy.

const TZ = 'America/Toronto';

// ---------- Toronto-time helpers ----------
const fmtParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function tzParts(ts) {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
function tzEpoch(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = tzParts(guess);
  const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - guess;
  return guess - off;
}
const dayStart = (ts) => { const p = tzParts(ts); return tzEpoch(p.y, p.m, p.d); };
const dayKey = (ts) => { const p = tzParts(ts); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const minutesOfDay = (ts) => { const p = tzParts(ts); return p.h * 60 + p.mi; };
const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null; };
// "Due in N days" from a template → that day at 5pm Toronto time.
function dueInDays(n, from = Date.now()) {
  const p = tzParts(from + n * 864e5);
  return tzEpoch(p.y, p.m, p.d, 17, 0);
}
function niceDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
}

// ---------- Listing stages ----------
const STAGES = [
  { id: 'listing', label: 'Listing', template: 'listing' },
  { id: 'offer', label: 'Offer accepted', template: 'offer' },
  { id: 'firm', label: 'Firm sale', template: 'firm' },
  { id: 'closing', label: 'Closing', template: 'closing' },
];

// Stage checklists added for existing workspaces too (admins can edit them in Settings).
// "| 2d" at the end of a line = due 2 days after the stage starts.
const STAGE_TEMPLATES = {
  offer: { id: 'offer', name: 'Offer accepted', text: [
    '# Offer accepted (conditional)',
    'Deposit delivered & receipt saved | 1d',
    'Accepted offer submitted to the brokerage | 1d',
    'Condition deadlines added to the calendar | 1d',
    'MLS updated to sold conditional | 1d',
    'Home inspection booked',
    'Financing condition followed up with the lender',
    'Client updated on the condition timeline | 2d',
  ].join('\n') },
  firm: { id: 'firm', name: 'Firm sale', text: [
    '# Firm sale',
    'Waiver / notice of fulfillment signed | 0d',
    'MLS updated to sold | 1d',
    'Firm deal documents sent to both lawyers | 1d',
    'Brokerage paperwork complete | 2d',
    '"Sold" sign installed | 2d',
    '"Just Sold" post & database email | 3d',
  ].join('\n') },
  closing: { id: 'closing', name: 'Closing', text: [
    '# Closing',
    'Closing date & time confirmed with both lawyers',
    'Final walkthrough booked',
    'Keys & access arranged',
    'Sign & lockbox removed',
    'Commission & trade record finalized',
    'Closing gift delivered',
    'Google review requested',
    'Client added to the past-client plan in Follow Up Boss',
  ].join('\n') },
};

function mountTasks(core) {
  const { db } = core;
  const now = () => Date.now();

  // Add the stage checklists to workspaces created before they existed.
  db.settings.deletedTemplates = db.settings.deletedTemplates || [];
  for (const [id, t] of Object.entries(STAGE_TEMPLATES)) {
    if (!db.checklistTemplates[id] && !db.settings.deletedTemplates.includes(id)) db.checklistTemplates[id] = { ...t };
  }

  const userName = (id) => db.users[id]?.name || 'Someone';
  const first = (id) => userName(id).split(' ')[0];

  function norm(it) {
    if (!('assigneeId' in it)) it.assigneeId = null;
    if (!('dueAt' in it)) it.dueAt = null;
    if (!('handoff' in it)) it.handoff = null;
    if (!('blocked' in it)) it.blocked = null;
    if (!('sourceMessageId' in it)) it.sourceMessageId = null;
    return it;
  }

  function channelFor(actor, channelId) {
    const c = db.channels[channelId];
    if (!c || !core.canSee(actor, c)) throw new Error('Channel not found.');
    if (c.archived) throw new Error('This channel is archived.');
    return c;
  }
  function itemFor(c, itemId) {
    const it = (c.checklist || []).find((x) => x.id === itemId);
    if (!it) throw new Error('Task not found.');
    return norm(it);
  }
  // Make sure the new owner can see the channel the task lives in.
  function ensureMember(c, userId) {
    if (c.members.includes(userId)) return;
    if (c.isPrivate || c.isDM) throw new Error(`${userName(userId)} isn't in this ${c.isDM ? 'conversation' : 'private channel'}. Add them first.`);
    c.members.push(userId);
    core.emitToUser(userId, 'channel:joined', core.channelView(c, db.users[userId]));
    core.emitToChannel(c, 'channel:members', { channelId: c.id, members: c.members });
  }

  const where = (c) => (c.isDM ? 'a direct message' : `#${core.displayName(c)}`);

  function notify(userId, title, body, c, urgent = false) {
    const u = db.users[userId];
    if (!u || u.isBot) return;
    core.pushTo(userId, { title, body: String(body || '').slice(0, 180), channelId: c?.id, tag: 'task-' + (c?.id || ''), urgent });
  }

  // Assigning to someone else = a handoff they have to accept.
  function assign(actor, c, it, toId, note) {
    if (!toId) { it.assigneeId = null; it.handoff = null; return; }
    const to = db.users[toId];
    if (!to || to.disabled) throw new Error('That person was not found.');
    if (to.isBot) throw new Error('Tasks can only be handed to people.');
    ensureMember(c, toId);
    if (it.assigneeId === toId && it.handoff?.state !== 'declined') return;
    it.assigneeId = toId;
    if (toId === actor.id) { it.handoff = null; return; }
    it.handoff = { fromId: actor.id, note: String(note || '').trim().slice(0, 300), at: now(), state: 'pending', reason: '' };
    notify(toId, `🤝 ${actor.name} handed you a task`, `${it.label}${it.handoff.note ? ` · "${it.handoff.note}"` : ''}`, c);
  }

  function parseDue(v) {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e12) return n;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v));
    if (!m) throw new Error('Use a date like 2026-11-14.');
    return tzEpoch(+m[1], +m[2], +m[3], m[4] ? +m[4] : 17, m[5] ? +m[5] : 0);
  }

  function changed(c) { core.checklistChanged(c); core.dashboardChanged(); }

  // ---------- Create ----------
  function createTask(actor, { channelId, label, assigneeId, dueAt, sourceMessageId, note, section }) {
    const c = channelFor(actor, channelId);
    let text = String(label || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!text) throw new Error('Describe the task.');
    let src = null;
    if (sourceMessageId) {
      src = db.messages.find((m) => m.id === sourceMessageId && m.channelId === c.id && !m.deleted);
      if (!src) throw new Error('The original message was not found.');
    }
    c.checklist = c.checklist || [];
    if (c.checklist.length >= 200) throw new Error('This channel has too many tasks.');
    const it = norm({ id: core.uid(), label: text, section: String(section || (src ? 'From the conversation' : 'Our tasks')).slice(0, 60), doneBy: null, doneAt: null, addedBy: actor.id, custom: true, createdAt: now() });
    it.sourceMessageId = src ? src.id : null;
    it.dueAt = parseDue(dueAt);
    c.checklist.push(it);
    assign(actor, c, it, assigneeId || null, note);
    changed(c);
    // Leave a note in the original conversation so the discussion and the task stay connected.
    if (src) {
      const owner = it.assigneeId ? (it.assigneeId === actor.id ? 'myself' : userName(it.assigneeId)) : 'no one yet';
      const due = it.dueAt ? ` · due ${niceDate(it.dueAt)}` : '';
      try { core.postMessage(actor, c.id, `☑ Made this a task for ${owner}${due}: **${text}**`, src.parentId || src.id, { silent: true }); } catch {}
    }
    return it;
  }

  // ---------- Edit / respond ----------
  function editTask(actor, { channelId, itemId, label, assigneeId, note, dueAt, blocked, done }) {
    const c = channelFor(actor, channelId);
    const it = itemFor(c, itemId);
    if (label !== undefined) {
      const l = String(label).trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!l) throw new Error('Describe the task.');
      it.label = l;
    }
    if (dueAt !== undefined) it.dueAt = parseDue(dueAt);
    if (blocked !== undefined) {
      if (blocked) {
        const reason = String(blocked).trim().slice(0, 300) || 'Needs a decision';
        const fresh = !it.blocked;
        it.blocked = { reason, by: actor.id, at: now() };
        // Let the owner (or whoever added it) know a decision is needed.
        if (fresh) for (const uid of new Set([it.assigneeId, it.addedBy])) if (uid && uid !== actor.id) notify(uid, `⛔ ${actor.name} flagged a blocker`, `${it.label}: ${reason}`, c);
      } else it.blocked = null;
    }
    if (assigneeId !== undefined) assign(actor, c, it, assigneeId || null, note);
    if (done !== undefined) {
      if (done && !it.doneBy) {
        it.doneBy = actor.id; it.doneAt = now();
        if (it.handoff?.state === 'pending' && it.assigneeId === actor.id) { it.handoff.state = 'accepted'; it.handoff.acceptedAt = now(); }
        it.blocked = null;
      } else if (!done) { it.doneBy = null; it.doneAt = null; }
    }
    changed(c);
    return it;
  }

  function respond(actor, { channelId, itemId, accept, reason }) {
    const c = channelFor(actor, channelId);
    const it = itemFor(c, itemId);
    if (it.assigneeId !== actor.id || it.handoff?.state !== 'pending') throw new Error('There is nothing waiting for you on this task.');
    const from = it.handoff.fromId;
    if (accept) {
      it.handoff.state = 'accepted';
      it.handoff.acceptedAt = now();
      notify(from, `✅ ${actor.name} accepted`, it.label, c);
    } else {
      const why = String(reason || '').trim().slice(0, 300);
      if (!why) throw new Error('Add a short reason so the sender knows what to do next.');
      it.handoff.state = 'declined';
      it.handoff.reason = why;
      it.handoff.declinedBy = actor.id;
      it.handoff.declinedAt = now();
      it.assigneeId = from && db.users[from] && !db.users[from].isBot ? from : null; // back to the sender
      notify(from, `↩️ ${actor.name} passed it back`, `${it.label}: ${why}`, c);
    }
    changed(c);
    return it;
  }

  // ---------- Stages & links ----------
  function setStage(actor, { channelId, stage }) {
    const c = channelFor(actor, channelId);
    const st = STAGES.find((s) => s.id === stage);
    if (!st) throw new Error('Unknown stage.');
    c.appliedTemplates = c.appliedTemplates || [];
    let added = 0;
    const t = db.checklistTemplates[st.template];
    if (t && !c.appliedTemplates.includes(st.template)) {
      added = core.applyTemplate(c, st.template, actor);
      c.appliedTemplates.push(st.template);
    }
    c.stage = st.id;
    core.save();
    changed(c);
    core.emitToChannel(c, 'channel:meta', { channelId: c.id, stage: c.stage, links: c.links || null });
    try { core.postMessage(actor, c.id, `📈 Moved to **${st.label}**${added ? `: ${added} task${added === 1 ? '' : 's'} added to the checklist` : ''}.`, null, { silent: false }); } catch {}
    return c;
  }

  function cleanUrl(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) throw new Error('Links must start with https://');
    return s.slice(0, 500);
  }
  function setLinks(actor, { channelId, links }) {
    const c = channelFor(actor, channelId);
    const next = {};
    const fub = String(links?.fub || '').trim();
    if (fub) {
      const id = /^\d+$/.test(fub) ? fub : (/people\/view\/(\d+)/.exec(fub) || /[?&]id=(\d+)/.exec(fub) || [])[1];
      if (!id) throw new Error('Paste the Follow Up Boss contact link (it contains /people/view/…).');
      next.fubPersonId = Number(id);
      next.fub = `https://app.followupboss.com/2/people/view/${id}`;
    }
    for (const k of ['drive', 'listing', 'other']) { const u = cleanUrl(links?.[k]); if (u) next[k] = u; }
    if (links?.otherLabel) next.otherLabel = String(links.otherLabel).trim().slice(0, 30);
    c.links = Object.keys(next).length ? next : null;
    core.save();
    core.emitToChannel(c, 'channel:meta', { channelId: c.id, stage: c.stage || null, links: c.links });
    return c;
  }

  // ---------- "Today" ----------
  function taskView(c, it) {
    return {
      channelId: c.id, channelName: c.isDM ? 'Direct message' : core.displayName(c), isDM: !!c.isDM,
      itemId: it.id, label: it.label, section: it.section || '', dueAt: it.dueAt, assigneeId: it.assigneeId,
      handoff: it.handoff, blocked: it.blocked, sourceMessageId: it.sourceMessageId, addedBy: it.addedBy,
      doneBy: it.doneBy, doneAt: it.doneAt, links: c.links || null,
    };
  }

  function visibleChannels(user) {
    return Object.values(db.channels).filter((c) => !c.archived && c.members.includes(user.id));
  }

  function today(user) {
    const t = now();
    const start = dayStart(t);
    const tomorrow = dayStart(start + 36 * 3600e3);
    const weekOut = start + 8 * 864e5;
    const out = { toAccept: [], returned: [], overdue: [], dueToday: [], upcoming: [], noDate: [], blocked: [], waitingOn: [], mentions: [], leadSteps: [], needOwner: [], doneToday: 0 };
    for (const c of visibleChannels(user)) {
      for (const raw of c.checklist || []) {
        const it = norm(raw);
        if (it.doneBy) { if (it.doneBy === user.id && it.doneAt >= start) out.doneToday++; continue; }
        const v = taskView(c, it);
        const mine = it.assigneeId === user.id;
        if (it.handoff?.state === 'pending' && it.handoff.fromId === user.id && it.assigneeId !== user.id) out.waitingOn.push(v);
        if (it.blocked && (mine || it.addedBy === user.id || it.blocked.by === user.id || user.isAdmin)) out.blocked.push(v);
        if (!mine) continue;
        if (it.handoff?.state === 'pending') { out.toAccept.push(v); continue; }
        if (it.handoff?.state === 'declined' && it.handoff.declinedAt > t - 7 * 864e5) { out.returned.push(v); continue; }
        if (it.blocked) continue;
        if (!it.dueAt) out.noDate.push(v);
        else if (it.dueAt < t) out.overdue.push(v);
        else if (it.dueAt < tomorrow) out.dueToday.push(v);
        else if (it.dueAt < weekOut) out.upcoming.push(v);
        else out.noDate.push(v);
      }
    }
    // Lead first steps (from Follow Up Boss alerts)
    const since7 = t - 7 * 864e5;
    const member = new Set(visibleChannels(user).map((c) => c.id));
    for (const m of db.messages) {
      if (!m.tasks || m.deleted || !member.has(m.channelId) || m.ts < since7) continue;
      for (const s of m.tasks) {
        if (s.doneBy) continue;
        const base = { messageId: m.id, channelId: m.channelId, taskId: s.id, label: s.label, lead: m.lead?.name || '', since: m.ts, url: m.lead?.url || '' };
        if (s.claimedBy === user.id) out.leadSteps.push(base);
        else if (!s.claimedBy) out.needOwner.push(base);
      }
    }
    out.needOwner = out.needOwner.slice(-10);
    // Unread @mentions (last 14 days)
    const since14 = t - 14 * 864e5;
    for (const m of db.messages) {
      if (m.deleted || m.userId === user.id || m.ts < since14 || !member.has(m.channelId)) continue;
      if (!(m.mentions || []).some((id) => id === user.id || id === '*')) continue;
      if (m.ts <= (user.lastRead?.[m.channelId] || 0) && !m.parentId) continue;
      if (m.parentId && m.ts <= (user.lastRead?.['t:' + m.parentId] || user.lastRead?.[m.channelId] || 0)) continue;
      const c = db.channels[m.channelId];
      out.mentions.push({ messageId: m.parentId || m.id, channelId: m.channelId, channelName: c.isDM ? 'Direct message' : core.displayName(c), from: m.userId, text: m.text.slice(0, 200), ts: m.ts });
    }
    out.mentions = out.mentions.slice(-20).reverse();
    const byDue = (a, b) => (a.dueAt || 9e15) - (b.dueAt || 9e15);
    for (const k of ['overdue', 'dueToday', 'upcoming']) out[k].sort(byDue);
    out.count = out.toAccept.length + out.overdue.length + out.dueToday.length + out.returned.length;
    return out;
  }

  // ---------- Daily summary ----------
  function systemBot() {
    let bot = Object.values(db.users).find((u) => u.isBot && u.integration === 'system' && !u.disabled);
    if (!bot) {
      const id = core.uid();
      bot = { id, name: 'Kaizen HQ', email: '', title: 'Daily summary', color: '#1f1f1f', isBot: true, integration: 'system', lastRead: {}, createdAt: now() };
      db.users[id] = bot;
      core.save();
      core.io().emit('user:new', core.publicUser(bot));
    }
    return bot;
  }

  function summaryText(user) {
    const t = now();
    const d = today(user);
    const start = dayStart(t);
    const yStart = dayStart(start - 12 * 3600e3);
    const line = (v) => `• ${v.label} · _${v.channelName}_${v.dueAt ? ` · due ${niceDate(v.dueAt)}` : ''}`;
    const out = [`☀️ **Good morning, ${user.name.split(' ')[0]}. Here's your ${niceDate(t)}.**`];
    const need = [];
    if (d.overdue.length) need.push(`⏰ **Overdue (${d.overdue.length})**`, ...d.overdue.slice(0, 5).map(line));
    if (d.dueToday.length) need.push(`📅 **Due today (${d.dueToday.length})**`, ...d.dueToday.slice(0, 5).map(line));
    if (d.toAccept.length) need.push(`🤝 **Waiting for you to accept (${d.toAccept.length})**`, ...d.toAccept.slice(0, 5).map((v) => `• ${v.label} · from ${first(v.handoff.fromId)}`));
    if (d.returned.length) need.push(`↩️ **Passed back to you (${d.returned.length})**`, ...d.returned.slice(0, 3).map((v) => `• ${v.label}: "${v.handoff.reason}"`));
    if (d.leadSteps.length) need.push(`🏡 **Lead steps you claimed (${d.leadSteps.length})**`, ...d.leadSteps.slice(0, 3).map((s) => `• ${s.label}${s.lead ? ` · ${s.lead}` : ''}`));
    out.push(need.length ? '\n**Needs you**\n' + need.join('\n') : '\n✅ Nothing overdue or due today.');
    if (d.waitingOn.length) out.push('\n**Waiting on others**\n' + d.waitingOn.slice(0, 5).map((v) => `• ${first(v.assigneeId)} hasn't accepted "${v.label}" yet (${Math.round((t - v.handoff.at) / 3600e3)}h)`).join('\n'));
    if (d.blocked.length) out.push('\n**Decisions needed**\n' + d.blocked.slice(0, 6).map((v) => `• ⛔ ${v.label} · _${v.channelName}_: ${v.blocked.reason}`).join('\n'));
    if (d.needOwner.length) out.push(`\n**Lead steps with no owner:** ${d.needOwner.length}. Claim them in #leads.`);
    // Yesterday
    let teamDone = 0, mineDone = 0;
    const highlights = [];
    for (const c of visibleChannels(user)) for (const it of c.checklist || []) {
      if (!it.doneAt || it.doneAt < yStart || it.doneAt >= start) continue;
      teamDone++;
      if (it.doneBy === user.id) mineDone++;
      if (highlights.length < 4) highlights.push(`${it.label} (${first(it.doneBy)})`);
    }
    const member = new Set(visibleChannels(user).map((c) => c.id));
    const leads = db.messages.filter((m) => m.lead && !m.deleted && m.ts >= yStart && m.ts < start && member.has(m.channelId));
    const y = [];
    if (teamDone) y.push(`✅ Team finished ${teamDone} task${teamDone === 1 ? '' : 's'} (you: ${mineDone})${highlights.length ? `, including ${highlights.join('; ')}` : ''}`);
    if (leads.length) {
      const by = (k) => leads.filter((m) => m.lead.type === k).length;
      y.push(`🆕 ${leads.length} new lead${leads.length === 1 ? '' : 's'}${by('seller') ? ` (${by('seller')} seller` : ''}${by('seller') && by('buyer') ? `, ${by('buyer')} buyer)` : by('seller') ? ')' : ''}`);
    }
    if (y.length) out.push('\n**Yesterday**\n' + y.map((x) => '• ' + x).join('\n'));
    out.push('\nOpen ☀️ **Today** for the full list.');
    return out.join('\n');
  }

  function dmBetween(a, b) {
    const pair = [a.id, b.id].sort();
    let c = Object.values(db.channels).find((x) => x.isDM && x.members.length === 2 && pair.every((id) => x.members.includes(id)));
    if (!c) {
      const id = core.uid();
      c = { id, name: '', topic: '', isDM: true, members: pair, createdBy: a.id, createdAt: now() };
      db.channels[id] = c;
      core.save();
      for (const m of pair) core.emitToUser(m, 'channel:joined', core.channelView(c, db.users[m]));
    }
    return c;
  }

  function sendSummary(user) {
    const bot = systemBot();
    const dm = dmBetween(bot, user);
    core.postMessage(bot, dm.id, summaryText(user));
    user.lastSummaryDay = dayKey(now());
    core.save();
  }

  // Send each person's summary once a day at their chosen time (Toronto time).
  function tick() {
    const t = now();
    const mins = minutesOfDay(t);
    const key = dayKey(t);
    for (const u of Object.values(db.users)) {
      if (u.isBot || u.disabled) continue;
      const s = core.prefsOf(u).summary;
      if (!s.on || u.lastSummaryDay === key) continue;
      const at = hhmmToMin(s.time) ?? 450;
      if (mins >= at && mins < at + 120) { try { sendSummary(u); } catch (e) { console.error('Summary failed', u.id, e.message); } }
    }
  }
  const timer = setInterval(tick, 60 * 1000);
  timer.unref?.();

  // Quiet hours: no push notifications during the person's quiet window (Toronto time).
  function inQuietHours(u, t = now()) {
    const q = core.prefsOf(u).quiet;
    if (!q.on) return false;
    const s = hhmmToMin(q.start), e = hhmmToMin(q.end), m = minutesOfDay(t);
    if (s === null || e === null || s === e) return false;
    return s < e ? m >= s && m < e : m >= s || m < e;
  }

  // ---------- Dashboard: overdue tasks & handoffs nobody accepted ----------
  function urgentFor(viewer) {
    const t = now();
    const list = [];
    for (const c of Object.values(db.channels)) {
      if (c.archived || !c.checklist || (viewer && !core.canSee(viewer, c))) continue;
      for (const it of c.checklist) {
        if (it.doneBy) continue;
        if (it.dueAt && it.dueAt < t) list.push({ kind: 'ctask', id: it.id, channelId: c.id, label: it.label, lead: c.isDM ? '' : core.displayName(c), since: it.dueAt, status: `Overdue · ${it.assigneeId ? first(it.assigneeId) : 'no owner'}` });
        else if (it.handoff?.state === 'pending' && t - it.handoff.at > 24 * 3600e3) list.push({ kind: 'ctask', id: it.id, channelId: c.id, label: it.label, lead: c.isDM ? '' : core.displayName(c), since: it.handoff.at, status: `Not accepted · ${first(it.assigneeId)}` });
      }
    }
    return list;
  }

  // ---------- Sockets ----------
  function registerSocket(socket, me) {
    const h = (fn) => (data, cb) => { try { const r = fn(data || {}); cb?.({ ok: true, ...(r && r.id ? { itemId: r.id } : {}) }); } catch (e) { cb?.({ error: e.message }); } };
    socket.on('task:create', h((d) => createTask(me(), d)));
    socket.on('task:edit', h((d) => editTask(me(), d)));
    socket.on('task:respond', h((d) => respond(me(), d)));
    socket.on('channel:stage', h((d) => { setStage(me(), d); }));
    socket.on('channel:links', h((d) => { setLinks(me(), d); }));
    socket.on('today:get', (_, cb) => cb?.(today(me())));
    socket.on('summary:now', (_, cb) => { try { sendSummary(me()); cb?.({ ok: true }); } catch (e) { cb?.({ error: e.message }); } });
    socket.on('fub:person', async ({ personId, channelId }, cb) => {
      try {
        const c = db.channels[channelId];
        if (!c || !core.canSee(me(), c) || Number(c.links?.fubPersonId) !== Number(personId)) throw new Error('Not found');
        cb?.({ person: await core.fubPerson(Number(personId)) });
      } catch (e) { cb?.({ error: e.message }); }
    });
  }

  return { registerSocket, today, createTask, editTask, respond, setStage, setLinks, summaryText, sendSummary, inQuietHours, urgentFor, norm, STAGES, dueInDays, tick };
}

module.exports = { mountTasks, STAGE_TEMPLATES, STAGES, tzEpoch, dayStart, dueInDays };
