// Follow Up Boss → Kaizen HQ: every new lead in Follow Up Boss is posted to a chosen channel.
//
// How it works:
//  1. An admin pastes their Follow Up Boss API key in Settings → Integrations.
//  2. Kaizen HQ registers a "peopleCreated" webhook with Follow Up Boss that points to
//     /hooks/fub/<secret> on this server (the secret makes the URL unguessable).
//  3. When Follow Up Boss calls it, we look up the new person(s) with the API key and post a
//     summary to the channel as the "Follow Up Boss" bot, @mentioning the assigned agent.

const crypto = require('crypto');

const FUB_API = process.env.FUB_API_URL || 'https://api.followupboss.com/v1'; // override only for testing
const SYSTEM_NAME = 'KaizenHQ';

function mountIntegrations(app, core) {
  const cfg = () => (core.db.integrations = core.db.integrations || {}).fub || null;
  const setCfg = (v) => { core.db.integrations = core.db.integrations || {}; core.db.integrations.fub = v; core.save(); };

  async function fub(path, { method = 'GET', body, apiKey, systemKey } = {}) {
    const c = cfg() || {};
    const key = apiKey || c.apiKey;
    const sysKey = systemKey !== undefined ? systemKey : c.systemKey;
    const headers = {
      Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'),
      Accept: 'application/json',
      'X-System': SYSTEM_NAME,
    };
    if (sysKey) headers['X-System-Key'] = sysKey;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(FUB_API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.errorMessage || data?.message || data?.error || text || res.statusText;
      const err = new Error(`Follow Up Boss said: ${msg} (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // The bot user that posts lead alerts.
  function fubBot() {
    let bot = Object.values(core.db.users).find((u) => u.isBot && u.integration === 'fub' && !u.disabled);
    if (!bot) {
      const id = crypto.randomBytes(9).toString('base64url');
      bot = { id, name: 'Follow Up Boss', email: '', title: 'Lead alerts', color: '#1f1f1f', isBot: true, integration: 'fub', lastRead: {}, createdAt: Date.now() };
      core.db.users[id] = bot;
      core.save();
      core.io().emit('user:new', core.publicUser(bot));
    }
    return bot;
  }

  const clean = (s) => String(s || '').replace(/[*_`~]/g, '').trim();

  function formatLead(p) {
    const name = clean(p.name || [p.firstName, p.lastName].filter(Boolean).join(' ')) || 'New contact';
    const phone = (p.phones || []).map((x) => x.value).filter(Boolean)[0];
    const email = (p.emails || []).map((x) => x.value).filter(Boolean)[0];
    const lines = [`🆕 **New lead: ${name}**`];
    const contact = [phone && `📞 ${phone}`, email && `✉️ ${email}`].filter(Boolean).join('  ·  ');
    if (contact) lines.push(contact);
    const meta = [p.source && `Source: ${clean(p.source)}`, p.stage && `Stage: ${clean(p.stage)}`, p.price && `Price: $${Number(p.price).toLocaleString('en-CA')}`].filter(Boolean).join('  ·  ');
    if (meta) lines.push(meta);
    const addr = (p.addresses || [])[0];
    if (addr) {
      const a = [addr.street, addr.city, addr.state].filter(Boolean).map(clean).join(', ');
      if (a) lines.push(`📍 ${a}`);
    }
    if (p.tags?.length) lines.push(`🏷️ ${p.tags.slice(0, 8).map(clean).join(', ')}`);
    // @mention the assigned agent if they're in Kaizen HQ, so they get notified right away.
    const assigned = clean(p.assignedTo);
    if (assigned) {
      const member = Object.values(core.db.users).find((u) => !u.isBot && !u.disabled && u.name.toLowerCase() === assigned.toLowerCase());
      lines.push(`👤 Assigned to ${member ? '@' + member.name : assigned}`);
    } else {
      lines.push('👤 Not assigned yet');
    }
    if (p.id) lines.push(`🔗 https://app.followupboss.com/2/people/view/${p.id}`);
    return lines.join('\n');
  }

  async function postLead(personId, { test = false } = {}) {
    const c = cfg();
    if (!c?.apiKey || !c.channelId) return;
    c.posted = c.posted || [];
    if (!test && c.posted.includes(personId)) return; // Follow Up Boss can retry; never post twice
    const p = await fub(`/people/${personId}?fields=allFields`);
    const text = (test ? '🧪 _Test: this is your most recent Follow Up Boss contact._\n' : '') + formatLead(p);
    core.postMessage(fubBot(), c.channelId, text);
    if (!test) {
      c.posted.push(personId);
      if (c.posted.length > 2000) c.posted = c.posted.slice(-1000);
      c.lastLeadAt = Date.now();
    }
    core.save();
  }

  // ----- Webhook receiver -----
  app.post('/hooks/fub/:secret', (req, res) => {
    const c = cfg();
    const ok = c?.secret && req.params.secret.length === c.secret.length
      && crypto.timingSafeEqual(Buffer.from(req.params.secret), Buffer.from(c.secret));
    if (!ok) return res.status(404).end();
    res.status(200).json({ ok: true }); // answer right away; Follow Up Boss expects a fast reply
    const body = req.body || {};
    let ids = Array.isArray(body.resourceIds) ? body.resourceIds : [];
    if (!ids.length && typeof body.uri === 'string') {
      const m = body.uri.match(/[?&]id=([\d,]+)/) || body.uri.match(/\/people\/(\d+)/);
      if (m) ids = m[1].split(',');
    }
    for (const id of ids.slice(0, 25)) {
      postLead(Number(id)).catch((e) => console.error('FUB lead post failed', id, e.message));
    }
  });

  // ----- Admin controls (called from the Settings screen) -----
  function status() {
    const c = cfg();
    if (!c) return { connected: false };
    return {
      connected: !!c.apiKey, channelId: c.channelId, keyHint: c.apiKey ? '••••' + c.apiKey.slice(-4) : '',
      account: c.account || '', webhook: !!c.webhookId, webhookNote: c.webhookNote || '', lastLeadAt: c.lastLeadAt || null,
      systemKeySet: !!c.systemKey,
    };
  }

  async function connect({ apiKey, systemKey, channelId, baseUrl }) {
    apiKey = String(apiKey || cfg()?.apiKey || '').trim();
    systemKey = String(systemKey ?? cfg()?.systemKey ?? '').trim();
    if (!apiKey) throw new Error('Paste your Follow Up Boss API key.');
    const channel = core.db.channels[channelId];
    if (!channel || channel.isDM) throw new Error('Pick a channel for lead alerts.');
    // 1) Check the key works.
    const me = await fub('/identity', { apiKey, systemKey }).catch(async (e) => {
      if (e.status === 404) return fub('/me', { apiKey, systemKey });
      throw e;
    });
    const account = me?.account?.name || me?.name || [me?.firstName, me?.lastName].filter(Boolean).join(' ') || 'Connected';
    const old = cfg();
    const next = { apiKey, systemKey, channelId, account, secret: old?.secret || crypto.randomBytes(24).toString('hex'), posted: old?.posted || [], lastLeadAt: old?.lastLeadAt || null, webhookId: old?.webhookId || null };
    setCfg(next);
    // 2) Register the webhook (needs a public https address).
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) {
      next.webhookNote = 'Saved. Lead alerts start once Kaizen HQ is running on a secure https:// address. Open Settings from that address and press Connect again.';
      core.save();
      return status();
    }
    const url = `${base}/hooks/fub/${next.secret}`;
    if (next.webhookId) await fub(`/webhooks/${next.webhookId}`, { method: 'DELETE' }).catch(() => {});
    try {
      const hook = await fub('/webhooks', { method: 'POST', body: { event: 'peopleCreated', url } });
      next.webhookId = hook?.id || null;
      next.webhookNote = '';
    } catch (e) {
      next.webhookId = null;
      next.webhookNote = e.status === 401 || e.status === 403
        ? `${e.message}. Follow Up Boss only lets the account owner create webhooks, and may require a registered system key. Register free at apps.followupboss.com/system-registration (system name: ${SYSTEM_NAME}), paste the key under "System key", and press Connect again.`
        : e.message;
    }
    core.save();
    return status();
  }

  async function disconnect() {
    const c = cfg();
    if (c?.webhookId) await fub(`/webhooks/${c.webhookId}`, { method: 'DELETE' }).catch(() => {});
    setCfg(null);
    return status();
  }

  async function test() {
    const c = cfg();
    if (!c?.apiKey) throw new Error('Connect Follow Up Boss first.');
    const list = await fub('/people?sort=-created&limit=1&fields=id');
    const p = list?.people?.[0];
    if (!p) throw new Error('Connected, but there are no contacts in Follow Up Boss yet.');
    await postLead(p.id, { test: true });
    return { ok: true };
  }

  return { status, connect, disconnect, test, _formatLead: formatLead };
}

module.exports = { mountIntegrations };
