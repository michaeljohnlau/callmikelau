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
    };
  }

  function buildServer(bot) {
    const server = new McpServer({ name: 'kaizen-hq', version: '1.0.0' }, {
      instructions: `You are ${bot.name}, connected to ${core.workspace}, the private team chat for Kaizen Real Estate Team (Markham, Ontario). `
        + 'Use list_channels to see channels; sub-channels (e.g. one per listing address) live under main channels such as listings. '
        + 'Use get_my_mentions to find people asking you for help, read the thread for context, then reply with send_message using thread_id. '
        + 'Be warm, concise and professional. Never invent listing facts.',
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

    server.registerTool('create_channel', {
      title: 'Create a channel or sub-channel',
      description: 'Create a new channel, or a sub-channel under a main channel, for example a listing address under "listings".',
      inputSchema: {
        name: z.string().min(1).max(80).describe('Name, e.g. "open-houses" or a listing address like "24 Juniper Crescent"'),
        parent: z.string().optional().describe('Main channel to put it under, e.g. "listings"'),
        topic: z.string().max(200).optional(),
      },
    }, async ({ name, parent, topic }) => {
      try {
        const p = parent ? resolveChannel(bot, parent) : null;
        if (parent && !p) return error(`Parent channel "${parent}" not found.`);
        const c = core.createChannel(bot, { name, topic, parentId: p?.id });
        return text({ ok: true, channel: channelInfo(c) });
      } catch (e) {
        return error(e.message);
      }
    });

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
    const { channel, text: body, thread_id } = req.body || {};
    const c = resolveChannel(bot, channel);
    if (!c) return res.status(404).json({ error: `Channel "${channel}" not found.` });
    try {
      const m = core.postMessage(bot, c.id, body, thread_id);
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
