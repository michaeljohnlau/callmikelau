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

// What the team does first for each kind of lead. Editable in Settings → Integrations.
// {name}, {first} and {address} are filled in from the lead.
const DEFAULT_PLAYBOOKS = {
  seller: { pin: true, steps: ['Call {first} within 5 minutes', 'Prepare CMA for {address}', 'Book the listing appointment'] },
  buyer: { pin: false, steps: ['Call {first} within 5 minutes', 'Send matching listings'] },
  other: { pin: false, steps: ['Call {first} within 5 minutes'] },
};
const TYPE_LABEL = { seller: '🏡 New SELLER lead', buyer: '🔑 New BUYER lead', other: '🆕 New lead' };

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

  const playbooks = () => {
    const saved = cfg()?.playbooks || {};
    return Object.fromEntries(Object.entries(DEFAULT_PLAYBOOKS).map(([k, d]) => [k, { ...d, ...(saved[k] || {}) }]));
  };

  // Seller, buyer or other, based on the inquiry type, tags, source and stage in Follow Up Boss.
  function classify(p, events) {
    const hay = [...events.map((e) => `${e.type || ''} ${e.description || ''}`), ...(p.tags || []), p.source, p.stage, p.type]
      .filter(Boolean).join(' ').toLowerCase();
    if (/seller|selling|sell my|home ?value|valuation|cma|what'?s my home worth|listing appointment|list my/.test(hay)) return 'seller';
    if (/buyer|buying|property inquiry|viewed property|saved property|showing|pre-?approv|first.?time/.test(hay)) return 'buyer';
    return 'other';
  }

  function addressOf(a) {
    if (!a) return '';
    return [a.street, a.city, a.state || a.province].filter(Boolean).map(clean).join(', ');
  }

  function buildLead(p, events, { test = false } = {}) {
    const type = classify(p, events);
    const ev = events.find((e) => e.property || e.message) || events[0] || {};
    const name = clean(p.name || [p.firstName, p.lastName].filter(Boolean).join(' ')) || 'New contact';
    const first = clean(p.firstName) || name.split(' ')[0];
    const propertyAddr = addressOf(ev.property);
    const homeAddr = addressOf((p.addresses || [])[0]);
    // For sellers, the property they asked about is usually their own home.
    const address = type === 'seller' ? (propertyAddr || homeAddr) : homeAddr;
    const phone = (p.phones || []).map((x) => x.value).filter(Boolean)[0];
    const email = (p.emails || []).map((x) => x.value).filter(Boolean)[0];

    const lines = [];
    if (test) lines.push('🧪 _Test: this is your most recent Follow Up Boss contact._');
    lines.push(`**${TYPE_LABEL[type]}: ${name}**`);
    const contact = [phone && `📞 ${phone}`, email && `✉️ ${email}`].filter(Boolean).join('  ·  ');
    if (contact) lines.push(contact);
    if (type === 'seller') lines.push(address ? `🏠 Property: **${address}**` : '🏠 Property: _no address given. Ask on the first call_');
    else if (propertyAddr) lines.push(`🏠 Interested in: ${propertyAddr}${ev.property?.price ? ` ($${Number(ev.property.price).toLocaleString('en-CA')})` : ''}`);
    if (type !== 'seller' && homeAddr) lines.push(`📍 ${homeAddr}`);
    const meta = [ev.type && `Inquiry: ${clean(ev.type)}`, p.source && `Source: ${clean(p.source)}`, p.stage && `Stage: ${clean(p.stage)}`, p.price && `Price: $${Number(p.price).toLocaleString('en-CA')}`].filter(Boolean).join('  ·  ');
    if (meta) lines.push(meta);
    const msg = clean(ev.message || ev.description);
    if (msg) lines.push(`> ${msg.slice(0, 300).replace(/\n+/g, ' ')}`);
    if (p.tags?.length) lines.push(`🏷️ ${p.tags.slice(0, 8).map(clean).join(', ')}`);
    const assigned = clean(p.assignedTo);
    if (assigned) {
      const member = Object.values(core.db.users).find((u) => !u.isBot && !u.disabled && u.name.toLowerCase() === assigned.toLowerCase());
      lines.push(`👤 Assigned to ${member ? '@' + member.name : assigned}`);
    } else {
      lines.push('👤 Not assigned yet. Claim a step below to take it');
    }
    if (p.id) lines.push(`🔗 https://app.followupboss.com/2/people/view/${p.id}`);

    const pb = playbooks()[type];
    const fill = (t) => t.replace(/\{name\}/g, name).replace(/\{first\}/g, first)
      .replace(/\{address\}/g, address || '(address to confirm)');
    return {
      type, text: lines.join('\n'), tasks: (pb.steps || []).map(fill).filter(Boolean), pin: !!pb.pin,
      lead: { personId: p.id, name, url: p.id ? `https://app.followupboss.com/2/people/view/${p.id}` : '', type, address: address || propertyAddr || '' },
    };
  }

  // Backwards-compatible helper used by tests.
  const formatLead = (p) => buildLead(p, []).text;

  async function postLead(personId, { test = false } = {}) {
    const c = cfg();
    if (!c?.apiKey || !c.channelId) return;
    c.posted = c.posted || [];
    if (!test && c.posted.includes(personId)) return; // Follow Up Boss can retry; never post twice
    const p = await fub(`/people/${personId}?fields=allFields`);
    // The inquiry (type, message, property address) lives in the person's events.
    const events = await fub(`/events?personId=${personId}&limit=5&sort=-created`).then((r) => r?.events || []).catch(() => []);
    const lead = buildLead(p, events, { test });
    core.postMessage(fubBot(), c.channelId, lead.text, null, { tasks: lead.tasks, pin: lead.pin, leadType: lead.type, lead: lead.lead });
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
    if (!c) return { connected: false, playbooks: playbooks() };
    return {
      connected: !!c.apiKey, channelId: c.channelId, keyHint: c.apiKey ? '••••' + c.apiKey.slice(-4) : '',
      account: c.account || '', webhook: !!c.webhookId, webhookNote: c.webhookNote || '', lastLeadAt: c.lastLeadAt || null,
      systemKeySet: !!c.systemKey, playbooks: playbooks(),
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

  // ----- Hot leads: anyone in Follow Up Boss whose stage or tags say "Hot" -----
  let hotCache = [];
  let hotTimer = null;
  async function refreshHot() {
    const c = cfg();
    if (!c?.apiKey) { hotCache = []; return; }
    const fields = 'id,name,firstName,lastName,stage,tags,source,addresses,assignedTo';
    const data = await fub(`/people?sort=-updated&limit=100&fields=${fields}`)
      .catch(() => fub(`/people?limit=100&fields=${fields}`));
    const people = data?.people || [];
    hotCache = people
      .filter((p) => /hot/i.test(p.stage || '') || (p.tags || []).some((t) => /^hot\b|\bhot$/i.test(String(t).trim())))
      .map((p) => {
        const name = clean(p.name || [p.firstName, p.lastName].filter(Boolean).join(' '));
        const addr = addressOf((p.addresses || [])[0]);
        return { personId: p.id, name, detail: [clean(p.stage), addr, p.assignedTo && `→ ${clean(p.assignedTo).split(' ')[0]}`].filter(Boolean).join(' · '), url: `https://app.followupboss.com/2/people/view/${p.id}`, source: 'fub' };
      });
    c.hotRefreshedAt = Date.now();
    core.dashboardChanged();
  }
  function scheduleHot() {
    clearInterval(hotTimer);
    if (!cfg()?.apiKey) { hotCache = []; return; }
    refreshHot().catch((e) => console.error('Hot lead refresh failed:', e.message));
    hotTimer = setInterval(() => refreshHot().catch((e) => console.error('Hot lead refresh failed:', e.message)), 5 * 60 * 1000);
    hotTimer.unref?.();
  }
  setTimeout(scheduleHot, 2000).unref?.();

  function savePlaybooks(input) {
    const c = cfg();
    if (!c) throw new Error('Connect Follow Up Boss first.');
    const next = {};
    for (const k of Object.keys(DEFAULT_PLAYBOOKS)) {
      const v = (input && input[k]) || {};
      const steps = Array.isArray(v.steps) ? v.steps : String(v.steps || '').split('\n');
      next[k] = { pin: !!v.pin, steps: steps.map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 10) };
    }
    c.playbooks = next;
    core.save();
    return status();
  }

  return {
    status, test, savePlaybooks, _formatLead: formatLead, _buildLead: buildLead,
    connect: async (d) => { const r = await connect(d); scheduleHot(); return r; },
    disconnect: async () => { const r = await disconnect(); scheduleHot(); core.dashboardChanged(); return r; },
    hotLeads: () => hotCache,
    refreshHot,
  };
}

module.exports = { mountIntegrations };
