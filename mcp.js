// MCP (Model Context Protocol) endpoint so AI assistants such as Grok can
// read and post in Kaizen HQ. Each assistant connects with its own bot key,
// created by an admin in the app (Settings → AI assistants).
//
// Endpoint:  POST /mcp   (Streamable HTTP, stateless)
// Auth:      Authorization: Bearer <bot key>

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

function mountMcp(app, core) {
  const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
  const error = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
  const when = (ts) => new Date(ts).toISOString();

  function nameOf(id) {
    return core.db.users[id]?.name || 'Unknown';
  }

  // Accepts a channel id, "listings", "#listings", "listings/24-juniper-crescent",
  // "listings › 24 Juniper Crescent" or just the sub-channel's address.
  function resolveChannel(bot, ref) {
    const all = Object.values(core.db.channels).filter((c) => core.canSee(bot, c));
    if (core.db.channels[ref] && core.canSee(bot, core.db.channels[ref])) return core.db.channels[ref];
    const raw = String(ref || '').trim().replace(/^#/, '');
    const parts = raw.split(/\s*(?:\/|›|>)\s*/);
    if (parts.length === 2) {
      const parent = all.find((c) => !c.parentId && c.name === core.channelSlug(parts[0]));
      return parent && all.find((c) => c.parentId === parent.id && c.name === core.channelSlug(parts[1]));
    }
    const slug = core.channelSlug(raw);
    return all.find((c) => !c.isDM && !c.parentId && c.name === slug) || all.find((c) => !c.isDM && c.name === slug);
  }

  function channelInfo(c) {
    return {
      id: c.id,
      name: core.displayName(c),
      path: c.parentId ? `${core.db.channels[c.parentId]?.name}/${c.name}` : c.name,
      topic: c.topic || '',
      parent: c.parentId ? core.db.channels[c.parentId]?.name : null,
      archived: !!c.archived,
      members: c.members.length,
    };
  }

  function msgInfo(m) {
    const v = core.messageView(m);
    return {
      id: v.id, author: nameOf(v.userId), time: when(v.ts), text: v.deleted ? '(deleted)' : v.text,
      thread_id: v.parentId || undefined, replies: v.replyCount || undefined,
      reactions: Object.keys(v.reactions).length ? Object.fromEntries(Object.entries(v.reactions).map(([e, ids]) => [e, ids.length])) : undefined,
      pinned: v.pinned || undefined,
      lead_type: v.leadType || undefined,
      tasks: v.tasks ? v.tasks.map((t) => ({ task_id: t.id, step: t.label, claimed_by: t.claimedBy ? nameOf(t.claimedBy) : null, done: !!t.doneBy })) : undefined,
    };
  }

  function buildServer(bot) {
    const server = new McpServer({ name: 'kaizen-hq', version: '1.0.0' }, {
      instructions: `You are ${bot.name}, a member of ${core.workspace}, the private team workspace for Kaizen Real Estate Team (Markham, Ontario). `
        + `You have ${bot.access === 'full' ? 'FULL' : 'standard'} access: you can do what a team member can in the app: chat in channels and direct messages, `
        + 'create listing sub-channels (with checklists and privacy), move listings through stages, add links (Follow Up Boss, Drive, listing), '
        + 'manage checklists and tasks (assign, due dates, blockers, handoffs), react, pin, edit or delete your own messages, mark hot leads, '
        + `add urgent items${bot.access === 'full' ? ', archive or delete channels, manage members and privacy, update goals and see the team view' : ''}. `
        + 'Sub-channels (one per listing address) live under main channels such as listings, e.g. "listings/24-juniper-crescent". '
        + 'Use get_my_mentions to find people asking you for help, read the thread for context, then reply with send_message using thread_id. '
        + 'Confirm before destructive actions (delete). Be warm, concise and professional. Never invent listing facts; Follow Up Boss is the client record.',
    });

    server.registerTool('list_channels', {
      title: 'List channels',
      description: 'List the public channels and sub-channels in Kaizen HQ, with topics and ids.',
      inputSchema: { include_archived: z.boolean().optional().describe('Include archived channels (e.g. sold listings). Default false.') },
      annotations: { readOnlyHint: true },
    }, async ({ include_archived }) => {
      const list = Object.values(core.db.channels)
        .filter((c) => !c.isDM && core.canSee(bot, c) && (include_archived || !c.archived))
        .sort((a, b) => channelInfo(a).path.localeCompare(channelInfo(b).path))
        .map(channelInfo);
      return text(list);
    });

    server.registerTool('read_messages', {
      title: 'Read channel messages',
      description: 'Read the most recent messages in a channel or sub-channel. Thread replies are not included; use read_thread for those.',
      inputSchema: {
        channel: z.string().describe('Channel id or name, e.g. "general", "listings", or "listings/24-juniper-crescent"'),
        limit: z.number().int().min(1).max(100).optional().describe('How many recent messages (default 30)'),
      },
      annotations: { readOnlyHint: true },
    }, async ({ channel, limit = 30 }) => {
      const c = resolveChannel(bot, channel);
      if (!c) return error(`Channel "${channel}" not found. Use list_channels to see what's available.`);
      const msgs = core.db.messages.filter((m) => m.channelId === c.id && !m.parentId).slice(-limit).map(msgInfo);
      return text({ channel: channelInfo(c), messages: msgs });
    });

    server.registerTool('read_thread', {
      title: 'Read a thread',
      description: 'Read a message and all of its thread replies.',
      inputSchema: { message_id: z.string().describe('The id of the message that started the thread') },
      annotations: { readOnlyHint: true },
    }, async ({ message_id }) => {
      const parent = core.db.messages.find((m) => m.id === message_id);
      if (!parent || !core.canSee(bot, core.db.channels[parent.channelId])) return error('Message not found.');
      const root = parent.parentId ? core.db.messages.find((m) => m.id === parent.parentId) : parent;
      return text({
        channel: channelInfo(core.db.channels[root.channelId]),
        message: msgInfo(root),
        replies: core.db.messages.filter((m) => m.parentId === root.id).map(msgInfo),
      });
    });

    server.registerTool('send_message', {
      title: 'Send a message',
      description: 'Post a message to a channel or sub-channel, or reply in a thread. Supports **bold**, _italic_, `code` and @Name mentions.',
      inputSchema: {
        channel: z.string().describe('Channel id or name, e.g. "general" or "listings/24-juniper-crescent"'),
        text: z.string().min(1).max(4000).describe('The message to post'),
        thread_id: z.string().optional().describe('Reply inside this thread (the id of the message that started it)'),
      },
    }, async ({ channel, text: body, thread_id }) => {
      const c = resolveChannel(bot, channel);
      if (!c) return error(`Channel "${channel}" not found.`);
      try {
        let parentId = thread_id;
        if (parentId) {
          const p = core.db.messages.find((m) => m.id === parentId);
          if (p?.parentId) parentId = p.parentId; // replying to a reply → same thread
        }
        const m = core.postMessage(bot, c.id, body, parentId);
        return text({ ok: true, message_id: m.id, channel: core.displayName(c) });
      } catch (e) {
        return error(e.message);
      }
    });

    server.registerTool('search_messages', {
      title: 'Search messages',
      description: 'Search messages across the public channels (including thread replies) by keyword, e.g. an address, a client name or "offer".',
      inputSchema: {
        query: z.string().min(2).describe('Text to look for'),
        channel: z.string().optional().describe('Limit to one channel'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    }, async ({ query, channel, limit = 20 }) => {
      const only = channel ? resolveChannel(bot, channel) : null;
      if (channel && !only) return error(`Channel "${channel}" not found.`);
      const q = query.toLowerCase();
      const hits = core.db.messages
        .filter((m) => !m.deleted && (!only || m.channelId === only.id) && core.canSee(bot, core.db.channels[m.channelId]) && m.text.toLowerCase().includes(q))
        .slice(-limit).reverse()
        .map((m) => ({ channel: core.displayName(core.db.channels[m.channelId]), ...msgInfo(m) }));
      return text(hits);
    });

    server.registerTool('get_my_mentions', {
      title: 'Get messages that mention me',
      description: `Find recent messages that @mention ${bot.name} (or @here/@channel) so you can see who needs help, plus whether you already replied in that thread.`,
      inputSchema: { since_hours: z.number().min(1).max(720).optional().describe('Look back this many hours (default 24)') },
      annotations: { readOnlyHint: true },
    }, async ({ since_hours = 24 }) => {
      const since = Date.now() - since_hours * 3600 * 1000;
      const hits = core.db.messages
        .filter((m) => m.ts >= since && !m.deleted && m.userId !== bot.id && (m.mentions || []).some((id) => id === bot.id || id === '*') && core.canSee(bot, core.db.channels[m.channelId]))
        .map((m) => {
          const root = m.parentId || m.id;
          const answered = core.db.messages.some((r) => r.parentId === root && r.userId === bot.id && r.ts > m.ts);
          return { channel: core.displayName(core.db.channels[m.channelId]), channel_id: m.channelId, reply_with_thread_id: root, answered, ...msgInfo(m) };
        });
      return text(hits);
    });

    const act = async (event, payload) => {
      const r = await core.botAction(bot, event, payload);
      if (r && r.error) throw new Error(r.error);
      return r || {};
    };
    const run = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return error(e.message); } };
    const mustChannel = (ref) => { const c = resolveChannel(bot, ref); if (!c) throw new Error(`Channel "${ref}" not found. Use list_channels.`); return c; };
    const person = (name) => {
      const n = String(name || '').toLowerCase().replace(/^@/, '').trim();
      const people = Object.values(core.db.users).filter((u) => !u.disabled && !u.integration && u.id !== bot.id);
      const u = people.find((x) => x.name.toLowerCase() === n) || people.find((x) => x.name.toLowerCase().split(' ')[0] === n);
      if (!u) throw new Error(`No team member called "${name}". Use list_team.`);
      return u;
    };
    const msgById = (id) => { const m = core.db.messages.find((x) => x.id === id && !x.deleted); if (!m || !core.canSee(bot, core.db.channels[m.channelId])) throw new Error('Message not found.'); return m; };
    const templateId = (ref) => {
      const list = Object.values(core.db.checklistTemplates || {});
      const t = list.find((x) => x.id === ref) || list.find((x) => x.name.toLowerCase() === String(ref).toLowerCase());
      if (!t) throw new Error(`No checklist called "${ref}". Options: ${list.map((x) => x.name).join(', ')}`);
      return t.id;
    };

    server.registerTool('create_channel', {
      title: 'Create a channel or listing sub-channel',
      description: 'Create a channel, or a sub-channel under a main channel (e.g. a listing address under "listings"). Listing sub-channels get the "New listing" checklist automatically. Can be private to chosen people.',
      inputSchema: {
        name: z.string().min(1).max(80).describe('Name, e.g. "open-houses" or a listing address like "24 Juniper Crescent"'),
        parent: z.string().optional().describe('Main channel to put it under, e.g. "listings"'),
        topic: z.string().max(200).optional(),
        checklist: z.string().optional().describe('Checklist template to add, e.g. "New listing" or "Open house". Use "none" for no checklist.'),
        private: z.boolean().optional().describe('Only the chosen people (and you) can see it'),
        people: z.array(z.string()).optional().describe('For private channels: team members who can see it'),
      },
    }, run(async ({ name, parent, topic, checklist, private: priv, people }) => {
      const p = parent ? mustChannel(parent) : null;
      const r = await act('channel:create', {
        name, topic, parentId: p?.id || null,
        templateId: checklist === undefined ? undefined : checklist === 'none' ? '' : templateId(checklist),
        isPrivate: !!priv, memberIds: (people || []).map((n) => person(n).id),
      });
      return { ok: true, channel: channelInfo(core.db.channels[r.id]) };
    }));

    server.registerTool('list_open_tasks', {
      title: 'List open first steps',
      description: 'List messages (usually new leads) that still have unfinished first steps, such as "Prepare CMA for 24 Juniper Crescent", with who has claimed each step.',
      inputSchema: {
        channel: z.string().optional().describe('Limit to one channel, e.g. "leads"'),
        unclaimed_only: z.boolean().optional().describe('Only steps nobody has claimed yet'),
      },
      annotations: { readOnlyHint: true },
    }, async ({ channel, unclaimed_only }) => {
      const only = channel ? resolveChannel(bot, channel) : null;
      if (channel && !only) return error(`Channel "${channel}" not found.`);
      const list = core.db.messages
        .filter((m) => m.tasks && !m.deleted && (!only || m.channelId === only.id) && core.canSee(bot, core.db.channels[m.channelId]))
        .filter((m) => m.tasks.some((t) => !t.doneBy && (!unclaimed_only || !t.claimedBy)))
        .slice(-30).reverse()
        .map((m) => ({ channel: core.displayName(core.db.channels[m.channelId]), ...msgInfo(m) }));
      return text(list);
    });

    server.registerTool('update_task', {
      title: 'Claim or complete a first step',
      description: 'Claim a step (so the team knows you are on it), release it, mark it done, or reopen it. A short note is posted in the thread automatically.',
      inputSchema: {
        message_id: z.string(),
        task_id: z.string(),
        action: z.enum(['claim', 'unclaim', 'done', 'undo']),
      },
    }, async ({ message_id, task_id, action }) => {
      try {
        const m = core.updateTask(bot, message_id, task_id, action);
        return text({ ok: true, message: msgInfo(m) });
      } catch (e) {
        return error(e.message);
      }
    });

    const findPerson = (name) => {
      if (!name) return null;
      const n = String(name).toLowerCase().replace(/^@/, '').trim();
      const people = Object.values(core.db.users).filter((u) => !u.isBot && !u.disabled);
      return people.find((u) => u.name.toLowerCase() === n) || people.find((u) => u.name.toLowerCase().split(' ')[0] === n) || null;
    };

    server.registerTool('create_task', {
      title: 'Create a task (and hand it to someone)',
      description: 'Create a task in a channel, optionally from a chat message. If you assign it to a person, it is a handoff: it waits in their Today screen until they accept it, so nothing falls between people.',
      inputSchema: {
        channel: z.string().describe('Channel, e.g. "listings/24-juniper-crescent" or "leads"'),
        task: z.string().min(1).max(200),
        assignee: z.string().optional().describe('Team member name, e.g. "Neeraj"'),
        due: z.string().optional().describe('Due date YYYY-MM-DD (5pm Toronto time), optionally with time "YYYY-MM-DD HH:MM"'),
        note: z.string().max(300).optional().describe('Context for the person receiving it'),
        source_message_id: z.string().optional().describe('Create it from this message so the discussion stays attached'),
      },
    }, async ({ channel, task, assignee, due, note, source_message_id }) => {
      const c = resolveChannel(bot, channel);
      if (!c) return error(`Channel "${channel}" not found.`);
      const person = assignee ? findPerson(assignee) : null;
      if (assignee && !person) return error(`No team member called "${assignee}". Use list_team.`);
      try {
        const it = core.tasks.createTask(bot, { channelId: c.id, label: task, assigneeId: person?.id || null, dueAt: due || null, note, sourceMessageId: source_message_id });
        return text({ ok: true, item_id: it.id, channel: core.displayName(c), waiting_for_acceptance: !!(it.handoff && it.handoff.state === 'pending') });
      } catch (e) { return error(e.message); }
    });

    server.registerTool('list_tasks', {
      title: 'List open tasks',
      description: 'List open tasks across the channels you can see, with owner, due date, handoff status (waiting for acceptance) and blockers.',
      inputSchema: {
        assignee: z.string().optional().describe('Only this person\'s tasks'),
        overdue_only: z.boolean().optional(),
        channel: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    }, async ({ assignee, overdue_only, channel }) => {
      const person = assignee ? findPerson(assignee) : null;
      if (assignee && !person) return error(`No team member called "${assignee}".`);
      const only = channel ? resolveChannel(bot, channel) : null;
      const now = Date.now();
      const rows = [];
      for (const c of Object.values(core.db.channels)) {
        if (c.archived || !c.checklist || !core.canSee(bot, c) || (only && only.id !== c.id)) continue;
        for (const t of c.checklist) {
          if (t.doneBy || (person && t.assigneeId !== person.id) || (overdue_only && !(t.dueAt && t.dueAt < now))) continue;
          rows.push({ channel: core.displayName(c), item_id: t.id, task: t.label, owner: t.assigneeId ? nameOf(t.assigneeId) : null,
            due: t.dueAt ? new Date(t.dueAt).toISOString() : null, overdue: !!(t.dueAt && t.dueAt < now),
            handoff: t.handoff ? { from: nameOf(t.handoff.fromId), state: t.handoff.state } : undefined, blocked: t.blocked?.reason });
        }
      }
      return text(rows.slice(0, 100));
    });

    server.registerTool('get_checklist', {
      title: 'Get a channel checklist',
      description: 'Get the task checklist of a channel, e.g. the new-listing checklist of "listings/24-juniper-crescent", with what is done and by whom.',
      inputSchema: { channel: z.string() },
      annotations: { readOnlyHint: true },
    }, async ({ channel }) => {
      const c = resolveChannel(bot, channel);
      if (!c) return error(`Channel "${channel}" not found.`);
      const list = (c.checklist || []).map((t) => ({ item_id: t.id, section: t.section, task: t.label, done: !!t.doneBy, done_by: t.doneBy ? nameOf(t.doneBy) : undefined }));
      return text({ channel: core.displayName(c), done: list.filter((t) => t.done).length, total: list.length, items: list });
    });

    server.registerTool('update_checklist', {
      title: 'Tick off or add a checklist task',
      description: 'Mark a checklist task done or not done, or add a new task to a channel checklist.',
      inputSchema: {
        channel: z.string(),
        item_id: z.string().optional().describe('The task to tick or untick'),
        done: z.boolean().optional(),
        add_task: z.string().max(160).optional().describe('Text of a new task to add'),
      },
    }, async ({ channel, item_id, done, add_task }) => {
      const c = resolveChannel(bot, channel);
      if (!c || c.isDM) return error(`Channel "${channel}" not found.`);
      if (add_task) {
        c.checklist = c.checklist || [];
        c.checklist.push({ id: core.uid(), label: add_task.trim(), section: 'Our tasks', doneBy: null, doneAt: null, addedBy: bot.id, custom: true });
      }
      if (item_id) {
        const t = (c.checklist || []).find((x) => x.id === item_id);
        if (!t) return error('Task not found.');
        if (done === false) { t.doneBy = null; t.doneAt = null; } else { t.doneBy = bot.id; t.doneAt = Date.now(); }
      }
      core.checklistChanged(c);
      return text({ ok: true });
    });

    server.registerTool('get_dashboard', {
      title: 'Get the team dashboard',
      description: 'The team forecast vs goal for the year (GCI and deals, per agent), urgent items, and hot leads with Follow Up Boss links.',
      annotations: { readOnlyHint: true },
    }, async () => {
      const d = core.dashboard(bot);
      return text({
        year: d.year, team: d.team,
        agents: d.agents.map(({ userId, updatedAt, ...a }) => a),
        urgent: d.urgent.map(({ id, messageId, channelId, ...u }) => ({ ...u, message_id: messageId, since: new Date(u.since).toISOString() })),
        hot_leads: d.hot.map(({ name, detail, url }) => ({ name, detail, url })),
      });
    });

    // ----- Messages -----
    server.registerTool('edit_message', {
      title: 'Edit one of your messages', description: 'Change the text of a message you posted.',
      inputSchema: { message_id: z.string(), text: z.string().min(1).max(4000) },
    }, run(async ({ message_id, text: t }) => {
      const m = msgById(message_id);
      if (m.userId !== bot.id) throw new Error('You can only edit your own messages.');
      await act('message:edit', { messageId: m.id, text: t });
      return { ok: true };
    }));
    server.registerTool('delete_message', {
      title: 'Delete a message', description: 'Delete one of your own messages (with full access, any message).',
      inputSchema: { message_id: z.string() },
    }, run(async ({ message_id }) => {
      const m = msgById(message_id);
      if (m.userId !== bot.id && bot.access !== 'full') throw new Error('You can only delete your own messages.');
      await act('message:delete', { messageId: m.id });
      return { ok: true };
    }));
    server.registerTool('react_to_message', {
      title: 'React with an emoji', description: 'Add (or remove, if already there) an emoji reaction on a message.',
      inputSchema: { message_id: z.string(), emoji: z.string().min(1).max(8).describe('e.g. 👍 🎉 🔥 ✅') },
    }, run(async ({ message_id, emoji }) => { msgById(message_id); await act('reaction', { messageId: message_id, emoji }); return { ok: true }; }));
    server.registerTool('pin_message', {
      title: 'Pin or unpin a message', description: 'Pin a message to the top of its channel, or unpin it.',
      inputSchema: { message_id: z.string(), pinned: z.boolean().optional().describe('Default true') },
    }, run(async ({ message_id, pinned = true }) => {
      const m = msgById(message_id);
      if (!!m.pinned !== pinned) await act('message:pin', { messageId: m.id });
      return { ok: true, pinned };
    }));

    // ----- Direct messages -----
    const dmWith = async (name) => { const u = person(name); const r = await act('dm:open', { userId: u.id }); return { u, c: core.db.channels[r.id] }; };
    server.registerTool('send_direct_message', {
      title: 'Send a direct message', description: 'Send a private direct message to a team member.',
      inputSchema: { person: z.string().describe('e.g. "Neeraj"'), text: z.string().min(1).max(4000) },
    }, run(async ({ person: p, text: t }) => {
      const { u, c } = await dmWith(p);
      await act('message:send', { channelId: c.id, text: t });
      return { ok: true, to: u.name };
    }));
    server.registerTool('read_direct_messages', {
      title: 'Read a direct message conversation', description: 'Read your direct messages with a team member.',
      inputSchema: { person: z.string(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    }, run(async ({ person: p, limit = 30 }) => {
      const { u, c } = await dmWith(p);
      return { with: u.name, messages: core.db.messages.filter((m) => m.channelId === c.id && !m.parentId).slice(-limit).map(msgInfo) };
    }));
    server.registerTool('list_direct_messages', {
      title: 'List your direct message conversations', description: 'Your direct message conversations, with the latest message in each.',
      annotations: { readOnlyHint: true },
    }, run(async () => Object.values(core.db.channels).filter((c) => c.isDM && c.members.includes(bot.id)).map((c) => {
      const last = core.db.messages.filter((m) => m.channelId === c.id && !m.deleted).at(-1);
      return { with: c.members.filter((id) => id !== bot.id).map(nameOf).join(', ') || 'yourself', last: last ? msgInfo(last) : null };
    })));

    // ----- Channels -----
    server.registerTool('get_channel_info', {
      title: 'Get channel details', description: 'Topic, members, privacy, listing stage, record links (and live Follow Up Boss contact), archived state and checklist progress.',
      inputSchema: { channel: z.string() }, annotations: { readOnlyHint: true },
    }, run(async ({ channel }) => {
      const c = mustChannel(channel);
      const list = c.checklist || [];
      let contact = null;
      if (c.links?.fubPersonId && core.fubPerson) { try { contact = await core.fubPerson(c.links.fubPersonId); } catch (e) { contact = { error: e.message }; } }
      return {
        ...channelInfo(c), private: !!c.isPrivate, stage: c.stage || null,
        members: c.members.map(nameOf), links: c.links || null, follow_up_boss_contact: contact,
        checklist: { done: list.filter((t) => t.doneBy).length, total: list.length },
      };
    }));
    server.registerTool('set_channel_topic', {
      title: 'Set a channel topic', inputSchema: { channel: z.string(), topic: z.string().max(200) },
    }, run(async ({ channel, topic }) => { const c = mustChannel(channel); await act('channel:topic', { channelId: c.id, topic }); return { ok: true }; }));
    server.registerTool('join_channel', {
      title: 'Join a channel', inputSchema: { channel: z.string() },
    }, run(async ({ channel }) => { const c = mustChannel(channel); await act('channel:join', { channelId: c.id }); return { ok: true }; }));
    server.registerTool('leave_channel', {
      title: 'Leave a channel', inputSchema: { channel: z.string() },
    }, run(async ({ channel }) => { const c = mustChannel(channel); await act('channel:leave', { channelId: c.id }); return { ok: true }; }));
    server.registerTool('add_people_to_channel', {
      title: 'Add people to a channel', inputSchema: { channel: z.string(), people: z.array(z.string()).min(1) },
    }, run(async ({ channel, people }) => {
      const c = mustChannel(channel);
      const ids = people.map((n) => person(n).id);
      await act('channel:addMembers', { channelId: c.id, userIds: ids });
      return { ok: true, added: ids.map(nameOf) };
    }));
    server.registerTool('remove_person_from_channel', {
      title: 'Remove someone from a private channel (full access)', inputSchema: { channel: z.string(), person: z.string() },
    }, run(async ({ channel, person: p }) => { const c = mustChannel(channel); await act('channel:removeMember', { channelId: c.id, userId: person(p).id }); return { ok: true }; }));
    server.registerTool('set_channel_privacy', {
      title: 'Make a channel private or open (full access)', inputSchema: { channel: z.string(), private: z.boolean() },
    }, run(async ({ channel, private: priv }) => { const c = mustChannel(channel); await act('channel:privacy', { channelId: c.id, isPrivate: priv }); return { ok: true }; }));
    server.registerTool('archive_channel', {
      title: 'Archive or unarchive a channel (full access)', description: 'Archive hides a channel (e.g. a sold listing) but keeps its messages and tasks. Use archived:false to bring it back.',
      inputSchema: { channel: z.string(), archived: z.boolean().optional().describe('Default true') },
    }, run(async ({ channel, archived = true }) => { const c = mustChannel(channel); await act('channel:archive', { channelId: c.id, archived }); return { ok: true, archived }; }));
    server.registerTool('delete_channel', {
      title: 'Permanently delete a channel (full access)', description: 'Deletes the channel with all its messages and tasks for everyone. Cannot be undone. Ask the person to confirm first, then pass confirm:"DELETE".',
      inputSchema: { channel: z.string(), confirm: z.literal('DELETE') },
    }, run(async ({ channel, confirm }) => { const c = mustChannel(channel); const r = await act('channel:delete', { channelId: c.id, confirm }); return { ok: true, messages_deleted: r.removed }; }));

    // ----- Listings: stage & record links -----
    server.registerTool('set_listing_stage', {
      title: 'Move a listing to a stage', description: 'Listing → Offer accepted → Firm sale → Closing. Moving to a stage adds that stage\'s tasks (with due dates) to the checklist and posts a note.',
      inputSchema: { channel: z.string(), stage: z.enum(['listing', 'offer', 'firm', 'closing']) },
    }, run(async ({ channel, stage }) => { const c = mustChannel(channel); await act('channel:stage', { channelId: c.id, stage }); return { ok: true, stage }; }));
    server.registerTool('set_channel_links', {
      title: 'Add links to the original records', description: 'Link the Follow Up Boss contact (URL or person id), Google Drive folder, listing page and one other link. Only the fields you pass are changed; pass "" to remove one.',
      inputSchema: {
        channel: z.string(), follow_up_boss: z.string().optional(), drive: z.string().optional(), listing: z.string().optional(),
        other: z.string().optional(), other_label: z.string().max(30).optional(),
      },
    }, run(async ({ channel, follow_up_boss, drive, listing, other, other_label }) => {
      const c = mustChannel(channel);
      const cur = c.links || {};
      const links = {
        fub: follow_up_boss !== undefined ? follow_up_boss : cur.fub || '',
        drive: drive !== undefined ? drive : cur.drive || '',
        listing: listing !== undefined ? listing : cur.listing || '',
        other: other !== undefined ? other : cur.other || '',
        otherLabel: other_label !== undefined ? other_label : cur.otherLabel || '',
      };
      await act('channel:links', { channelId: c.id, links });
      return { ok: true, links: core.db.channels[c.id].links };
    }));

    // ----- Checklists & tasks -----
    server.registerTool('list_checklist_templates', {
      title: 'List checklist templates', annotations: { readOnlyHint: true },
    }, run(async () => Object.values(core.db.checklistTemplates || {}).map((t) => ({ id: t.id, name: t.name }))));
    server.registerTool('add_checklist_from_template', {
      title: 'Add a checklist template to a channel', description: 'Adds the tasks of a template (e.g. "Open house") to a channel\'s checklist.',
      inputSchema: { channel: z.string(), template: z.string() },
    }, run(async ({ channel, template }) => { const c = mustChannel(channel); await act('checklist:apply', { channelId: c.id, templateId: templateId(template) }); return { ok: true, tasks: (core.db.channels[c.id].checklist || []).length }; }));
    server.registerTool('edit_task', {
      title: 'Edit a task', description: 'Change a checklist task: text, owner (assigning someone else is a handoff they must accept), due date, blocker, or done. Pass blocked:"" to clear a blocker and assignee:"" to remove the owner.',
      inputSchema: {
        channel: z.string(), item_id: z.string(), task: z.string().max(200).optional(),
        assignee: z.string().optional(), note: z.string().max(300).optional().describe('Context for the new owner'),
        due: z.string().optional().describe('YYYY-MM-DD (5pm Toronto) or "YYYY-MM-DD HH:MM"; "" to clear'),
        blocked: z.string().max(300).optional().describe('Reason it is blocked / needs a decision; "" to clear'),
        done: z.boolean().optional(),
      },
    }, run(async ({ channel, item_id, task, assignee, note, due, blocked, done }) => {
      const c = mustChannel(channel);
      const p = { channelId: c.id, itemId: item_id };
      if (task !== undefined) p.label = task;
      if (assignee !== undefined) { p.assigneeId = assignee ? person(assignee).id : null; p.note = note; }
      if (due !== undefined) p.dueAt = due || null;
      if (blocked !== undefined) p.blocked = blocked || null;
      if (done !== undefined) p.done = done;
      await act('task:edit', p);
      return { ok: true };
    }));
    server.registerTool('delete_task', {
      title: 'Delete a checklist task', inputSchema: { channel: z.string(), item_id: z.string() },
    }, run(async ({ channel, item_id }) => { const c = mustChannel(channel); await act('checklist:remove', { channelId: c.id, itemId: item_id }); return { ok: true }; }));
    server.registerTool('remove_checklist', {
      title: 'Remove a channel\'s whole checklist (full access)', inputSchema: { channel: z.string(), confirm: z.literal('REMOVE') },
    }, run(async ({ channel }) => { const c = mustChannel(channel); await act('checklist:clear', { channelId: c.id }); return { ok: true }; }));
    server.registerTool('nudge_task_owner', {
      title: 'Nudge the owner of a task (full access)', description: 'Sends the owner a reminder (push + direct message). At most once an hour per task.',
      inputSchema: { channel: z.string(), item_id: z.string() },
    }, run(async ({ channel, item_id }) => { const c = mustChannel(channel); await act('task:nudge', { channelId: c.id, itemId: item_id }); return { ok: true }; }));

    // ----- Leads, urgent items, goals, team -----
    server.registerTool('mark_hot_lead', {
      title: 'Mark a lead as hot', description: 'Add (or remove) a lead alert from the 🔥 hot leads ticker.',
      inputSchema: { message_id: z.string().describe('The lead alert message id'), hot: z.boolean().optional().describe('Default true') },
    }, run(async ({ message_id, hot = true }) => { msgById(message_id); await act('lead:hot', { messageId: message_id, hot }); return { ok: true, hot }; }));
    server.registerTool('add_urgent_item', {
      title: 'Add an urgent item to the dashboard', inputSchema: { text: z.string().min(1).max(140), link: z.string().optional() },
    }, run(async ({ text: t, link }) => { await act('urgent:add', { text: t, link }); return { ok: true }; }));
    server.registerTool('resolve_urgent_item', {
      title: 'Mark an urgent item done', description: 'Use get_dashboard to find the id (items of kind "custom").', inputSchema: { id: z.string() },
    }, run(async ({ id }) => { await act('urgent:done', { id }); return { ok: true }; }));
    server.registerTool('update_goal', {
      title: 'Update yearly goal numbers (full access)', description: 'Set a team member\'s goal, closed and pending GCI / deals for this year. Only the values you pass change.',
      inputSchema: {
        person: z.string(), goal_gci: z.number().min(0).optional(), goal_deals: z.number().min(0).optional(),
        closed_gci: z.number().min(0).optional(), closed_deals: z.number().min(0).optional(),
        pending_gci: z.number().min(0).optional(), pending_deals: z.number().min(0).optional(),
      },
    }, run(async (a) => {
      const u = person(a.person);
      const map = { goal_gci: 'goalGci', goal_deals: 'goalDeals', closed_gci: 'closedGci', closed_deals: 'closedDeals', pending_gci: 'pendingGci', pending_deals: 'pendingDeals' };
      const values = Object.fromEntries(Object.entries(map).filter(([k]) => a[k] !== undefined).map(([k, v]) => [v, a[k]]));
      await act('goal:update', { userId: u.id, values });
      return { ok: true, person: u.name, values };
    }));
    server.registerTool('get_team_view', {
      title: 'Get the team view (full access)', description: 'Each person\'s open, overdue, to-accept and finished tasks, handoffs not accepted, decisions needed, and every listing\'s stage and progress.',
      annotations: { readOnlyHint: true },
    }, run(async () => {
      const d = await act('team:get', {});
      return {
        totals: d.totals,
        people: d.people.map((p) => ({ name: p.name, open: p.open, overdue: p.overdue, to_accept: p.toAccept, done_this_week: p.doneThisWeek, lead_steps: p.leadSteps })),
        handoffs_not_accepted: d.handoffs.map((h) => ({ task: h.label, from: nameOf(h.handoff.fromId), to: nameOf(h.assigneeId), hours_waiting: Math.round(h.age / 3600e3), channel: h.channelName, channel_id: h.channelId, item_id: h.itemId })),
        decisions_needed: d.blocked.map((v) => ({ task: v.label, reason: v.blocked.reason, channel: v.channelName })),
        listings: d.listings.map((l) => ({ name: l.name, stage: l.stage, done: l.done, total: l.total, overdue: l.overdue, next: l.next && { task: l.next.label, owner: l.next.assigneeId ? nameOf(l.next.assigneeId) : null } })),
      };
    }));
    server.registerTool('get_person_today', {
      title: "Get a team member's Today list", description: 'What a person has to accept, overdue, due today, blocked and coming up (only from channels you can also see).',
      inputSchema: { person: z.string() }, annotations: { readOnlyHint: true },
    }, run(async ({ person: p }) => {
      const u = person(p);
      const d = core.tasks.today(u);
      const ok = (v) => core.canSee(bot, core.db.channels[v.channelId]);
      const slim = (v) => ({ task: v.label, channel: v.channelName, due: v.dueAt ? new Date(v.dueAt).toISOString() : null, blocked: v.blocked?.reason });
      const pick = (k) => d[k].filter(ok).map(slim);
      return { person: u.name, to_accept: pick('toAccept'), overdue: pick('overdue'), due_today: pick('dueToday'), blocked: pick('blocked'), upcoming: pick('upcoming') };
    }));

    server.registerTool('list_team', {
      title: 'List team members',
      description: 'List the people in the workspace with their roles.',
      annotations: { readOnlyHint: true },
    }, async () => text(Object.values(core.db.users).filter((u) => !u.disabled).map((u) => ({ name: u.name, role: u.title || '', bot: !!u.isBot || undefined }))));

    return server;
  }

  // The key can come from the Authorization header (preferred) or be part of the URL
  // (/mcp/<key>) for apps like grok.com Connectors that only let you paste a link.
  function auth(req, res) {
    const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() || req.params.key || '';
    const bot = core.botFromKey(key);
    if (!bot) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or missing bot key. Create one in Kaizen HQ → Settings → AI assistants.' }, id: null });
      return null;
    }
    return bot;
  }

  // Simple REST API for tools like Zapier or Make, using the same keys:
  //   POST /api/v1/messages  { "channel": "leads", "text": "Hello", "thread_id": "optional" }
  //   GET  /api/v1/channels
  app.post('/api/v1/messages', (req, res) => {
    const bot = auth(req, res);
    if (!bot) return;
    const { channel, text: body, thread_id, tasks, pin } = req.body || {};
    const c = resolveChannel(bot, channel);
    if (!c) return res.status(404).json({ error: `Channel "${channel}" not found.` });
    try {
      const m = core.postMessage(bot, c.id, body, thread_id, { tasks, pin: !!pin });
      res.json({ ok: true, message_id: m.id, channel: core.displayName(c) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.get('/api/v1/channels', (req, res) => {
    const bot = auth(req, res);
    if (!bot) return;
    res.json(Object.values(core.db.channels).filter((c) => !c.isDM && !c.archived && core.canSee(bot, c)).map(channelInfo));
  });

  const handle = async (req, res) => {
    const bot = auth(req, res);
    if (!bot) return;
    const server = buildServer(bot);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  app.post('/mcp', handle);
  app.post('/mcp/:key', handle);

  const notAllowed = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get(['/mcp', '/mcp/:key'], notAllowed);
  app.delete(['/mcp', '/mcp/:key'], notAllowed);
}

module.exports = { mountMcp };
