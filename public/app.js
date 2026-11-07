// Kaizen HQ — client
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const TOKEN_KEY = 'kaizenhq_token';
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };

  const S = {
    socket: null, me: null, users: {}, online: new Set(), channels: {}, browse: {},
    current: null, messages: {}, hasMore: {}, thread: null, threadReplies: [], typing: {},
    prefs: { notify: {}, sound: 'chime', pauseUntil: 0 },
    view: 'today', today: null,
    collapsed: new Set(JSON.parse(store.get('kaizenhq_collapsed') || '[]')),
  };
  const EMOJI = ['👍', '🎉', '🔥', '🙌', '❤️', '😂', '👀', '✅', '🏡', '🔑', '💯', '🙏', '😮', '💪', '📈', '⭐'];

  // ---------- Auth ----------
  let mode = 'login';
  async function initAuth() {
    const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
    document.title = cfg.workspace || 'Kaizen HQ';
    $('#auth-title').textContent = cfg.workspace || 'Kaizen HQ';
    if (cfg.branding?.logo) $('#auth-mark').innerHTML = `<img src="${esc(cfg.branding.logo)}" alt="">`;
    if (cfg.inviteRequired) document.querySelectorAll('.invite-only').forEach((e) => e.classList.remove('hidden'));
    setMode(cfg.hasUsers ? 'login' : 'register');
    if (store.get(TOKEN_KEY)) connect(store.get(TOKEN_KEY));
    else $('#auth').classList.remove('hidden');
  }
  function setMode(m) {
    mode = m;
    $('#auth').classList.toggle('login-mode', m === 'login');
    document.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
    $('#auth-submit').textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('#auth-form').password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').textContent = '';
  }
  document.querySelectorAll('.auth-tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.tab)));
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { email: f.email.value, password: f.password.value };
    if (mode === 'register') Object.assign(body, { name: f.name.value, title: f.title.value, invite: f.invite.value });
    const res = await fetch('/api/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { $('#auth-error').textContent = data.error || 'Something went wrong.'; return; }
    store.set(TOKEN_KEY, data.token);
    connect(data.token);
  });
  $('#logout').addEventListener('click', async (e) => {
    e.stopPropagation();
    // Stop sending this device notifications for this account.
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { S.socket?.emit('push:unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    } catch {}
    await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + store.get(TOKEN_KEY) } });
    store.del(TOKEN_KEY);
    location.reload();
  });

  // ---------- Socket ----------
  function connect(token) {
    const socket = io({ auth: { token } });
    S.socket = socket;
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') { store.del(TOKEN_KEY); socket.close(); $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden'); setMode('login'); }
    });
    socket.on('init', (d) => {
      S.me = d.me;
      S.prefs = d.prefs || S.prefs;
      S.dash = d.dashboard || null;
      S.templates = d.templates || [];
      S.branding = d.branding || null;
      S.users = Object.fromEntries(d.users.map((u) => [u.id, u]));
      S.online = new Set(d.online);
      S.channels = Object.fromEntries(d.channels.map((c) => [c.id, c]));
      S.browse = Object.fromEntries(d.browse.map((c) => [c.id, c]));
      $('#ws-name').textContent = d.workspace;
      renderBranding();
      $('#auth').classList.add('hidden');
      $('#app').classList.remove('hidden');
      renderMe();
      renderSidebar();
      renderDashboard();
      const fromLink = new URLSearchParams(location.search).get('c');
      if (fromLink) history.replaceState(null, '', '/');
      const last = store.get('kaizenhq_last');
      const start = [fromLink, last].find((id) => id && S.channels[id]) || (Object.values(S.channels).find((c) => c.name === 'general') || Object.values(S.channels)[0])?.id;
      S.messages = {};
      // Home screen is "Today" unless the app was opened from a notification for a specific channel.
      if (fromLink && S.channels[fromLink]) openChannel(fromLink);
      else { if (start) S.current = start; showToday(); }
      refreshToday();
      socket.emit('visible', { visible: !document.hidden });
      setupAppBanners();
      const sw = $('#storage-banner');
      if (d.storageWarning) { sw.querySelector('.banner-text').textContent = '⚠️ Admin: ' + d.storageWarning; sw.classList.remove('hidden'); }
      else sw.classList.add('hidden');
    });
    socket.on('presence', ({ userId, online }) => { online ? S.online.add(userId) : S.online.delete(userId); renderSidebar(); });
    socket.on('user:new', (u) => { S.users[u.id] = u; renderSidebar(); });
    socket.on('user:remove', ({ id }) => { delete S.users[id]; renderSidebar(); });
    socket.on('prefs', (p) => { S.prefs = p; renderSidebar(); renderHeader(); });
    socket.on('channel:archived', ({ channelId, archived }) => {
      const c = S.channels[channelId] || S.browse[channelId];
      if (!c) return;
      c.archived = archived;
      renderSidebar();
      if (channelId === S.current) { renderHeader(); updateComposer(); }
    });
    socket.on('user:update', (u) => { S.users[u.id] = u; if (u.id === S.me.id) { S.me = u; renderMe(); } renderSidebar(); renderMessages(); renderThread(); });
    socket.on('dashboard', (d) => { S.dash = d; renderDashboard(); refreshToday(); });
    socket.on('channel:meta', ({ channelId, stage, links }) => {
      const c = S.channels[channelId];
      if (!c) return;
      c.stage = stage; c.links = links;
      if (channelId === S.current) renderChecklist();
    });
    socket.on('templates', (t) => { S.templates = t; renderChecklist(); });
    socket.on('branding', (b) => { S.branding = b; renderBranding(); });
    socket.on('channel:checklist', ({ channelId, checklist }) => {
      if (!S.channels[channelId]) return;
      S.channels[channelId].checklist = checklist;
      refreshToday();
      if (S.messages[channelId] && viewing(channelId)) { const box = $('#messages'); const top = box.scrollTop; renderMessages(); box.scrollTop = top; }
      renderThread();
      if (channelId === S.current) { renderChecklist(); renderHeader(); }
    });
    socket.on('message:new', onNewMessage);
    socket.on('message:update', onUpdateMessage);
    socket.on('typing', onTyping);
    socket.on('channel:joined', (c) => { S.channels[c.id] = c; delete S.browse[c.id]; renderSidebar(); });
    socket.on('channel:deleted', ({ channelId, by }) => {
      const wasHere = viewing(channelId);
      const name = S.channels[channelId] ? fullLabel(S.channels[channelId]) : '';
      delete S.channels[channelId]; delete S.browse[channelId]; delete S.messages[channelId];
      if (S.current === channelId) { S.current = (Object.values(S.channels).find((x) => x.name === 'general') || {}).id; if (wasHere) showToday(); }
      if (wasHere && by !== S.me.name) toast(`${by} deleted #${name}`);
      renderSidebar(); refreshToday();
    });
    socket.on('channel:removed', ({ channelId, browse }) => {
      delete S.channels[channelId];
      if (browse) S.browse[channelId] = browse; else delete S.browse[channelId];
      if (S.current === channelId) openChannel((Object.values(S.channels).find((x) => x.name === 'general') || Object.values(S.channels)[0])?.id);
      renderSidebar();
    });
    socket.on('channel:privacy', ({ channelId, isPrivate }) => {
      if (!S.channels[channelId]) return;
      S.channels[channelId].isPrivate = isPrivate;
      renderSidebar();
      if (channelId === S.current) renderHeader();
    });
    socket.on('channel:left', (c) => {
      delete S.channels[c.channelId];
      S.browse[c.channelId] = { ...c, id: c.channelId };
      if (S.current === c.channelId) openChannel((Object.values(S.channels).find((x) => x.name === 'general') || Object.values(S.channels)[0])?.id);
      renderSidebar();
    });
    socket.on('channel:available', (c) => { if (!S.channels[c.id]) S.browse[c.id] = c; });
    socket.on('channel:members', ({ channelId, members }) => { if (S.channels[channelId]) { S.channels[channelId].members = members; if (channelId === S.current) renderHeader(); } });
    socket.on('channel:topic', ({ channelId, topic }) => { if (S.channels[channelId]) { S.channels[channelId].topic = topic; if (channelId === S.current) renderHeader(); } });
  }

  // ---------- Helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  function avatar(u, cls = '') {
    if (!u) return `<div class="avatar ${cls}" style="background:#ccc">?</div>`;
    if (u.isBot) return `<div class="avatar bot ${cls}">✦</div>`;
    if (u.avatar) return `<img class="avatar ${cls}" src="${esc(u.avatar)}" alt="" loading="lazy" decoding="async">`;
    return `<div class="avatar ${cls}" style="background:${u.color}">${esc(initials(u.name))}</div>`;
  }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function fmtDay(ts) {
    const d = new Date(ts), t = new Date();
    const y = new Date(); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() !== t.getFullYear() ? 'numeric' : undefined });
  }
  // Full name for headers and notifications, e.g. "listings › 24 Juniper Crescent".
  function fullLabel(c) {
    if (c.isDM) return channelLabel(c);
    const parent = c.parentId && (S.channels[c.parentId] || S.browse[c.parentId]);
    return parent ? `${parent.name} › ${c.label || c.name}` : c.name;
  }
  function channelLabel(c) {
    if (!c.isDM) return c.label || c.name;
    const others = c.members.filter((id) => id !== S.me.id);
    if (!others.length) return (S.me.name) + ' (you)';
    return others.map((id) => S.users[id]?.name || 'Unknown').join(', ');
  }
  function format(text) {
    let s = esc(text);
    const blocks = [];
    s = s.replace(/```([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre>${code.replace(/^\n/, '')}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { blocks.push(`<code>${c}</code>`); return `\u0000${blocks.length - 1}\u0000`; });
    s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g, (_, a, b) => `<strong>${a || b}</strong>`);
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
    s = s.replace(/~([^~\n]+)~/g, '<del>$1</del>');
    s = s.replace(/^&gt; ?(.*)$\n?/gm, '<blockquote>$1</blockquote>');
    const names = Object.values(S.users).flatMap((u) => [u.name, u.name.split(' ')[0]]).sort((a, b) => b.length - a.length).map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`@(here|channel|everyone${names.length ? '|' + names.join('|') : ''})\\b`, 'gi');
    s = s.replace(re, '<span class="mention">@$1</span>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
    return s;
  }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  const mentionsMe = (m) => (m.mentions || []).includes(S.me.id) || (m.mentions || []).includes('*');

  // ---------- Sidebar ----------
  function renderMe() {
    $('#me-avatar').outerHTML = avatar(S.me).replace('class="avatar ', 'id="me-avatar" class="avatar ');
    $('#me-name').textContent = S.me.name;
    $('#me-status').textContent = S.me.status || S.me.title || 'Set a status';
  }
  function renderSidebar() {
    if (!S.me) return;
    const all = Object.values(S.channels).filter((c) => !c.archived || c.id === S.current);
    $('#today-item').classList.toggle('active', S.view === 'today');
    $('#team-item').classList.toggle('active', S.view === 'team');
    $('#team-item').classList.toggle('hidden', !S.me.isAdmin);
    const byName = (a, b) => channelLabel(a).localeCompare(channelLabel(b), undefined, { numeric: true });
    const tops = all.filter((c) => !c.isDM && !c.parentId).sort(byName);
    const dms = all.filter((c) => c.isDM).sort(byName);
    const childrenOf = (id) => all.filter((c) => c.parentId === id).sort(byName);
    const muted = (c) => levelOf(c) === 'mute';
    // Same rule as the app-icon badge: DMs and "All messages" channels count every unread message, others count @mentions.
    const badgeFor = (c) => (viewing(c.id) || muted(c) ? 0 : c.isDM || levelOf(c) === 'all' ? c.unread : c.mentions) || 0;
    const item = (c, { child = false, kids = [] } = {}) => {
      const isOpen = !S.collapsed.has(c.id);
      const hidden = kids.length && !isOpen ? kids : [];
      const unreadHere = (c.unread && c.id !== S.current && !muted(c)) || hidden.some((k) => k.unread && !muted(k));
      const cls = ['side-item', child && 'child', viewing(c.id) && 'active', unreadHere && 'unread', muted(c) && 'muted-chan', c.archived && 'archived'].filter(Boolean).join(' ');
      let icon = c.isPrivate ? '<span class="hash lock">🔒</span>' : '<span class="hash">#</span>';
      if (c.isDM) {
        const other = c.members.find((id) => id !== S.me.id) || S.me.id;
        icon = S.users[other]?.isBot ? '<span class="hash">✦</span>' : `<span class="dot${S.online.has(other) ? ' on' : ''}"></span>`;
      } else if (child) icon = c.isPrivate ? '<span class="hash lock">🔒</span>' : '<span class="hash sub">⌂</span>';
      const caret = kids.length ? `<button class="caret${isOpen ? ' open' : ''}" data-toggle="${c.id}" aria-label="${isOpen ? 'Collapse' : 'Expand'}">▸</button>` : '';
      const count = badgeFor(c) + hidden.reduce((n, k) => n + badgeFor(k), 0);
      const badge = count ? `<span class="badge">${count}</span>` : '';
      const bell = muted(c) ? '<span class="mute-icon" title="Muted">🔕</span>' : '';
      return `<li class="${cls}" data-id="${c.id}">${icon}<span class="label">${esc(channelLabel(c))}</span>${bell}${badge}${caret}</li>`;
    };
    $('#channel-list').innerHTML = tops.map((c) => {
      const kids = childrenOf(c.id);
      const open = !S.collapsed.has(c.id);
      return item(c, { kids }) + (kids.length && open ? kids.map((k) => item(k, { child: true })).join('') : '');
    }).join('');
    $('#dm-list').innerHTML = dms.map((c) => item(c)).join('') || '<li class="side-item muted" id="dm-empty"><span class="label">Start a conversation</span></li>';
    const total = Object.values(S.channels).reduce((n, c) => n + badgeFor(c), 0);
    document.title = (total ? `(${total}) ` : '') + ($('#ws-name').textContent || 'Kaizen HQ');
    if (navigator.setAppBadge) (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
  }
  $('#channel-list').addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      e.stopPropagation();
      S.collapsed.has(t.dataset.toggle) ? S.collapsed.delete(t.dataset.toggle) : S.collapsed.add(t.dataset.toggle);
      store.set('kaizenhq_collapsed', JSON.stringify([...S.collapsed]));
      return renderSidebar();
    }
    const li = e.target.closest('[data-id]');
    if (li) openChannel(li.dataset.id);
  });
  $('#dm-list').addEventListener('click', (e) => { const li = e.target.closest('[data-id]'); if (li) openChannel(li.dataset.id); else if (e.target.closest('#dm-empty')) newDM(); });
  $('#menu-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#sidebar').classList.toggle('open'); });
  // Phones: tapping anywhere outside the open sidebar closes it.
  document.querySelector('.main').addEventListener('click', () => $('#sidebar').classList.remove('open'), true);

  // ---------- Channel ----------
  function openChannel(id) {
    if (!id || !S.channels[id]) return;
    S.view = 'channel';
    document.body.classList.remove('view-today', 'view-team');
    $('#today-view').classList.add('hidden');
    S.current = id;
    store.set('kaizenhq_last', id);
    S.channels[id].unread = 0;
    S.channels[id].mentions = 0;
    S.socket.emit('read', { channelId: id });
    $('#sidebar').classList.remove('open');
    renderSidebar();
    clOpen = null;
    renderHeader();
    renderChecklist();
    renderTyping();
    const c = S.channels[id];
    if (c.parentId) { S.collapsed.delete(c.parentId); }
    updateComposer();
    if (!S.messages[id]) {
      $('#messages').innerHTML = '';
      S.socket.emit('history', { channelId: id }, (r) => {
        if (r.error) return;
        S.messages[id] = r.messages;
        S.hasMore[id] = r.hasMore;
        if (S.current === id) { renderMessages(); scrollBottom(); renderHeader(); }
      });
    } else { renderMessages(); scrollBottom(); }
    if (window.innerWidth > 760) $('#composer-input').focus();
  }
  function updateComposer() {
    const c = S.channels[S.current];
    if (!c) return;
    const input = $('#composer-input');
    input.disabled = !!c.archived;
    input.placeholder = c.archived ? 'This channel is archived. Open channel details to unarchive it.' : c.isDM ? `Message ${channelLabel(c)}` : `Message #${channelLabel(c)}`;
  }
  function renderHeader() {
    const c = S.channels[S.current];
    if (!c) return;
    $('#chan-title').innerHTML = c.isDM ? esc(channelLabel(c)) : c.parentId
      ? `<span class="crumb" data-open="${c.parentId}"># ${esc((S.channels[c.parentId] || S.browse[c.parentId] || {}).name || '')}</span> <span class="crumb-sep">›</span> ${esc(c.label || c.name)}${c.archived ? ' <span class="tag">Archived</span>' : ''}`
      : `${c.isPrivate ? '🔒 ' : '# '}${esc(c.name)}${c.archived ? ' <span class="tag">Archived</span>' : ''}`;
    const lvl = levelOf(c);
    const bell = $('#bell-btn');
    bell.textContent = lvl === 'mute' ? '🔕' : '🔔';
    bell.classList.toggle('dim', lvl === 'mute');
    bell.title = `Notifications: ${LEVEL_TEXT[lvl]}`;
    const other = c.isDM && S.users[c.members.find((x) => x !== S.me.id)];
    $('#chan-topic').textContent = c.isDM ? (other ? [other.title, other.status].filter(Boolean).join(' · ') : '') : (c.topic || 'Add a topic');
    $('#members-btn').textContent = `👥 ${c.members.length}`;
    const cl = c.checklist || [];
    $('#cl-btn').classList.toggle('hidden', c.isDM);
    $('#cl-btn').classList.toggle('active', clVisible());
    $('#cl-btn').innerHTML = cl.length ? `☑ ${cl.filter((t) => t.doneBy).length}/${cl.length}` : '☑';
    const pinCount = (S.messages[c.id] || []).filter((m) => m.pinned && !m.deleted).length;
    $('#pins-btn').innerHTML = pinCount ? `📌<span class="pin-count">${pinCount}</span>` : '📌';
  }
  $('#chan-title').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b && S.channels[b.dataset.open]) openChannel(b.dataset.open); });
  $('#bell-btn').addEventListener('click', () => channelNotifyModal(S.channels[S.current]));
  $('#chan-topic').addEventListener('click', () => {
    const c = S.channels[S.current];
    if (!c || c.isDM) return;
    modal('Edit topic', `<div class="field"><input id="topic-input" type="text" autocomplete="off" value="${esc(c.topic || '')}" maxlength="200" placeholder="What is this channel for?"></div><div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn-gold" id="topic-save">Save</button></div>`);
    const inp = $('#topic-input'); inp.focus();
    const go = () => { S.socket.emit('channel:topic', { channelId: c.id, topic: inp.value }); closeModal(); };
    $('#topic-save').onclick = go; inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  });
  const canManage = (c) => c && !c.isDM && (c.createdBy === S.me.id || S.me.isAdmin);
  function channelDetails() {
    const c = S.channels[S.current];
    if (!c) return;
    const manage = canManage(c);
    const rows = c.members.map((id) => S.users[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map((u) =>
      `<div class="list-row" data-user="${u.id}">${avatar(u)}<div class="grow"><div><strong>${esc(u.name)}</strong>${u.isBot ? ` <span class="tag">${u.integration ? 'App' : 'AI'}</span>` : ''}${u.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</div><div class="sub">${esc(u.title || '')}${S.online.has(u.id) ? ' · <span style="color:var(--online)">Active</span>' : ''}</div></div>
        ${c.isPrivate && manage && u.id !== S.me.id && !c.isDM ? `<button class="btn small-btn danger" data-remove="${u.id}">Remove</button>` : ''}</div>`).join('');
    const canArchive = !c.isDM && !c.isDefault && manage;
    const actions = [];
    if (!c.isDM && !c.parentId) actions.push(`<button class="btn" id="add-sub">＋ Add sub-channel</button>`);
    if (!c.isDM && (!c.isPrivate || manage)) actions.push(`<button class="btn" id="add-people">＋ Add people</button>`);
    if (!c.isDM) actions.push(`<button class="btn" id="chan-notify">🔔 ${LEVEL_TEXT[levelOf(c)]}</button>`);
    if (canArchive) actions.push(`<button class="btn" id="archive-chan">${c.archived ? 'Unarchive' : '🗄 Archive'}</button>`);
    if (canArchive) actions.push(`<button class="btn danger" id="delete-chan">🗑 Delete</button>`);
    if (!c.isDM && c.name !== 'general' && !c.isDefault) actions.push(`<button class="btn" id="leave-chan">Leave</button>`);
    const privacy = c.isDM ? '' : `<div class="privacy-row ${c.isPrivate ? 'is-private' : ''}">
        <div class="grow"><strong>${c.isPrivate ? '🔒 Private' : '🌐 Open to everyone'}</strong>
          <div class="sub">${c.isPrivate ? 'Only the people below can see this channel. It is hidden from everyone else.' : 'Anyone on the team can find and join this channel.'}</div></div>
        ${manage && !(c.name === 'general' && !c.parentId) ? `<button class="btn" id="toggle-private">${c.isPrivate ? 'Make it open' : 'Make it private'}</button>` : ''}
      </div>`;
    modal(c.isDM ? 'Conversation' : `${c.isPrivate ? '🔒 ' : '#'}${fullLabel(c)}`, privacy + (actions.length ? `<div class="detail-actions">${actions.join('')}</div>` : '') + `<h4 class="modal-sub">${c.members.length} member${c.members.length === 1 ? '' : 's'}</h4>` + rows);
    $('#modal-body').onclick = (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        const who = S.users[rm.dataset.remove]?.name;
        if (confirm(`Remove ${who} from this private channel? They will no longer see it.`)) S.socket.emit('channel:removeMember', { channelId: c.id, userId: rm.dataset.remove }, (r) => { if (r.error) toast(r.error); else setTimeout(channelDetails, 200); });
        return;
      }
      const r = e.target.closest('[data-user]');
      if (r && r.dataset.user !== S.me.id && !e.target.closest('button')) { closeModal(); openDM(r.dataset.user); }
      if (e.target.id === 'leave-chan') { S.socket.emit('channel:leave', { channelId: c.id }); closeModal(); }
      if (e.target.id === 'add-sub') channelModal(c.id);
      if (e.target.id === 'add-people') addPeopleModal(c);
      if (e.target.id === 'chan-notify') channelNotifyModal(c);
      if (e.target.id === 'toggle-private') {
        const to = !c.isPrivate;
        if (to && !confirm(`Make #${fullLabel(c)} private? Only its ${c.members.length} current member${c.members.length === 1 ? '' : 's'} will be able to see it.`)) return;
        S.socket.emit('channel:privacy', { channelId: c.id, isPrivate: to }, (res) => { if (res.error) toast(res.error); else { toast(to ? '🔒 Channel is now private' : 'Channel is now open to everyone'); setTimeout(channelDetails, 200); } });
      }
      if (e.target.id === 'delete-chan') return deleteChannelModal(c);
      if (e.target.id === 'archive-chan') {
        if (!c.archived && !confirm(`Archive #${fullLabel(c)}? It will be hidden from the sidebar, but messages stay searchable and you can unarchive it any time.`)) return;
        S.socket.emit('channel:archive', { channelId: c.id, archived: !c.archived }, (res) => { if (res.error) toast(res.error); else { closeModal(); toast(c.archived ? 'Channel archived' : 'Channel unarchived'); } });
      }
    };
  }
  $('#members-btn').addEventListener('click', channelDetails);

  function peoplePicker(exclude = [], preselect = []) {
    const people = Object.values(S.users).filter((u) => !u.isBot && !exclude.includes(u.id)).sort((a, b) => a.name.localeCompare(b.name));
    if (!people.length) return '<p class="muted">Everyone on the team is already here.</p>';
    return `<div class="people-pick">${people.map((u) => `<label class="pick-row">${avatar(u, 'sm')}<span class="grow">${esc(u.name)}<small>${esc(u.title || '')}</small></span><input type="checkbox" value="${u.id}" ${preselect.includes(u.id) ? 'checked' : ''}></label>`).join('')}</div>`;
  }
  const pickedIds = (root) => [...root.querySelectorAll('.people-pick input:checked')].map((i) => i.value);

  function addPeopleModal(c) {
    modal(`Add people to ${c.isPrivate ? '🔒 ' : '#'}${fullLabel(c)}`, peoplePicker(c.members) + `<div class="modal-actions"><button class="btn" id="ap-back">Back</button><button class="btn-gold" id="ap-add">Add</button></div>`);
    $('#ap-back').onclick = channelDetails;
    $('#ap-add').onclick = () => {
      const ids = pickedIds($('#modal-body'));
      if (!ids.length) return toast('Choose at least one person.');
      S.socket.emit('channel:addMembers', { channelId: c.id, userIds: ids }, (r) => { if (r.error) toast(r.error); else { toast(`Added ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`); setTimeout(channelDetails, 200); } });
    };
  }
  $('#pins-btn').addEventListener('click', () => {
    const list = (S.messages[S.current] || []).filter((m) => m.pinned && !m.deleted);
    modal('Pinned messages', list.length ? list.map(resultRow).join('') : '<p class="muted">Nothing pinned yet. Hover a message and tap 📌 to keep it handy for the team.</p>');
    bindResults();
  });

  function renderMessages() {
    const list = S.messages[S.current];
    const box = $('#messages');
    if (!list) return;
    const c = S.channels[S.current];
    let html = '';
    if (S.hasMore[S.current]) html += '<div class="load-more"><button class="chip" id="load-more">Load earlier messages</button></div>';
    else html += `<div class="empty"><h3>${c.isDM ? esc(channelLabel(c)) : (c.parentId ? '' : '#') + esc(channelLabel(c))}</h3><div>${c.isDM ? 'This is the start of your conversation.' : esc(c.topic || 'This is the very beginning of the channel.')}</div></div>`;
    let prev = null;
    for (const m of list) {
      const day = fmtDay(m.ts);
      if (!prev || fmtDay(prev.ts) !== day) { html += `<div class="day-sep">${day}</div>`; prev = null; }
      const cont = prev && prev.userId === m.userId && m.ts - prev.ts < 5 * 60 * 1000 && !prev.deleted;
      html += msgHTML(m, cont);
      prev = m;
    }
    box.innerHTML = html;
    const lm = $('#load-more');
    if (lm) lm.onclick = loadMore;
  }
  function loadMore() {
    const list = S.messages[S.current];
    const id = S.current;
    const box = $('#messages');
    const h = box.scrollHeight;
    S.socket.emit('history', { channelId: id, before: list[0]?.ts }, (r) => {
      S.messages[id] = [...r.messages, ...list];
      S.hasMore[id] = r.hasMore;
      renderMessages();
      box.scrollTop = box.scrollHeight - h;
    });
  }
  function msgHTML(m, cont, inThread = false) {
    const u = S.users[m.userId];
    const reactions = Object.entries(m.reactions || {}).map(([e, ids]) => {
      const names = ids.map((id) => S.users[id]?.name.split(' ')[0]).filter(Boolean).join(', ');
      return `<button class="reaction${ids.includes(S.me.id) ? ' mine' : ''}" data-react="${esc(e)}" title="${esc(names)}">${e} ${ids.length}</button>`;
    }).join('');
    const thread = !inThread && m.replyCount ? `<button class="thread-link" data-thread="${m.id}">💬 ${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'} <span class="muted">Last reply ${fmtDay(m.lastReplyTs) === 'Today' ? fmtTime(m.lastReplyTs) : fmtDay(m.lastReplyTs)}</span></button>` : '';
    const mine = m.userId === S.me.id;
    const actions = m.deleted ? '' : `<div class="msg-actions">
        <button data-act="react" title="Add reaction">😊</button>
        ${!inThread ? '<button data-act="thread" title="Reply in thread">💬</button>' : ''}
        <button data-act="task" title="Make this a task">☑</button>
        <button data-act="pin" title="${m.pinned ? 'Unpin' : 'Pin'}">📌</button>
        ${m.lead ? `<button data-act="hot" title="${m.hot ? 'Not hot anymore' : 'Mark as a hot lead'}">${m.hot ? '🧊' : '🔥'}</button>` : ''}
        ${mine ? '<button data-act="edit" title="Edit">✏️</button>' : ''}
        ${mine || S.me.isAdmin ? '<button data-act="delete" title="Delete">🗑️</button>' : ''}
      </div>`;
    const body = m.deleted ? '<div class="msg-deleted">This message was deleted.</div>' : `<div class="msg-text">${format(m.text)}${m.edited ? ' <span class="edited">(edited)</span>' : ''}</div>`;
    return `<div class="msg${cont ? ' cont' : ''}${!m.deleted && mentionsMe(m) && m.userId !== S.me.id ? ' mentioned' : ''}" data-mid="${m.id}">
      <div class="msg-gutter">${avatar(u, 'lg')}<div class="time-hover">${fmtTime(m.ts).replace(/\s?[AP]M/i, '')}</div></div>
      <div class="msg-body">
        ${(m.pinned || m.hot) && !m.deleted ? `<div class="pin-flag">${m.pinned ? '📌 Pinned' : ''}${m.pinned && m.hot ? ' · ' : ''}${m.hot ? '<span class="hot-flag">🔥 Hot lead</span>' : ''}</div>` : ''}
        <div class="msg-head"><span class="msg-author" data-user="${m.userId}">${esc(u?.name || 'Unknown')}</span>${u?.isBot ? `<span class="tag">${u.integration ? 'App' : 'AI'}</span>` : ''}${u?.title ? `<span class="msg-role">${esc(u.title)}</span>` : ''}<span class="msg-time" title="${new Date(m.ts).toLocaleString()}">${fmtTime(m.ts)}</span></div>
        ${body}
        ${m.tasks && !m.deleted ? tasksHTML(m) : ''}
        ${!m.deleted ? msgTaskChips(m) : ''}
        ${reactions || thread ? `<div class="reactions">${reactions}${reactions ? '<button class="reaction add" data-act="react" title="Add reaction">＋</button>' : ''}</div>${thread}` : ''}
      </div>
      ${actions}
    </div>`;
  }
  function tasksHTML(m) {
    const done = m.tasks.filter((t) => t.doneBy).length;
    const rows = m.tasks.map((t) => {
      const who = (id) => (id === S.me.id ? 'You' : S.users[id]?.name.split(' ')[0] || 'Someone');
      let right;
      if (t.doneBy) right = `<span class="task-who done">✓ ${esc(who(t.doneBy))}</span>`;
      else if (t.claimedBy === S.me.id) right = `<button class="task-btn ghost" data-task="${t.id}" data-ta="unclaim">Release</button>`;
      else if (t.claimedBy) right = `<span class="task-who">🙋 ${esc(who(t.claimedBy))}</span>`;
      else right = `<button class="task-btn" data-task="${t.id}" data-ta="claim">I'll take it</button>`;
      return `<div class="task${t.doneBy ? ' is-done' : ''}${t.claimedBy && !t.doneBy ? ' is-claimed' : ''}">
        <button class="task-check" data-task="${t.id}" data-ta="${t.doneBy ? 'undo' : 'done'}" aria-label="${t.doneBy ? 'Reopen' : 'Mark done'}">${t.doneBy ? '✓' : ''}</button>
        <span class="task-label">${esc(t.label)}</span>${right}</div>`;
    }).join('');
    return `<div class="tasks"><div class="tasks-head">First steps <span>${done}/${m.tasks.length} done</span></div>${rows}</div>`;
  }

  function findMsg(id) {
    for (const list of Object.values(S.messages)) { const m = list.find((x) => x.id === id); if (m) return m; }
    if (S.thread?.id === id) return S.thread;
    return S.threadReplies.find((x) => x.id === id);
  }
  function onMsgClick(e) {
    const el = e.target.closest('[data-mid]');
    const author = e.target.closest('.msg-author');
    if (author && author.dataset.user !== S.me.id) return openDM(author.dataset.user);
    if (!el) return;
    const id = el.dataset.mid;
    const chip = e.target.closest('[data-topen]');
    if (chip) return openTaskEditor({ channelId: chip.dataset.ch, itemId: chip.dataset.topen });
    const tk = e.target.closest('[data-task]');
    if (tk) {
      tk.disabled = true;
      return S.socket.emit('task:update', { messageId: id, taskId: tk.dataset.task, action: tk.dataset.ta }, (res) => { if (res?.error) { toast(res.error); tk.disabled = false; } });
    }
    const r = e.target.closest('[data-react]');
    if (r) return S.socket.emit('reaction', { messageId: id, emoji: r.dataset.react });
    const t = e.target.closest('[data-thread]');
    if (t) return openThread(t.dataset.thread);
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'react') emojiPicker(a, (emoji) => S.socket.emit('reaction', { messageId: id, emoji }));
    if (act === 'thread') openThread(id);
    if (act === 'pin') S.socket.emit('message:pin', { messageId: id });
    if (act === 'task') { const mm = findMsg(id); if (mm) openTaskEditor({ create: { channelId: mm.channelId, label: plainText(mm.text), sourceMessageId: mm.id } }); }
    if (act === 'hot') { const mm = findMsg(id); S.socket.emit('lead:hot', { messageId: id, hot: !mm?.hot }, (r) => r?.error ? toast(r.error) : toast(mm?.hot ? 'Removed from hot leads' : '🔥 Added to hot leads')); }
    if (act === 'delete' && confirm('Delete this message? This cannot be undone.')) S.socket.emit('message:delete', { messageId: id });
    if (act === 'edit') startEdit(el, findMsg(id));
  }
  $('#messages').addEventListener('click', onMsgClick);
  $('#panel-body').addEventListener('click', onMsgClick);

  function startEdit(el, m) {
    const textEl = $('.msg-text', el);
    if (!textEl || !m) return;
    textEl.outerHTML = `<div class="edit-box"><textarea rows="3">${esc(m.text)}</textarea><div class="row"><button class="btn" data-x="cancel">Cancel</button><button class="btn-gold" data-x="save">Save</button><span class="muted" style="align-self:center">Enter to save · Esc to cancel</span></div></div>`;
    const ta = $('.edit-box textarea', el);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const done = (save) => { if (save && ta.value.trim() && ta.value.trim() !== m.text) S.socket.emit('message:edit', { messageId: m.id, text: ta.value }); renderMessages(); renderThread(); };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); };
    $('.edit-box', el).onclick = (e) => { e.stopPropagation(); if (e.target.dataset.x) done(e.target.dataset.x === 'save'); };
  }

  function scrollBottom(force = true) {
    const box = $('#messages');
    if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }

  function onNewMessage(m) {
    if (m.userId !== S.me.id && mentionsMe(m)) refreshToday();
    const c = S.channels[m.channelId];
    if (!c) return;
    if (m.parentId) {
      if (S.thread?.id === m.parentId) { S.threadReplies.push(m); renderThread(true); }
    } else {
      if (S.messages[m.channelId]) S.messages[m.channelId].push(m);
      if (viewing(m.channelId)) {
        renderMessages();
        renderHeader();
        scrollBottom(m.userId === S.me.id ? true : false);
        if (document.hasFocus()) S.socket.emit('read', { channelId: m.channelId });
      } else if (m.userId !== S.me.id) {
        c.unread = (c.unread || 0) + 1;
        if (mentionsMe(m)) c.mentions = (c.mentions || 0) + 1;
        renderSidebar();
      }
    }
    if (shouldAlert(m, c)) alert(m, c);
    clearTypingFor(m.channelId, m.userId);
  }
  function onUpdateMessage(m) {
    const list = S.messages[m.channelId];
    if (list) { const i = list.findIndex((x) => x.id === m.id); if (i >= 0) list[i] = { ...list[i], ...m }; }
    if (S.thread?.id === m.id) S.thread = { ...S.thread, ...m };
    const ti = S.threadReplies.findIndex((x) => x.id === m.id);
    if (ti >= 0) S.threadReplies[ti] = { ...S.threadReplies[ti], ...m };
    if (m.channelId === S.current) { const box = $('#messages'); const top = box.scrollTop; renderMessages(); box.scrollTop = top; renderHeader(); }
    renderThread();
  }
  // ---------- Notifications: levels, sounds, pause ----------
  const LEVEL_TEXT = { all: 'All new messages', mentions: 'Mentions & replies only', mute: 'Muted' };
  function levelOf(c) {
    if (!c) return 'all';
    const n = S.prefs.notify || {};
    return n[c.id] || (c.parentId && n[c.parentId]) || 'all';
  }
  const paused = () => (S.prefs.pauseUntil || 0) > Date.now();
  // Same rules as the server uses for push notifications.
  function shouldAlert(m, c) {
    if (m.userId === S.me.id || paused()) return false;
    const lvl = levelOf(c);
    if (lvl === 'mute') return false;
    if (m.parentId) {
      const mine = (S.thread?.id === m.parentId && (S.thread.userId === S.me.id || S.threadReplies.some((r) => r.userId === S.me.id)))
        || (S.messages[m.channelId] || []).some((x) => x.id === m.parentId && x.userId === S.me.id);
      return mine || mentionsMe(m);
    }
    return c.isDM || mentionsMe(m) || lvl === 'all';
  }
  function alert(m, c) {
    const lookingAtIt = !document.hidden && document.hasFocus() && viewing(m.channelId) && !m.parentId;
    if (!lookingAtIt || !document.hidden) playSound(S.prefs.sound, lookingAtIt ? 0.35 : 1);
    if (!document.hidden) return; // the app is on screen: sound + unread badge is enough
    if (S.pushOn) return; // the server's push notification covers this
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const u = S.users[m.userId];
    try {
      const n = new Notification(c.isDM ? u?.name : `${u?.name} in #${fullLabel(c)}`, { body: m.text.slice(0, 140), tag: m.channelId, icon: '/icons/icon-192.png' });
      n.onclick = () => { window.focus(); openChannel(m.channelId); n.close(); };
    } catch {}
  }

  // Sounds are generated in the browser, so there are no audio files to load.
  let audioCtx = null;
  const unlockAudio = () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  };
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));
  const SOUNDS = {
    chime: [[880, 0, 0.5, 'sine'], [1318.5, 0.12, 0.7, 'sine']],
    ding: [[1046.5, 0, 0.9, 'triangle']],
    pop: [[620, 0, 0.09, 'sine', 180]],
    marimba: [[523.25, 0, 0.25, 'sine'], [659.25, 0.08, 0.25, 'sine'], [783.99, 0.16, 0.45, 'sine']],
    soft: [[659.25, 0, 1.1, 'sine']],
  };
  const SOUND_NAMES = { chime: 'Chime', ding: 'Ding', pop: 'Pop', marimba: 'Marimba', soft: 'Soft', none: 'None (silent)' };
  function playSound(name, volume = 1) {
    const notes = SOUNDS[name];
    if (!notes) return;
    unlockAudio();
    if (!audioCtx || audioCtx.state !== 'running') return;
    const t0 = audioCtx.currentTime + 0.01;
    for (const [freq, at, dur, type, endFreq] of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0 + at);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + at + dur);
      const peak = (name === 'soft' ? 0.12 : 0.22) * volume;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.05);
    }
    if (navigator.vibrate && isMobile && document.hidden === false && volume === 1) navigator.vibrate(60);
  }

  function savePrefs(patch) {
    S.socket.emit('prefs:update', patch, (r) => { if (r?.prefs) { S.prefs = r.prefs; renderSidebar(); renderHeader(); } });
  }

  function channelNotifyModal(c) {
    if (!c) return;
    const lvl = (S.prefs.notify || {})[c.id];
    const inherited = !lvl && c.parentId && (S.prefs.notify || {})[c.parentId];
    const opt = (v, desc) => `<label class="radio-row"><input type="radio" name="lvl" value="${v}" ${levelOf(c) === v ? 'checked' : ''}><div><strong>${LEVEL_TEXT[v]}</strong><div class="sub">${desc}</div></div></label>`;
    modal(`Notify me about #${fullLabel(c)}`, `
      ${opt('all', 'Every new message in this channel, plus @mentions and replies to your threads.')}
      ${opt('mentions', 'Only when someone @mentions you, uses @here, or replies to a thread you are in.')}
      ${opt('mute', 'No notifications or sounds. Unread messages still show in the sidebar, just quietly.')}
      ${inherited ? `<p class="muted small">Following the setting on #${esc(S.channels[c.parentId]?.name || '')}.</p>` : ''}
      ${!c.parentId && Object.values(S.channels).some((x) => x.parentId === c.id) ? '<p class="muted small">Sub-channels follow this setting unless you change them individually.</p>' : ''}
      <div class="modal-actions"><button class="btn" id="open-settings">All notification settings</button><button class="btn-gold" data-close>Done</button></div>`);
    $('#modal-body').onchange = (e) => { if (e.target.name === 'lvl') savePrefs({ channelId: c.id, level: e.target.value }); };
    $('#open-settings').onclick = () => openSettings('notifications');
  }

  // ---------- Settings (notifications, profile, AI assistants) ----------
  function openSettings(tab = 'notifications') {
    const tabs = [['notifications', 'Notifications'], ['profile', 'Profile'], ...(S.me.isAdmin ? [['workspace', 'Workspace'], ['integrations', 'Integrations'], ['ai', 'AI & API']] : [])];
    modal('Settings', `<div class="tabs">${tabs.map(([k, t]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${t}</button>`).join('')}</div><div id="settings-body"></div>`);
    $('.tabs', $('#modal-body')).onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) openSettings(b.dataset.tab); };
    const body = $('#settings-body');
    if (tab === 'notifications') renderNotifySettings(body);
    if (tab === 'profile') renderProfileSettings(body);
    if (tab === 'ai') renderAISettings(body);
    if (tab === 'integrations') renderIntegrations(body);
    if (tab === 'workspace') renderWorkspaceSettings(body);
  }

  function renderIntegrations(body) {
    body.innerHTML = '<p class="muted">Loading…</p>';
    S.socket.emit('fub:status', {}, (r) => {
      if (r.error) { body.innerHTML = `<p class="error">${esc(r.error)}</p>`; return; }
      const st = r.status || {};
      const chans = Object.values(S.channels).filter((c) => !c.isDM && !c.archived).sort((a, b) => fullLabel(a).localeCompare(fullLabel(b)));
      const defaultChan = st.channelId || chans.find((c) => c.name === 'leads')?.id || chans[0]?.id;
      const chanName = st.channelId && S.channels[st.channelId] ? '#' + fullLabel(S.channels[st.channelId]) : '';
      const statusHtml = !st.connected ? '<div class="sub">Not connected.</div>' : `
        <div class="fub-status ${st.webhook ? 'ok' : 'warn'}">
          <div><strong>${st.webhook ? '✅ Live' : '⚠️ Connected, but lead alerts are not active yet'}</strong></div>
          <div class="sub">Account: ${esc(st.account)} · Key ${esc(st.keyHint)} · Posting to ${esc(chanName || '(choose a channel)')}</div>
          ${st.lastLeadAt ? `<div class="sub">Last lead posted ${fmtDay(st.lastLeadAt)} ${fmtTime(st.lastLeadAt)}</div>` : ''}
          ${st.webhookNote ? `<div class="sub" style="margin-top:6px">${esc(st.webhookNote)}</div>` : ''}
        </div>`;
      body.innerHTML = `
        <div class="set-block">
          <div class="int-head"><div class="int-logo">FUB</div><div><div class="set-title" style="margin:0">Follow Up Boss</div><div class="sub">Post every new lead to a channel, and @mention the assigned agent.</div></div></div>
          ${statusHtml}
          <div class="field" style="margin-top:12px">Follow Up Boss API key
            <input id="fub-key" type="password" autocomplete="off" placeholder="${st.connected ? 'Saved. Paste a new key to replace it' : 'Paste your API key'}"></div>
          <div class="sub" style="margin:-6px 0 12px">In Follow Up Boss: <strong>Admin → API → Create API Key</strong>. Use the <strong>account owner's</strong> login; only the owner can turn on lead alerts.</div>
          <div class="field">Post new leads in
            <select id="fub-chan">${chans.map((c) => `<option value="${c.id}" ${c.id === defaultChan ? 'selected' : ''}>#${esc(fullLabel(c))}</option>`).join('')}</select></div>
          <details class="adv"${st.systemKeySet ? ' open' : ''}><summary>Advanced: system key (only if Follow Up Boss asks for one)</summary>
            <div class="field" style="margin-top:8px"><input id="fub-sys" type="password" autocomplete="off" placeholder="${st.systemKeySet ? 'Saved' : 'X-System-Key from apps.followupboss.com/system-registration'}"></div></details>
          <p class="error" id="fub-err"></p>
          <div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap">
            <button class="btn-gold" id="fub-connect">${st.connected ? 'Save & reconnect' : 'Connect'}</button>
            ${st.connected ? '<button class="btn" id="fub-test">Post a test lead</button><button class="btn danger" id="fub-off">Disconnect</button>' : ''}
          </div>
        </div>
        ${st.connected ? `<div class="set-block">
          <div class="set-title">First steps for new leads</div>
          <div class="sub" style="margin-bottom:8px">Each new lead is posted with these steps. Teammates tap <strong>I'll take it</strong> to claim one and tick it off when done. One step per line; <code>{first}</code>, <code>{name}</code> and <code>{address}</code> are filled in automatically.</div>
          ${[['seller', '🏡 Seller leads'], ['buyer', '🔑 Buyer leads'], ['other', '🆕 Other leads']].map(([k, label]) => `
            <div class="pb">
              <div class="pb-head"><strong>${label}</strong><label class="pb-pin"><input type="checkbox" data-pin="${k}" ${st.playbooks?.[k]?.pin ? 'checked' : ''}> Pin until done</label></div>
              <textarea data-steps="${k}" rows="3">${esc((st.playbooks?.[k]?.steps || []).join('\n'))}</textarea>
            </div>`).join('')}
          <div class="modal-actions" style="justify-content:flex-start"><button class="btn-gold" id="pb-save">Save first steps</button></div>
        </div>` : ''}
        <div class="set-block">
          <div class="set-title">Other apps (Zapier, Make, website forms)</div>
          <div class="sub">Any app can post into Kaizen HQ with a key from <strong>AI & API</strong>:</div>
          <div class="copy-row"><code>POST ${esc(location.origin)}/api/v1/messages</code></div>
          <div class="sub">Header <code>Authorization: Bearer &lt;key&gt;</code> · Body <code>{"channel": "leads", "text": "New lead: …"}</code></div>
        </div>`;
      const err = (m) => { $('#fub-err').textContent = m || ''; };
      body.onclick = (e) => {
        if (e.target.id === 'fub-connect') {
          const apiKey = $('#fub-key').value.trim();
          if (!apiKey && !st.connected) return err('Paste your Follow Up Boss API key.');
          e.target.disabled = true; e.target.textContent = 'Connecting…'; err('');
          S.socket.emit('fub:connect', { apiKey: apiKey || null, systemKey: $('#fub-sys').value.trim() || undefined, channelId: $('#fub-chan').value, baseUrl: location.origin, keep: !apiKey }, (res) => {
            if (res.error) { err(res.error); e.target.disabled = false; e.target.textContent = 'Connect'; return; }
            toast(res.status.webhook ? 'Follow Up Boss connected' : 'Saved. See the note about lead alerts.');
            renderIntegrations(body);
          });
        }
        if (e.target.id === 'fub-test') {
          e.target.disabled = true; e.target.textContent = 'Posting…';
          S.socket.emit('fub:test', {}, (res) => { if (res.error) err(res.error); else toast('Test lead posted'); renderIntegrations(body); });
        }
        if (e.target.id === 'pb-save') {
          const pbs = {};
          for (const k of ['seller', 'buyer', 'other']) pbs[k] = { pin: body.querySelector(`[data-pin="${k}"]`).checked, steps: body.querySelector(`[data-steps="${k}"]`).value };
          S.socket.emit('fub:playbooks', { playbooks: pbs }, (res) => { if (res.error) err(res.error); else toast('First steps saved'); });
        }
        if (e.target.id === 'fub-off' && confirm('Disconnect Follow Up Boss? New leads will stop posting.')) {
          S.socket.emit('fub:disconnect', {}, () => { toast('Disconnected'); renderIntegrations(body); });
        }
      };
    });
  }

  function deviceStatus() {
    if (!pushSupported()) return isIOS && !isStandalone
      ? { text: 'On iPhone, add Kaizen HQ to your Home Screen first (Share → Add to Home Screen), then open it from there to turn on notifications.', action: null }
      : { text: 'This browser does not support notifications.', action: null };
    if (Notification.permission === 'granted') return { text: S.pushOn ? '✅ On for this device, including when the app is closed.' : '✅ Allowed on this device.', action: null };
    if (Notification.permission === 'denied') return { text: isIOS ? 'Blocked. Turn them on in iPhone Settings → Notifications → Kaizen HQ.' : 'Blocked. Turn them on in your browser or phone settings for this site, then reload.', action: null };
    return { text: 'Off for this device.', action: 'Turn on notifications' };
  }

  function renderNotifySettings(body) {
    const dev = deviceStatus();
    const pauseText = paused() ? `Paused until ${new Date(S.prefs.pauseUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Not paused';
    const chans = Object.values(S.channels).filter((c) => !c.isDM && !c.archived)
      .sort((a, b) => fullLabel(a).localeCompare(fullLabel(b), undefined, { numeric: true }));
    body.innerHTML = `
      <div class="set-block">
        <div class="set-title">This device</div>
        <div class="sub">${dev.text}</div>
        ${dev.action ? `<button class="btn-gold" id="enable-push" style="margin-top:10px">${dev.action}</button>` : ''}
        ${'Notification' in window && Notification.permission === 'granted' ? '<button class="btn" id="test-push" style="margin-top:10px">Send a test notification</button>' : ''}
      </div>
      <div class="set-block">
        <div class="set-title">Sound</div>
        <div class="sound-grid">${Object.entries(SOUND_NAMES).map(([k, n]) => `<button class="sound-opt${S.prefs.sound === k ? ' active' : ''}" data-sound="${k}">${k === 'none' ? '🔇' : '🔊'} ${n}</button>`).join('')}</div>
        <div class="sub" style="margin-top:6px">Plays while Kaizen HQ is open. When the app is closed, your phone uses its standard notification sound.</div>
      </div>
      <div class="set-block">
        <div class="set-title">Quiet hours</div>
        <div class="sub" style="margin-bottom:8px">No phone notifications during these hours. Everything waits for you in ☀️ Today and your morning summary.</div>
        <div class="time-row"><label class="check-row" style="margin:0"><input type="checkbox" id="q-on" ${S.prefs.quiet?.on !== false ? 'checked' : ''}> On</label>
          <span>from</span><input type="time" id="q-start" value="${esc(S.prefs.quiet?.start || '21:00')}"><span>to</span><input type="time" id="q-end" value="${esc(S.prefs.quiet?.end || '07:00')}"></div>
      </div>
      <div class="set-block">
        <div class="set-title">Daily summary</div>
        <div class="sub" style="margin-bottom:8px">One message each morning: what's overdue, due today, waiting for you, decisions needed and what the team finished yesterday.</div>
        <div class="time-row"><label class="check-row" style="margin:0"><input type="checkbox" id="s-on" ${S.prefs.summary?.on !== false ? 'checked' : ''}> Send it at</label>
          <input type="time" id="s-time" value="${esc(S.prefs.summary?.time || '07:30')}"><button class="btn small-btn" id="s-now">Send me one now</button></div>
      </div>
      <div class="set-block">
        <div class="set-title">Pause notifications</div>
        <div class="sub" style="margin-bottom:8px">${pauseText}</div>
        <div class="chip-row">
          <button class="chip" data-pause="30">30 min</button><button class="chip" data-pause="60">1 hour</button><button class="chip" data-pause="120">2 hours</button>
          <button class="chip" data-pause="tomorrow">Until tomorrow 8am</button>${paused() ? '<button class="chip" data-pause="0">Resume now</button>' : ''}
        </div>
      </div>
      <div class="set-block">
        <div class="set-title">Channels</div>
        ${chans.map((c) => `<div class="chan-pref${c.parentId ? ' child' : ''}"><span class="grow">${c.parentId ? '⌂ ' + esc(channelLabel(c)) : '# ' + esc(c.name)}</span>
          <select data-chan="${c.id}">${['all', 'mentions', 'mute'].map((v) => `<option value="${v}" ${levelOf(c) === v ? 'selected' : ''}>${v === 'all' ? 'All messages' : v === 'mentions' ? 'Mentions only' : 'Muted'}</option>`).join('')}</select></div>`).join('')}
        <div class="sub" style="margin-top:6px">Direct messages always notify you unless you mute that conversation.</div>
      </div>`;
    body.onclick = async (e) => {
      const snd = e.target.closest('[data-sound]');
      if (snd) { unlockAudio(); playSound(snd.dataset.sound); savePrefs({ sound: snd.dataset.sound }); S.prefs.sound = snd.dataset.sound; return renderNotifySettings(body); }
      const pz = e.target.closest('[data-pause]');
      if (pz) {
        let until = 0;
        if (pz.dataset.pause === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); until = d.getTime(); }
        else if (+pz.dataset.pause) until = Date.now() + +pz.dataset.pause * 60000;
        S.prefs.pauseUntil = until; savePrefs({ pauseUntil: until });
        toast(until ? 'Notifications paused' : 'Notifications resumed');
        return renderNotifySettings(body);
      }
      if (e.target.id === 'enable-push') { await enableNotifications(); return renderNotifySettings(body); }
      if (e.target.id === 'test-push') {
        const reg = await navigator.serviceWorker?.getRegistration();
        playSound(S.prefs.sound);
        const opts = { body: 'Notifications are working. 1% better every day.', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', tag: 'test' };
        if (reg) reg.showNotification('Kaizen HQ', opts); else new Notification('Kaizen HQ', opts);
      }
    };
    body.onchange = (e) => {
      const sel = e.target.closest('[data-chan]');
      if (sel) return savePrefs({ channelId: sel.dataset.chan, level: sel.value });
      if (['q-on', 'q-start', 'q-end'].includes(e.target.id)) { const quiet = { on: $('#q-on').checked, start: $('#q-start').value, end: $('#q-end').value }; S.prefs.quiet = quiet; savePrefs({ quiet }); toast('Quiet hours saved'); }
      if (['s-on', 's-time'].includes(e.target.id)) { const summary = { on: $('#s-on').checked, time: $('#s-time').value }; S.prefs.summary = summary; savePrefs({ summary }); toast('Daily summary saved'); }
    };
    $('#s-now').onclick = () => S.socket.emit('summary:now', {}, (r) => r?.error ? toast(r.error) : toast('Summary sent. Check your messages from Kaizen HQ'));
  }

  function renderProfileSettings(body) {
    body.innerHTML = `
      <div class="photo-row">${avatar(S.me, 'xl')}<div>
        <label class="btn photo-btn">📷 ${S.me.avatar ? 'Change photo' : 'Add a photo'}<input type="file" id="p-photo" accept="image/*" hidden></label>
        ${S.me.avatar ? '<button class="btn danger" id="p-photo-rm">Remove</button>' : ''}
        <div class="sub" style="margin-top:6px">Resized to a small thumbnail on your device before uploading, so the app stays fast.</div></div></div>
      <div class="field">Full name<input id="p-name" value="${esc(S.me.name)}" maxlength="60"></div>
      <div class="field">Role<input id="p-title" value="${esc(S.me.title || '')}" maxlength="60" placeholder="e.g. REALTOR®, Team Lead"></div>
      <div class="field">Status<input id="p-status" value="${esc(S.me.status || '')}" maxlength="80" placeholder="e.g. 🏡 At a listing appointment"></div>
      <div class="modal-actions"><button class="btn-gold" id="p-save">Save</button></div>`;
    $('#p-photo').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const dataUrl = await cropImage(f);
        if (!dataUrl) return openSettings('profile'); // cancelled
        const r = await upload({ kind: 'avatar', dataUrl });
        S.me.avatar = r.avatar; renderMe(); openSettings('profile'); toast('Photo updated');
      } catch (err) { toast(err.message); openSettings('profile'); }
    };
    if ($('#p-photo-rm')) $('#p-photo-rm').onclick = async () => { await upload({ kind: 'avatar', remove: true }); S.me.avatar = ''; renderMe(); renderProfileSettings(body); };
    $('#p-save').onclick = () => { S.socket.emit('profile:update', { name: $('#p-name').value, title: $('#p-title').value, status: $('#p-status').value }); closeModal(); toast('Profile updated'); };
  }

  function renderAISettings(body) {
    body.innerHTML = '<p class="muted">Loading…</p>';
    S.socket.emit('bot:list', {}, (r) => {
      if (r.error) { body.innerHTML = `<p class="error">${esc(r.error)}</p>`; return; }
      const url = location.origin + '/mcp';
      body.innerHTML = `
        <p class="sub" style="margin-top:0">Keys created here are your <strong>Kaizen HQ API keys</strong>. Use them to connect an AI assistant such as <strong>Grok</strong> through MCP, or to let Zapier and other apps post with <code>POST /api/v1/messages</code>. It can read channels, search, post, reply in threads and create sub-channels. It cannot see direct messages unless someone messages it directly.</p>
        <div class="set-block"><div class="set-title">Connection URL</div><div class="copy-row"><code>${esc(url)}</code><button class="btn" data-copy="${esc(url)}">Copy</button></div></div>
        <div class="set-block"><div class="set-title">Connected assistants</div>
          ${r.bots.length ? r.bots.map((b) => `<div class="list-row"><div class="avatar bot">✦</div><div class="grow"><strong>${esc(b.name)}</strong><div class="sub">Key ${esc(b.keyHint || '')} · ${b.lastUsed ? 'last used ' + fmtDay(b.lastUsed) + ' ' + fmtTime(b.lastUsed) : 'not used yet'}</div></div><button class="btn danger" data-revoke="${b.id}">Remove</button></div>`).join('') : '<p class="muted">None yet.</p>'}
        </div>
        <div class="set-block"><div class="set-title">Add an assistant</div>
          <div class="copy-row"><input id="bot-name" type="text" autocomplete="off" value="Grok" maxlength="40"><button class="btn-gold" id="bot-create">Create key</button></div>
          <div id="bot-new"></div>
        </div>`;
      body.onclick = (e) => {
        const cp = e.target.closest('[data-copy]');
        if (cp) { navigator.clipboard?.writeText(cp.dataset.copy).then(() => toast('Copied')); return; }
        const rv = e.target.closest('[data-revoke]');
        if (rv && confirm('Remove this assistant? Its key will stop working immediately.')) S.socket.emit('bot:revoke', { botId: rv.dataset.revoke }, () => renderAISettings(body));
        if (e.target.id === 'bot-create') {
          S.socket.emit('bot:create', { name: $('#bot-name').value }, (res) => {
            if (res.error) return toast(res.error);
            $('#bot-new').innerHTML = `<div class="key-box"><div class="set-title">🔑 ${esc(res.bot.name)}'s key: copy it now, it won't be shown again</div>
              <div class="copy-row"><code>${esc(res.key)}</code><button class="btn" data-copy="${esc(res.key)}">Copy</button></div>
              <div class="set-title" style="margin-top:12px">Grok chat (grok.com → Connectors → Custom): paste this one link</div>
              <div class="copy-row"><code>${esc(url + '/' + res.key)}</code><button class="btn" data-copy="${esc(url + '/' + res.key)}">Copy</button></div>
              <div class="sub">For Grok Bot, the xAI API or other MCP apps that support headers, use the URL <code>${esc(url)}</code> with header <code>Authorization: Bearer &lt;key&gt;</code> instead. Keep both private: anyone with them can read and post in your public channels.</div></div>`;
          });
        }
      };
    });
  }

  window.addEventListener('focus', () => viewing(S.current) && S.socket?.emit('read', { channelId: S.current }));

  // ---------- Typing ----------
  function onTyping({ channelId, parentId, userId }) {
    const key = channelId + (parentId ? ':' + parentId : '');
    S.typing[key] = S.typing[key] || {};
    clearTimeout(S.typing[key][userId]);
    S.typing[key][userId] = setTimeout(() => { delete S.typing[key][userId]; renderTyping(); }, 3500);
    renderTyping();
  }
  function clearTypingFor(channelId, userId) {
    for (const key of Object.keys(S.typing)) if (key.startsWith(channelId) && S.typing[key][userId]) { clearTimeout(S.typing[key][userId]); delete S.typing[key][userId]; }
    renderTyping();
  }
  function renderTyping() {
    const ids = Object.keys(S.typing[S.current] || {});
    const names = ids.map((id) => S.users[id]?.name.split(' ')[0]).filter(Boolean);
    $('#typing').textContent = !names.length ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
  }

  // ---------- Composer ----------
  function setupComposer(form, input, getTarget) {
    let lastTyping = 0;
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; };
    input.addEventListener('input', () => {
      grow();
      if (Date.now() - lastTyping > 2000 && input.value.trim()) { lastTyping = Date.now(); S.socket.emit('typing', getTarget()); }
      mentionAutocomplete(input);
    });
    input.addEventListener('keydown', (e) => {
      if (mentionKeys(e, input)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
      if (e.key === 'ArrowUp' && !input.value && input === $('#composer-input')) {
        const mine = (S.messages[S.current] || []).filter((m) => m.userId === S.me.id && !m.deleted).pop();
        const el = mine && document.querySelector(`#messages [data-mid="${mine.id}"]`);
        if (el) { e.preventDefault(); startEdit(el, mine); }
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      S.socket.emit('message:send', { ...getTarget(), text }, (r) => r?.error && toast(r.error));
      input.value = '';
      grow();
      hideMention();
    });
  }
  setupComposer($('#composer'), $('#composer-input'), () => ({ channelId: S.current }));
  setupComposer($('#thread-composer'), $('#thread-input'), () => ({ channelId: S.thread.channelId, parentId: S.thread.id }));

  // Mentions
  let mState = null;
  function mentionAutocomplete(input) {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const match = before.match(/(^|\s)@([\w]*)$/);
    if (!match) return hideMention();
    const q = match[2].toLowerCase();
    const opts = [...Object.values(S.users).filter((u) => u.name.toLowerCase().includes(q)).slice(0, 6), ...(['here', 'channel'].filter((x) => x.startsWith(q)).map((x) => ({ special: x })))];
    if (!opts.length) return hideMention();
    mState = { input, start: pos - q.length - 1, opts, sel: 0 };
    drawMention();
  }
  function drawMention() {
    const pop = $('#mention-pop');
    const form = mState.input.closest('form');
    if (pop.parentElement !== form) form.appendChild(pop);
    pop.innerHTML = mState.opts.map((o, i) => o.special
      ? `<div data-i="${i}" class="${i === mState.sel ? 'sel' : ''}"><strong>@${o.special}</strong> <span class="muted">Notify everyone in this channel</span></div>`
      : `<div data-i="${i}" class="${i === mState.sel ? 'sel' : ''}">${avatar(o, 'sm')}<strong>${esc(o.name)}</strong> <span class="muted">${esc(o.title || '')}</span></div>`).join('');
    pop.classList.remove('hidden');
    pop.onmousedown = (e) => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pickMention(+d.dataset.i); } };
  }
  function pickMention(i) {
    const o = mState.opts[i];
    const { input, start } = mState;
    const insert = '@' + (o.special || o.name) + ' ';
    input.value = input.value.slice(0, start) + insert + input.value.slice(input.selectionStart);
    input.selectionStart = input.selectionEnd = start + insert.length;
    input.focus();
    hideMention();
  }
  function mentionKeys(e, input) {
    if (!mState || mState.input !== input) return false;
    if (e.key === 'ArrowDown') { mState.sel = (mState.sel + 1) % mState.opts.length; drawMention(); e.preventDefault(); return true; }
    if (e.key === 'ArrowUp') { mState.sel = (mState.sel - 1 + mState.opts.length) % mState.opts.length; drawMention(); e.preventDefault(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mState.sel); e.preventDefault(); return true; }
    if (e.key === 'Escape') { hideMention(); return true; }
    return false;
  }
  function hideMention() { mState = null; $('#mention-pop').classList.add('hidden'); }

  // ---------- Thread panel ----------
  function openThread(id) {
    const m = findMsg(id);
    if (!m) return;
    S.socket.emit('thread', { messageId: id }, (r) => {
      if (r.error) return;
      S.thread = r.parent;
      S.threadReplies = r.replies;
      $('#panel').classList.remove('hidden');
      document.body.classList.add('thread-open');
      $('#thread-composer').classList.remove('hidden');
      const c = S.channels[r.parent.channelId];
      $('#panel-title').innerHTML = `Thread <span class="muted">${c.isDM ? esc(channelLabel(c)) : '#' + esc(fullLabel(c))}</span>`;
      renderThread(true);
      $('#thread-input').focus();
    });
  }
  function renderThread(scroll) {
    if (!S.thread || $('#panel').classList.contains('hidden') || $('#panel-title').textContent.startsWith('Search')) return;
    const n = S.threadReplies.length;
    let html = msgHTML(S.thread, false, true);
    html += `<div class="reply-sep">${n} ${n === 1 ? 'reply' : 'replies'}</div>`;
    let prev = null;
    for (const r of S.threadReplies) { html += msgHTML(r, prev && prev.userId === r.userId && r.ts - prev.ts < 300000, true); prev = r; }
    const body = $('#panel-body');
    body.innerHTML = html;
    if (scroll) body.scrollTop = body.scrollHeight;
  }
  $('#panel-close').addEventListener('click', () => { $('#panel').classList.add('hidden'); S.thread = null; document.body.classList.remove('thread-open'); });

  // ---------- Emoji picker ----------
  function emojiPicker(anchor, cb) {
    const pop = $('#emoji-pop');
    pop.innerHTML = EMOJI.map((e) => `<button>${e}</button>`).join('');
    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = 8 * 34 + 12;
    pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    pop.style.top = (r.bottom + 6 + 120 > window.innerHeight ? r.top - 90 : r.bottom + 6) + 'px';
    pop.onclick = (e) => { if (e.target.tagName === 'BUTTON') { cb(e.target.textContent); pop.classList.add('hidden'); } };
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!pop.contains(ev.target)) { pop.classList.add('hidden'); document.removeEventListener('click', off); } }), 0);
  }

  // ---------- Modals ----------
  function modal(title, html) {
    $('#sidebar').classList.remove('open');
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal-body').onclick = null;
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); }
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.hasAttribute('data-close')) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); $('#emoji-pop').classList.add('hidden'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.me) { e.preventDefault(); openSearch(); }
  });

  function channelModal(parentId = '') {
    const parents = Object.values(S.channels).filter((c) => !c.isDM && !c.parentId && !c.archived).sort((a, b) => a.name.localeCompare(b.name));
    const browse = Object.values(S.browse).filter((c) => !c.archived).sort((a, b) => fullLabel(a).localeCompare(fullLabel(b)));
    const archived = [...Object.values(S.channels), ...Object.values(S.browse)].filter((c) => c.archived && !c.isDM).sort((a, b) => fullLabel(a).localeCompare(fullLabel(b)));
    modal(parentId ? `New sub-channel in #${S.channels[parentId]?.name}` : 'Channels', `
      <div class="field">Put it under
        <select id="new-parent"><option value="">Nothing (a main channel)</option>${parents.map((c) => `<option value="${c.id}" ${c.id === parentId ? 'selected' : ''}># ${esc(c.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><span id="name-label">${parentId ? 'Address or name' : 'Channel name'}</span><input id="new-chan" type="text" autocomplete="off" autocorrect="off" autocapitalize="words" enterkeyhint="done" data-1p-ignore placeholder="${parentId ? 'e.g. 24 Juniper Crescent' : 'e.g. open-houses'}" maxlength="80"></div>
      <div class="field"><input id="new-topic" type="text" autocomplete="off" enterkeyhint="done" placeholder="What's it for? (optional)" maxlength="200"></div>
      <div class="field">Checklist
        <select id="new-template"><option value="">No checklist</option>${(S.templates || []).map((t) => `<option value="${esc(t.id)}">☑ ${esc(t.name)}</option>`).join('')}</select>
      </div>
      <div class="field">Who can see it?
        <div class="seg"><label><input type="radio" name="vis" value="open" checked> 🌐 Everyone</label><label><input type="radio" name="vis" value="private"> 🔒 Only people I choose</label></div>
      </div>
      <div id="vis-people" class="hidden"><div class="sub" style="margin-bottom:6px">Choose who can see it (you're included automatically):</div><div id="vis-pick"></div></div>
      <p class="sub" id="sub-hint" style="${parentId ? '' : 'display:none'}">Everyone in the main channel is added automatically. Archive it when the deal closes.</p>
      <p class="error" id="chan-err"></p>
      <div class="modal-actions"><button class="btn-gold" id="create-chan">Create</button></div>
      ${browse.length ? `<h4 class="modal-sub">Browse channels</h4>${browse.map((c) => `<div class="list-row" data-join="${c.id}"><div class="grow"><strong>${c.isPrivate ? '🔒' : c.parentId ? '⌂' : '#'} ${esc(fullLabel(c))}</strong><div class="sub">${esc(c.topic || '')}${c.topic ? ' · ' : ''}${c.memberCount} member${c.memberCount === 1 ? '' : 's'}</div></div><button class="btn">Join</button></div>`).join('')}` : ''}
      ${archived.length ? `<h4 class="modal-sub">Archived</h4>${archived.map((c) => `<div class="list-row" data-arch="${c.id}"><div class="grow"><strong>🗄 ${esc(fullLabel(c))}</strong><div class="sub">${esc(c.topic || '')}</div></div><button class="btn">${S.channels[c.id] ? 'Open' : 'Join'}</button></div>`).join('')}` : ''}`);
    $('#new-chan').focus();
    const syncVis = () => {
      const parent = S.channels[$('#new-parent').value];
      const forced = !!parent?.isPrivate;
      if (forced) document.querySelector('input[name=vis][value=private]').checked = true;
      document.querySelectorAll('input[name=vis]').forEach((r) => { r.disabled = forced; });
      const priv = document.querySelector('input[name=vis]:checked').value === 'private';
      $('#vis-people').classList.toggle('hidden', !priv);
      $('#sub-hint').textContent = priv ? 'Only the people you choose (and you) can see it. Archive it when the deal closes.' : 'Everyone in the main channel is added automatically. Archive it when the deal closes.';
      // Nobody is pre-selected, except when the main channel is itself private (then its members are).
      if (priv) $('#vis-pick').innerHTML = peoplePicker([S.me.id], parent?.isPrivate ? parent.members : []);
    };
    document.querySelectorAll('input[name=vis]').forEach((r) => r.addEventListener('change', syncVis));
    const pickTemplate = () => {
      const parent = S.channels[$('#new-parent').value];
      const want = parent?.name === 'listings' ? 'listing' : /open.?house/i.test(parent?.name || '') ? 'openhouse' : '';
      $('#new-template').value = (S.templates || []).some((t) => t.id === want) ? want : '';
    };
    pickTemplate();
    $('#new-parent').onchange = (e) => {
      pickTemplate();
      syncVis();
      const sub = !!e.target.value;
      $('#name-label').textContent = sub ? 'Address or name' : 'Channel name';
      $('#new-chan').placeholder = sub ? 'e.g. 24 Juniper Crescent' : 'e.g. open-houses';
      $('#sub-hint').style.display = sub ? '' : 'none';
    };
    const create = () => S.socket.emit('channel:create', { name: $('#new-chan').value, topic: $('#new-topic').value, parentId: $('#new-parent').value || null, templateId: $('#new-template').value, isPrivate: document.querySelector('input[name=vis]:checked').value === 'private', memberIds: pickedIds($('#modal-body')) }, (r) => {
      if (r.error) return ($('#chan-err').textContent = r.error);
      closeModal();
      setTimeout(() => openChannel(r.id), 50);
    });
    $('#create-chan').onclick = create;
    $('#new-chan').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } };
    $('#modal-body').onclick = (e) => {
      const row = e.target.closest('[data-join], [data-arch]');
      if (!row) return;
      const id = row.dataset.join || row.dataset.arch;
      if (S.channels[id]) { closeModal(); return openChannel(id); }
      S.socket.emit('channel:join', { channelId: id }, (r) => { if (r.id) { closeModal(); setTimeout(() => openChannel(r.id), 80); } });
    };
  }
  $('#channel-add').addEventListener('click', () => channelModal());

  function openDM(userId) {
    S.socket.emit('dm:open', { userId }, (r) => { if (r.id) setTimeout(() => openChannel(r.id), 50); });
  }
  function newDM() {
    const people = Object.values(S.users).sort((a, b) => a.name.localeCompare(b.name));
    modal('New message', `<input class="search-input" id="dm-filter" type="search" autocomplete="off" placeholder="Find a teammate"><div id="dm-people" style="margin-top:10px"></div>`);
    const draw = (q = '') => {
      $('#dm-people').innerHTML = people.filter((u) => u.name.toLowerCase().includes(q.toLowerCase())).map((u) =>
        `<div class="list-row" data-user="${u.id}">${avatar(u)}<div class="grow"><strong>${esc(u.name)}</strong>${u.isBot ? ` <span class="tag">${u.integration ? 'App' : 'AI'}</span>` : ''}${u.id === S.me.id ? ' <span class="muted">(you · notes to self)</span>' : ''}<div class="sub">${esc(u.title || '')}</div></div><span class="dot${S.online.has(u.id) ? ' on' : ''}"></span></div>`).join('') || '<p class="muted">No one found. Invite your teammates to create an account.</p>';
    };
    draw();
    $('#dm-filter').focus();
    $('#dm-filter').oninput = (e) => draw(e.target.value);
    $('#modal-body').onclick = (e) => { const r = e.target.closest('[data-user]'); if (r) { closeModal(); openDM(r.dataset.user); } };
  }
  $('#dm-add').addEventListener('click', newDM);

  $('#me-bar').addEventListener('click', () => openSettings('profile'));
  $('#settings-open').addEventListener('click', () => openSettings('notifications'));

  // ---------- Delete a channel ----------
  function deleteChannelModal(c) {
    const count = (S.messages[c.id] || []).length;
    const tasks = (c.checklist || []).length;
    modal(`Delete ${c.parentId ? '' : '#'}${fullLabel(c)}?`, `
      <div class="hand-box declined">This permanently deletes the channel${count ? `, its messages` : ''}${tasks ? ` and its ${tasks} checklist task${tasks === 1 ? '' : 's'}` : ''} for everyone. It can't be undone.</div>
      <p class="sub">Just finished with it? <b>Archive</b> instead: it disappears from the sidebar but stays searchable and can be brought back.</p>
      <div class="field">Type <b>DELETE</b> to confirm<input id="del-confirm" type="text" autocomplete="off" autocapitalize="characters" placeholder="DELETE"></div>
      <p class="error" id="del-err"></p>
      <div class="modal-actions"><button class="btn" id="del-archive">🗄 Archive instead</button><button class="btn danger-solid" id="del-go" disabled>Delete forever</button></div>`);
    const inp = $('#del-confirm');
    inp.focus();
    inp.oninput = () => { $('#del-go').disabled = inp.value.trim().toUpperCase() !== 'DELETE'; };
    $('#del-archive').onclick = () => S.socket.emit('channel:archive', { channelId: c.id, archived: true }, (r) => { if (r.error) return ($('#del-err').textContent = r.error); closeModal(); toast('Channel archived'); });
    $('#del-go').onclick = () => S.socket.emit('channel:delete', { channelId: c.id, confirm: inp.value }, (r) => {
      if (r.error) return ($('#del-err').textContent = r.error);
      closeModal(); toast(`Deleted ${fullLabel(c)}`);
    });
  }

  // ---------- Photo cropper: drag to position, slider / pinch / wheel to zoom ----------
  function cropImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('Please choose an image.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); };
      img.onload = () => {
        const V = Math.min(280, window.innerWidth - 80);   // size of the square viewport on screen
        const W = img.naturalWidth, H = img.naturalHeight;
        const base = V / Math.min(W, H);                     // smallest scale that fills the square
        let zoom = 1, scale = base, x = 0, y = 0;
        const clamp = () => {
          x = Math.min(0, Math.max(V - W * scale, x));
          y = Math.min(0, Math.max(V - H * scale, y));
        };
        // Start centred left-to-right, and near the top for portrait photos so heads aren't cut off.
        x = (V - W * scale) / 2;
        y = H > W ? (V - H * scale) * 0.15 : (V - H * scale) / 2;
        clamp();
        modal('Position your photo', `
          <div class="crop-wrap"><div class="crop-stage" id="crop-stage" style="width:${V}px;height:${V}px">
            <img id="crop-img" src="${url}" alt="" draggable="false"><div class="crop-ring"></div></div></div>
          <div class="crop-zoom"><span>－</span><input type="range" id="crop-zoom" min="1" max="4" step="0.01" value="1" aria-label="Zoom"><span>＋</span></div>
          <p class="sub" style="text-align:center;margin:4px 0 0">Drag to move · slide (or pinch) to zoom</p>
          <div class="modal-actions"><button class="btn" id="crop-cancel">Cancel</button><button class="btn-gold" id="crop-save">Use this photo</button></div>`);
        const el = $('#crop-img');
        const paint = () => { el.style.width = W * scale + 'px'; el.style.height = H * scale + 'px'; el.style.transform = `translate(${x}px, ${y}px)`; };
        const setZoom = (z, cx = V / 2, cy = V / 2) => {
          zoom = Math.min(4, Math.max(1, z));
          const ix = (cx - x) / scale, iy = (cy - y) / scale;      // keep the point under the finger/centre in place
          scale = base * zoom;
          x = cx - ix * scale; y = cy - iy * scale;
          clamp(); paint();
          $('#crop-zoom').value = zoom;
        };
        paint();
        const stage = $('#crop-stage');
        const pts = new Map();
        let last = null, pinch = null;
        stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = { x: e.clientX, y: e.clientY }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom }; } });
        stage.addEventListener('pointermove', (e) => {
          if (!pts.has(e.pointerId)) return;
          pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pts.size === 2 && pinch) {
            const [a, b] = [...pts.values()];
            const r = stage.getBoundingClientRect();
            setZoom(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
          } else if (pts.size === 1 && last) {
            x += e.clientX - last.x; y += e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
            clamp(); paint();
          }
        });
        const end = (e) => { pts.delete(e.pointerId); pinch = null; last = pts.size ? { ...[...pts.values()][0] } : null; };
        stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
        stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
        $('#crop-zoom').oninput = (e) => setZoom(Number(e.target.value));
        $('#crop-cancel').onclick = () => { URL.revokeObjectURL(url); resolve(null); };
        $('#crop-save').onclick = () => {
          const OUT = 256;
          const cv = document.createElement('canvas');
          cv.width = cv.height = OUT;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, OUT, OUT);
          ctx.drawImage(img, -x / scale, -y / scale, V / scale, V / scale, 0, 0, OUT, OUT);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL('image/jpeg', 0.88));
        };
      };
      img.src = url;
    });
  }

  // ---------- Branding & uploads ----------
  function renderBranding() {
    const b = S.branding;
    if (!b) return;
    const img = $('#ws-logo');
    if (b.logo) { img.src = b.logo; img.classList.remove('hidden'); } else img.classList.add('hidden');
    $('#ws-name').textContent = b.name;
    $('#ws-name').classList.toggle('hidden', !!b.logo && !b.showName);
    document.querySelector('.ws-brand').classList.toggle('has-logo', !!b.logo);
  }

  // Shrink a photo in the browser before upload (keeps files around 10–60 KB).
  function resizeImage(file, { size = 192, square = false, maxW = 600, maxH = 200, type = 'image/jpeg' } = {}) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('Please choose an image.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let sx = 0, sy = 0, sw = img.width, sh = img.height, w, h;
        if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; w = h = size; }
        else { const k = Math.min(1, maxW / sw, maxH / sh); w = Math.round(sw * k); h = Math.round(sh * k); }
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL(type, 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); };
      img.src = url;
    });
  }
  async function upload(body) {
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + store.get(TOKEN_KEY) }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    return data;
  }

  function renderWorkspaceSettings(body) {
    body.innerHTML = '<p class="muted">Loading…</p>';
    S.socket.emit('settings:get', {}, (st) => {
      if (st.error) { body.innerHTML = `<p class="error">${esc(st.error)}</p>`; return; }
      const b = S.branding || {};
      body.innerHTML = `
        <div class="set-block">
          <div class="set-title">Logo</div>
          <div class="logo-preview">${b.logo ? `<img src="${esc(b.logo)}" alt="">` : '<span class="muted">No logo yet. The workspace name is shown instead.</span>'}</div>
          <div class="chip-row" style="margin-top:8px">
            <label class="btn photo-btn">⬆️ ${b.logo ? 'Replace logo' : 'Upload logo'}<input type="file" id="ws-logo-file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${b.logo ? '<button class="btn danger" id="ws-logo-rm">Remove</button>' : ''}
            ${b.logo !== '/brand/logo.png' ? '<button class="btn" id="ws-logo-default">Use the Kaizen logo</button>' : ''}
          </div>
          <label class="check-row"><input type="checkbox" id="ws-show-name" ${st.showName ? 'checked' : ''}> Show the workspace name next to the logo</label>
          <div class="sub">Tip: a transparent PNG with light or gold artwork looks best on the dark sidebar.</div>
        </div>
        <div class="set-block">
          <div class="field">Workspace name<input id="ws-name-input" type="text" autocomplete="off" maxlength="40" value="${esc(st.workspaceName)}"></div>
        </div>
        <div class="set-block">
          <div class="set-title">Sign-up code</div>
          <div class="sub" style="margin-bottom:8px">New teammates need this code to create an account. Not case-sensitive.${st.envCode ? ' (Currently set on the server; saving here replaces it.)' : ''}</div>
          <div class="copy-row"><input id="ws-code" type="text" autocomplete="off" autocapitalize="off" maxlength="40" value="${esc(st.inviteCode)}" placeholder="e.g. a code only your team knows"></div>
          ${!st.inviteCode ? '<div class="error" style="margin-top:4px">⚠️ No code set: anyone with the link can sign up.</div>' : ''}
        </div>
        <div class="modal-actions"><button class="btn-gold" id="ws-save">Save</button></div>
        <div class="set-block">
          <div class="set-title">Checklists</div>
          <div class="sub" style="margin-bottom:8px">Used for listing sub-channels, open houses and any channel. Start a line with <code>#</code> for a section heading; every other line is a task.</div>
          <div id="tpl-list"></div>
          <div class="chip-row" style="margin-top:8px"><button class="btn" id="tpl-new">＋ New checklist</button><button class="btn-gold" id="tpl-save">Save checklists</button></div>
        </div>`;
      $('#ws-logo-file').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const dataUrl = await resizeImage(f, { maxW: 600, maxH: 200, type: 'image/png' });
          const r = await upload({ kind: 'logo', dataUrl });
          S.branding = r.branding; renderBranding(); renderWorkspaceSettings(body); toast('Logo updated');
        } catch (err) { toast(err.message); }
      };
      if ($('#ws-logo-default')) $('#ws-logo-default').onclick = async () => { const r = await upload({ kind: 'logo', reset: true }); S.branding = r.branding; renderBranding(); renderWorkspaceSettings(body); };
      if ($('#ws-logo-rm')) $('#ws-logo-rm').onclick = async () => { const r = await upload({ kind: 'logo', remove: true }); S.branding = r.branding; renderBranding(); renderWorkspaceSettings(body); };
      $('#ws-save').onclick = () => S.socket.emit('settings:update', { inviteCode: $('#ws-code').value, workspaceName: $('#ws-name-input').value, showName: $('#ws-show-name').checked }, (r) => r.error ? toast(r.error) : toast('Workspace saved'));
      // Checklist templates
      S.socket.emit('templates:get', {}, ({ templates }) => {
        const draw = (list) => {
          $('#tpl-list').innerHTML = list.map((t, i) => `<div class="pb" data-i="${i}">
            <div class="pb-head"><input class="tpl-name" value="${esc(t.name)}" maxlength="40" data-id="${esc(t.id || '')}"><button class="btn danger small-btn" data-del="${i}">Delete</button></div>
            <textarea class="tpl-text" rows="8">${esc(t.text || '')}</textarea></div>`).join('');
        };
        let list = templates;
        draw(list);
        const read = () => [...body.querySelectorAll('#tpl-list .pb')].map((el) => ({ id: el.querySelector('.tpl-name').dataset.id, name: el.querySelector('.tpl-name').value, text: el.querySelector('.tpl-text').value }));
        $('#tpl-new').onclick = () => { list = [...read(), { id: '', name: 'New checklist', text: '# Section\nFirst task' }]; draw(list); };
        $('#tpl-list').onclick = (e) => { const d = e.target.closest('[data-del]'); if (d && confirm('Delete this checklist template? Channels that already use it keep their tasks.')) { list = read().filter((_, i) => i !== +d.dataset.del); draw(list); } };
        $('#tpl-save').onclick = () => S.socket.emit('templates:save', { templates: read() }, (r) => r.error ? toast(r.error) : toast('Checklists saved'));
      });
    });
  }

  // ---------- Channel checklist panel ----------
  const isWide = () => window.matchMedia('(min-width: 1000px)').matches;
  const clPref = () => store.get('kaizenhq_cl') !== 'hidden';
  let clOpen = null; // explicit open/close for the current channel; null = automatic
  function clVisible() {
    const c = S.channels[S.current];
    if (!c || S.view !== 'channel') return false;
    if (c.isDM && !c.checklist?.length && clOpen === null) return false;
    if (clOpen !== null) return clOpen;
    return isWide() && !!c.checklist?.length && clPref();
  }
  function renderChecklist() {
    const c = S.channels[S.current];
    const panel = $('#checklist');
    const show = clVisible();
    panel.classList.toggle('hidden', !show);
    document.body.classList.toggle('cl-open', show);
    if (!show || !c) return;
    const list = c.checklist || [];
    const done = list.filter((t) => t.doneBy).length;
    $('#cl-title').textContent = c.isDM ? '☑ Tasks' : c.parentId ? `☑ ${c.label || c.name}` : `☑ #${c.name}`;
    $('#cl-progress').innerHTML = list.length ? `<span>${done} of ${list.length} done</span>${bar(pct(done, list.length))}` : '';
    const top = c.isDM ? '' : stageBarHTML(c) + linksHTML(c);
    const who = (id) => (id === S.me.id ? 'You' : S.users[id]?.name.split(' ')[0] || 'Someone');
    const day = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
    if (!list.length) {
      $('#cl-body').innerHTML = top + `<div class="cl-empty"><p>No checklist for this channel yet.</p>
        ${(S.templates || []).map((t) => `<button class="btn cl-tpl" data-apply="${esc(t.id)}">＋ ${esc(t.name)} checklist</button>`).join('')}
        <p class="sub">Or type your own tasks below.</p></div>`;
      return;
    }
    const sections = [];
    for (const t of list) {
      let s = sections.find((x) => x.name === (t.section || ''));
      if (!s) sections.push((s = { name: t.section || '', items: [] }));
      s.items.push(t);
    }
    const canRemove = (t) => t.addedBy === S.me.id || c.createdBy === S.me.id || S.me.isAdmin;
    $('#cl-body').innerHTML = top + sections.map((s) => `
      <div class="cl-section">
        ${s.name ? `<div class="cl-sec-head"><span>${esc(s.name)}</span><span>${s.items.filter((t) => t.doneBy).length}/${s.items.length}</span></div>` : ''}
        ${s.items.map((t) => `<div class="cl-item${t.doneBy ? ' done' : ''}">
          <button class="cl-check" data-toggle-item="${t.id}" aria-label="${t.doneBy ? 'Mark not done' : 'Mark done'}">${t.doneBy ? '✓' : ''}</button>
          <div class="cl-text"><span class="cl-label" data-open-item="${t.id}">${esc(t.label)}</span>${t.doneBy ? `<small>${esc(who(t.doneBy))} · ${day(t.doneAt)}</small>` : taskMetaHTML(t, { compact: true })}</div>
          ${canRemove(t) ? `<button class="cl-rm" data-rm-item="${t.id}" aria-label="Remove task" title="Remove task">✕</button>` : ''}
        </div>`).join('')}
      </div>`).join('') + `
      <div class="cl-more">
        <select id="cl-apply"><option value="">＋ Add tasks from a checklist…</option>${(S.templates || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
        ${c.createdBy === S.me.id || S.me.isAdmin ? '<button class="cl-link" id="cl-clear">Remove checklist</button>' : ''}
      </div>`;
  }
  $('#cl-body').addEventListener('click', (e) => {
    const c = S.channels[S.current];
    const tg = e.target.closest('[data-toggle-item]');
    if (tg) {
      // Update instantly, then confirm with the server.
      const it = c.checklist.find((x) => x.id === tg.dataset.toggleItem);
      if (it) { it.doneBy = it.doneBy ? null : S.me.id; it.doneAt = Date.now(); renderChecklist(); renderHeader(); if (it.doneBy) playSound('pop', 0.5); }
      return S.socket.emit('checklist:toggle', { channelId: c.id, itemId: tg.dataset.toggleItem }, (r) => r?.error && toast(r.error));
    }
    const op = e.target.closest('[data-open-item]');
    if (op) return openTaskEditor({ channelId: c.id, itemId: op.dataset.openItem });
    const st = e.target.closest('[data-stage]');
    if (st) {
      const target = STAGES.find((x) => x.id === st.dataset.stage);
      if (target.id === c.stage) return;
      const adds = !(c.appliedTemplates || []).includes(target.id) && (S.templates || []).some((t) => t.id === target.id);
      if (!confirm(`Move ${c.label || c.name} to "${target.label}"?${adds ? `\n\nThis adds the ${target.label} tasks to the checklist.` : ''}`)) return;
      return S.socket.emit('channel:stage', { channelId: c.id, stage: target.id }, (r) => r?.error ? toast(r.error) : toast(`Moved to ${target.label}`));
    }
    if (e.target.closest('#links-edit')) return linksModal(c);
    const rm = e.target.closest('[data-rm-item]');
    if (rm) return S.socket.emit('checklist:remove', { channelId: c.id, itemId: rm.dataset.rmItem }, (r) => r?.error && toast(r.error));
    const ap = e.target.closest('[data-apply]');
    if (ap) return S.socket.emit('checklist:apply', { channelId: c.id, templateId: ap.dataset.apply }, (r) => r?.error && toast(r.error));
    if (e.target.id === 'cl-clear' && confirm('Remove this whole checklist from the channel?')) S.socket.emit('checklist:clear', { channelId: c.id }, (r) => r?.error && toast(r.error));
  });
  $('#cl-body').addEventListener('change', (e) => {
    if (e.target.id !== 'cl-apply' || !e.target.value) return;
    const name = (S.templates || []).find((t) => t.id === e.target.value)?.name;
    if (confirm(`Add the "${name}" tasks to this checklist?`)) S.socket.emit('checklist:apply', { channelId: S.current, templateId: e.target.value }, (r) => r?.error ? toast(r.error) : toast(`${name} tasks added`));
    e.target.value = '';
  });
  $('#cl-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#cl-input').value.trim();
    if (!v) return;
    S.socket.emit('checklist:add', { channelId: S.current, label: v }, (r) => { if (r?.error) toast(r.error); else $('#cl-input').value = ''; });
  });
  $('#cl-btn').addEventListener('click', () => {
    clOpen = !clVisible();
    if (isWide()) store.set('kaizenhq_cl', clOpen ? 'shown' : 'hidden');
    renderChecklist(); renderHeader();
    if (clOpen && !S.channels[S.current]?.checklist?.length) $('#cl-input').focus();
  });
  $('#cl-close').addEventListener('click', () => {
    clOpen = false;
    if (isWide()) store.set('kaizenhq_cl', 'hidden');
    renderChecklist(); renderHeader();
  });
  window.addEventListener('resize', () => { if (S.me) { renderChecklist(); renderHeader(); } });

  // ---------- Tasks: Today screen, editor, stages, record links ----------
  const viewing = (id) => S.view === 'channel' && S.current === id;
  const STAGES = [{ id: 'listing', label: 'Listing' }, { id: 'offer', label: 'Offer accepted' }, { id: 'firm', label: 'Firm sale' }, { id: 'closing', label: 'Closing' }];
  const plainText = (t) => String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`~>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const firstName = (id) => (id === S.me.id ? 'You' : (S.users[id]?.name || 'Someone').split(' ')[0]);

  function dueInfo(ts) {
    if (!ts) return null;
    const d = new Date(ts), now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(d) - startOf(now)) / 864e5);
    const time = d.getHours() === 17 && d.getMinutes() === 0 ? '' : ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    let text, cls = '';
    if (ts < Date.now()) { cls = 'overdue'; text = days === 0 ? `Due today${time}` : `Overdue · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`; }
    else if (days === 0) { cls = 'today'; text = `Today${time}`; }
    else if (days === 1) text = `Tomorrow${time}`;
    else if (days < 7) text = d.toLocaleDateString([], { weekday: 'short' }) + time;
    else text = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return { text, cls };
  }

  function taskMetaHTML(t, { compact = false } = {}) {
    const bits = [];
    const due = dueInfo(t.dueAt);
    if (due) bits.push(`<span class="tchip due ${due.cls}">📅 ${esc(due.text)}</span>`);
    if (t.assigneeId) bits.push(`<span class="tchip owner">${avatar(S.users[t.assigneeId], 'xs')}${esc(firstName(t.assigneeId))}</span>`);
    if (t.handoff?.state === 'pending') bits.push(`<span class="tchip pending">⏳ Waiting for ${esc(firstName(t.assigneeId))} to accept</span>`);
    if (t.handoff?.state === 'declined' && t.assigneeId === S.me.id && !compact) bits.push(`<span class="tchip declined">↩️ ${esc(firstName(t.handoff.declinedBy))}: "${esc(t.handoff.reason)}"</span>`);
    if (t.blocked) bits.push(`<span class="tchip blocked" title="${esc(t.blocked.reason)}">⛔ ${esc(compact ? 'Blocked' : t.blocked.reason)}</span>`);
    if (t.sourceMessageId && compact) bits.push('<span class="tchip src">💬</span>');
    return bits.length ? `<span class="tmeta">${bits.join('')}</span>` : '';
  }

  function msgTaskChips(m) {
    const list = (S.channels[m.channelId]?.checklist || []).filter((t) => t.sourceMessageId === m.id);
    if (!list.length) return '';
    return `<div class="msg-tasks">${list.map((t) => `<button class="msg-task${t.doneBy ? ' done' : ''}" data-topen="${t.id}" data-ch="${m.channelId}">
      ${t.doneBy ? '✅' : '☑'} <b>${esc(t.label)}</b> ${t.assigneeId ? `· ${esc(firstName(t.assigneeId))}` : '· no owner'}${t.handoff?.state === 'pending' ? ' · ⏳ waiting to accept' : ''}${t.dueAt && !t.doneBy ? ` · ${esc(dueInfo(t.dueAt).text)}` : ''}</button>`).join('')}</div>`;
  }

  function stageBarHTML(c) {
    const isListing = c.stage || S.channels[c.parentId]?.name === 'listings';
    if (!isListing) return '';
    const idx = STAGES.findIndex((s) => s.id === (c.stage || 'listing'));
    return `<div class="stage-bar">${STAGES.map((s, i) => `<button class="stage${i < idx ? ' past' : ''}${i === idx ? ' current' : ''}" data-stage="${s.id}">${i < idx ? '✓ ' : ''}${esc(s.label)}</button>`).join('<span class="stage-sep">›</span>')}</div>`;
  }

  function linksHTML(c) {
    const l = c.links || {};
    const chips = [];
    if (l.fub) chips.push(`<a class="link-chip" href="${esc(l.fub)}" target="_blank" rel="noopener noreferrer">👤 Follow Up Boss</a>`);
    if (l.drive) chips.push(`<a class="link-chip" href="${esc(l.drive)}" target="_blank" rel="noopener noreferrer">📁 Drive folder</a>`);
    if (l.listing) chips.push(`<a class="link-chip" href="${esc(l.listing)}" target="_blank" rel="noopener noreferrer">🏠 Listing</a>`);
    if (l.other) chips.push(`<a class="link-chip" href="${esc(l.other)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(l.otherLabel || 'Link')}</a>`);
    const card = l.fubPersonId ? `<div class="fub-card" id="fub-card" data-person="${l.fubPersonId}"><span class="muted">Loading contact from Follow Up Boss…</span></div>` : '';
    if (l.fubPersonId) setTimeout(() => loadFubCard(c), 0);
    return `<div class="links-box"><div class="links-row">${chips.join('')}<button class="link-chip add" id="links-edit">${chips.length ? '✎ Links' : '＋ Add links: Follow Up Boss, Drive, listing'}</button></div>${card}</div>`;
  }

  const fubCardCache = {};
  function loadFubCard(c) {
    const id = c.links?.fubPersonId;
    const el = document.getElementById('fub-card');
    if (!id || !el) return;
    const paint = (p) => {
      const card = document.getElementById('fub-card');
      if (!card) return;
      if (!p || p.error) { card.innerHTML = `<span class="muted">${p?.error === 'Not found' ? 'Contact not found in Follow Up Boss.' : 'Could not load the contact right now.'}</span>`; return; }
      if (p.notConnected) { card.innerHTML = '<span class="muted">Connect Follow Up Boss in Settings → Integrations to see live contact details.</span>'; return; }
      card.innerHTML = `<div class="fub-top"><strong>${esc(p.name)}</strong>${p.stage ? `<span class="tchip">${esc(p.stage)}</span>` : ''}</div>
        <div class="sub">${[p.phone && `📞 <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`, p.email && `✉️ <a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`].filter(Boolean).join(' · ')}</div>
        <div class="sub">${[p.assignedTo && `Agent: ${esc(p.assignedTo)}`, p.source && `Source: ${esc(p.source)}`].filter(Boolean).join(' · ')}</div>
        <div class="fub-note">Live from Follow Up Boss, the client record. Update details there.</div>`;
    };
    const hit = fubCardCache[id];
    if (hit && Date.now() - hit.at < 60000) return paint(hit.p);
    S.socket.emit('fub:person', { channelId: c.id, personId: id }, (r) => { const p = r.person || { error: r.error }; fubCardCache[id] = { at: Date.now(), p }; paint(p); });
  }

  function linksModal(c) {
    const l = c.links || {};
    modal('Links to the original records', `
      <p class="sub" style="margin-top:0">Keep client details in Follow Up Boss. Link to them here instead of copying them.</p>
      <div class="field">👤 Follow Up Boss contact<input id="lk-fub" type="url" autocomplete="off" placeholder="https://…followupboss.com/2/people/view/12345" value="${esc(l.fub || '')}"></div>
      <div class="field">📁 Google Drive folder<input id="lk-drive" type="url" autocomplete="off" placeholder="https://drive.google.com/drive/folders/…" value="${esc(l.drive || '')}"></div>
      <div class="field">🏠 Listing (MLS / realtor.ca / website)<input id="lk-listing" type="url" autocomplete="off" placeholder="https://www.realtor.ca/…" value="${esc(l.listing || '')}"></div>
      <div class="goal-grid"><div class="field">🔗 Other link name<input id="lk-olabel" type="text" maxlength="30" placeholder="e.g. Showing feedback" value="${esc(l.otherLabel || '')}"></div>
        <div class="field">Other link<input id="lk-other" type="url" autocomplete="off" placeholder="https://…" value="${esc(l.other || '')}"></div></div>
      <p class="error" id="lk-err"></p>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn-gold" id="lk-save">Save links</button></div>`);
    $('#lk-save').onclick = () => S.socket.emit('channel:links', { channelId: c.id, links: { fub: $('#lk-fub').value, drive: $('#lk-drive').value, listing: $('#lk-listing').value, other: $('#lk-other').value, otherLabel: $('#lk-olabel').value } }, (r) => {
      if (r.error) return ($('#lk-err').textContent = r.error);
      closeModal(); toast('Links saved');
    });
  }

  // ----- Task editor (create from a message, or edit any task) -----
  function openTaskEditor({ channelId, itemId, create }) {
    const chId = create ? create.channelId : channelId;
    const c = S.channels[chId];
    if (!c) return toast('Open the channel first.');
    const t = create ? { label: create.label, assigneeId: S.me.id, dueAt: null, blocked: null, handoff: null, sourceMessageId: create.sourceMessageId }
      : (c.checklist || []).find((x) => x.id === itemId);
    if (!t) return toast('That task was removed.');
    const people = Object.values(S.users).filter((u) => !u.isBot && (c.members.includes(u.id) || (!c.isPrivate && !c.isDM))).sort((a, b) => a.name.localeCompare(b.name));
    const d = t.dueAt ? new Date(t.dueAt) : null;
    const pad = (n) => String(n).padStart(2, '0');
    const dateVal = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
    const timeVal = d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '17:00';
    const src = t.sourceMessageId ? (S.messages[chId] || []).find((m) => m.id === t.sourceMessageId) : null;
    const pending = t.handoff?.state === 'pending';
    modal(create ? '☑ New task' : '☑ Task', `
      <div class="field">Task<textarea id="te-label" rows="2" maxlength="200">${esc(t.label)}</textarea></div>
      <div class="goal-grid">
        <div class="field">Owner<select id="te-owner"><option value="">No owner yet</option>${people.map((u) => `<option value="${u.id}" ${u.id === t.assigneeId ? 'selected' : ''}>${esc(u.name)}${u.id === S.me.id ? ' (me)' : ''}${!c.members.includes(u.id) ? ' · will be added' : ''}</option>`).join('')}</select></div>
        <div class="field">Due<div class="due-row"><input id="te-date" type="date" value="${dateVal}"><input id="te-time" type="time" value="${timeVal}"></div></div>
      </div>
      <div class="field hidden" id="te-note-wrap">Note for the new owner<input id="te-note" type="text" maxlength="300" autocomplete="off" placeholder="Context so they can pick it up, e.g. where the files are"></div>
      <div class="sub" id="te-hand-hint" style="margin:-4px 0 10px"></div>
      ${pending ? `<div class="hand-box">⏳ Waiting for <b>${esc(firstName(t.assigneeId))}</b> to accept${t.handoff.note ? `: "${esc(t.handoff.note)}"` : ''}</div>` : ''}
      ${t.handoff?.state === 'declined' ? `<div class="hand-box declined">↩️ ${esc(firstName(t.handoff.declinedBy))} passed it back: "${esc(t.handoff.reason)}"</div>` : ''}
      <label class="check-row"><input type="checkbox" id="te-blocked" ${t.blocked ? 'checked' : ''}> ⛔ Blocked / needs a decision</label>
      <div class="field ${t.blocked ? '' : 'hidden'}" id="te-reason-wrap"><input id="te-reason" type="text" maxlength="300" autocomplete="off" placeholder="What's needed, e.g. Seller to decide on the price" value="${esc(t.blocked?.reason || '')}"></div>
      <div class="te-context">
        <span>${c.isDM ? '💬 Direct message' : `# ${esc(fullLabel(c))}`}</span>
        ${t.sourceMessageId ? `<button class="cl-link" id="te-src">💬 Open the original conversation</button>` : ''}
      </div>
      ${src ? `<blockquote class="te-quote">${esc(plainText(src.text)).slice(0, 220)}<br><small>${esc(S.users[src.userId]?.name || '')}</small></blockquote>` : ''}
      <p class="error" id="te-err"></p>
      <div class="modal-actions">
        ${!create && (t.addedBy === S.me.id || c.createdBy === S.me.id || S.me.isAdmin) ? '<button class="btn danger" id="te-del">Delete</button>' : ''}
        ${!create ? `<button class="btn" id="te-done">${t.doneBy ? 'Reopen' : '✓ Mark done'}</button>` : ''}
        <button class="btn-gold" id="te-save">${create ? 'Create task' : 'Save'}</button>
      </div>`);
    const syncHand = () => {
      const owner = $('#te-owner').value;
      const handing = owner && owner !== S.me.id && owner !== t.assigneeId;
      $('#te-note-wrap').classList.toggle('hidden', !handing);
      $('#te-hand-hint').textContent = handing ? `${S.users[owner]?.name.split(' ')[0]} will be asked to accept it. Until then it shows as waiting.` : '';
    };
    syncHand();
    $('#te-owner').onchange = syncHand;
    $('#te-blocked').onchange = () => $('#te-reason-wrap').classList.toggle('hidden', !$('#te-blocked').checked);
    if ($('#te-src')) $('#te-src').onclick = () => { closeModal(); jumpTo(chId, t.sourceMessageId); };
    const err = (m) => { $('#te-err').textContent = m || ''; };
    const dueValue = () => ($('#te-date').value ? new Date(`${$('#te-date').value}T${$('#te-time').value || '17:00'}`).getTime() : null);
    $('#te-save').onclick = () => {
      const label = $('#te-label').value.trim();
      if (!label) return err('Describe the task.');
      const blocked = $('#te-blocked').checked ? ($('#te-reason').value.trim() || 'Needs a decision') : null;
      if (create) {
        return S.socket.emit('task:create', { channelId: chId, label, assigneeId: $('#te-owner').value || null, dueAt: dueValue(), note: $('#te-note').value, sourceMessageId: t.sourceMessageId }, (r) => {
          if (r.error) return err(r.error);
          if (blocked) S.socket.emit('task:edit', { channelId: chId, itemId: r.itemId, blocked });
          closeModal(); toast('Task created');
        });
      }
      const patch = { channelId: chId, itemId };
      if (label !== t.label) patch.label = label;
      const due = dueValue();
      if (due !== (t.dueAt || null)) patch.dueAt = due;
      const owner = $('#te-owner').value || null;
      if (owner !== (t.assigneeId || null) || (owner && t.handoff?.state === 'declined' && owner !== S.me.id)) { patch.assigneeId = owner; patch.note = $('#te-note').value; }
      if ((blocked || null) !== (t.blocked?.reason || null)) patch.blocked = blocked;
      S.socket.emit('task:edit', patch, (r) => { if (r.error) return err(r.error); closeModal(); refreshToday(); toast('Task saved'); });
    };
    if ($('#te-done')) $('#te-done').onclick = () => S.socket.emit('task:edit', { channelId: chId, itemId, done: !t.doneBy }, (r) => { if (r.error) return err(r.error); closeModal(); if (!t.doneBy) playSound('pop', 0.5); });
    if ($('#te-del')) $('#te-del').onclick = () => { if (confirm('Delete this task?')) S.socket.emit('checklist:remove', { channelId: chId, itemId }, (r) => { if (r?.error) return err(r.error); closeModal(); }); };
  }

  // ----- Today -----
  let todayTimer = null;
  function refreshToday() {
    if (!S.socket) return;
    clearTimeout(todayTimer);
    todayTimer = setTimeout(() => {
      S.socket.emit('today:get', {}, (d) => { S.today = d; renderTodayBadge(); if (S.view === 'today') renderToday(); });
      if (S.me?.isAdmin) S.socket.emit('team:get', {}, (d) => { if (d.error) return; S.team = d; renderTeamBadge(); if (S.view === 'team') renderTeam(); });
    }, 120);
  }
  function renderTodayBadge() {
    const n = S.today?.count || 0;
    const b = $('#today-badge');
    b.textContent = n; b.classList.toggle('hidden', !n);
  }
  function showToday() {
    S.view = 'today';
    document.body.classList.remove('view-team');
    document.body.classList.add('view-today');
    $('#today-view').classList.remove('hidden');
    $('#sidebar').classList.remove('open');
    $('#panel').classList.add('hidden'); document.body.classList.remove('thread-open');
    renderChecklist();
    renderSidebar();
    renderToday();
    refreshToday();
  }
  $('#today-item').addEventListener('click', showToday);
  // On phones the Today/Team screens have their own ☰ button (the channel header is hidden there).
  $('#today-view').addEventListener('click', (e) => { if (e.target.closest('[data-menu]')) { e.stopPropagation(); $('#sidebar').classList.toggle('open'); } }, true);

  // ----- 📊 Team view (admins): everyone's workload, stuck handoffs, listing progress -----
  function renderTeamBadge() {
    const n = (S.team?.totals.overdue || 0) + (S.team?.handoffs.filter((h) => h.age > 864e5).length || 0);
    const b = $('#team-badge');
    b.textContent = n; b.classList.toggle('hidden', !n);
  }
  function showTeam() {
    S.view = 'team';
    document.body.classList.add('view-today', 'view-team');
    $('#today-view').classList.remove('hidden');
    $('#sidebar').classList.remove('open');
    $('#panel').classList.add('hidden'); document.body.classList.remove('thread-open');
    renderChecklist(); renderSidebar();
    if (!S.team) $('#today-view').innerHTML = '<div class="today-wrap"><h1 class="team-h">📊 Team</h1><p class="sub">Loading…</p></div>';
    else renderTeam();
    refreshToday();
  }
  $('#team-item').addEventListener('click', showTeam);
  const openPeople = new Set();
  const ago = (ms) => { const h = Math.round(ms / 3600e3); return h < 1 ? 'under 1h' : h < 48 ? `${h}h` : `${Math.round(h / 24)} days`; };

  function renderTeam() {
    const d = S.team;
    const el = $('#today-view');
    if (!d) return;
    const T = d.totals;
    const trend = T.doneWeek - T.doneLast;
    const wk = new Date(d.weekStart).toLocaleDateString([], { month: 'long', day: 'numeric' });
    const taskLine = (v, { showOwner = false, nudge = true } = {}) => {
      const due = dueInfo(v.dueAt);
      return `<div class="tm-task" data-ch="${v.channelId}" data-item="${v.itemId}">
        <span class="tm-label" data-edit>${esc(v.label)}</span>
        <span class="tm-meta">${showOwner && v.assigneeId ? `<span class="tchip owner">${avatar(S.users[v.assigneeId], 'xs')}${esc(firstName(v.assigneeId))}</span>` : ''}<span class="tchip chan">${v.isDM ? '💬' : '#'} ${esc(v.channelName)}</span>${due ? `<span class="tchip due ${due.cls}">📅 ${esc(due.text)}</span>` : ''}${v.handoff?.state === 'pending' ? '<span class="tchip pending">⏳ not accepted</span>' : ''}${v.blocked ? '<span class="tchip blocked">⛔ blocked</span>' : ''}
        ${nudge && v.assigneeId && v.assigneeId !== S.me.id ? '<button class="btn small-btn" data-nudge>👋 Nudge</button>' : ''}</span></div>`;
    };
    const personCard = (p) => {
      const open = openPeople.has(p.userId);
      const u = S.users[p.userId];
      return `<div class="tm-person${p.overdue ? ' has-overdue' : ''}" data-person="${p.userId}">
        <div class="tm-person-head" data-toggle-person>
          ${avatar(u)}<div class="grow"><strong>${esc(p.name)}</strong><div class="sub">${esc(p.title)}</div></div>
          <div class="tm-nums">
            <span title="Open tasks"><b>${p.open}</b> open</span>
            <span class="${p.overdue ? 'bad' : ''}" title="Overdue"><b>${p.overdue}</b> overdue</span>
            <span class="${p.toAccept ? 'warn' : ''}" title="Handed to them, not accepted yet"><b>${p.toAccept}</b> to accept</span>
            <span title="Finished this week"><b>${p.doneThisWeek}</b> done</span>
            ${p.leadSteps ? `<span title="Lead steps claimed, not done"><b>${p.leadSteps}</b> lead steps</span>` : ''}
          </div><span class="tm-caret">${open ? '▾' : '▸'}</span>
        </div>
        ${open ? `<div class="tm-tasks">${p.tasks.length ? p.tasks.slice(0, 30).map((v) => taskLine(v)).join('') : '<p class="muted" style="margin:6px 0">No open tasks.</p>'}</div>` : ''}
      </div>`;
    };
    const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label || 'Listing';
    const listingCard = (l) => {
      const p = pct(l.done, l.total);
      const next = l.next ? `${esc(l.next.label)}${l.next.assigneeId ? ` · ${esc(firstName(l.next.assigneeId))}` : ' · <em>no owner</em>'}${l.next.dueAt ? ` · ${esc(dueInfo(l.next.dueAt).text)}` : ''}` : 'All tasks done 🎉';
      const lk = l.links || {};
      return `<div class="tm-listing" data-listing="${l.channelId}">
        <div class="tm-l-head"><strong>${l.isPrivate ? '🔒 ' : '🏠 '}${esc(l.name)}</strong><span class="stage current">${esc(stageLabel(l.stage))}</span></div>
        <div class="agent-bar">${bar(p)}<span>${l.done}/${l.total}</span></div>
        <div class="tm-l-next"><span class="muted">Next:</span> ${next}</div>
        <div class="tm-meta">${l.overdue ? `<span class="tchip due overdue">⏰ ${l.overdue} overdue</span>` : ''}${l.blocked ? `<span class="tchip blocked">⛔ ${l.blocked} blocked</span>` : ''}
          ${l.owners.map((id) => `<span class="tchip owner">${avatar(S.users[id], 'xs')}${esc(firstName(id))}</span>`).join('')}
          <span class="rec-links">${[lk.fub && `<a href="${esc(lk.fub)}" target="_blank" rel="noopener noreferrer" title="Follow Up Boss">👤</a>`, lk.drive && `<a href="${esc(lk.drive)}" target="_blank" rel="noopener noreferrer" title="Drive folder">📁</a>`, lk.listing && `<a href="${esc(lk.listing)}" target="_blank" rel="noopener noreferrer" title="Listing">🏠</a>`].filter(Boolean).join('')}</span>
          ${l.lastActivity ? `<span class="tchip">💬 ${ago(Date.now() - l.lastActivity)} ago</span>` : ''}</div>
      </div>`;
    };
    el.innerHTML = `<div class="today-wrap team-wrap">
      <div class="today-head"><button class="icon-btn menu-btn" data-menu aria-label="Open menu">☰</button><div class="grow"><h1>📊 Team</h1><p class="sub">Week of ${esc(wk)} · who's carrying what, what's stuck, and where each listing stands</p></div>
        <button class="btn" id="team-refresh">↻ Refresh</button></div>
      <div class="today-stats team-stats">
        <div><b>${T.open}</b><span>open tasks${T.unassigned ? ` · <b class="inline-warn">${T.unassigned}</b> due soon with no owner` : ''}</span></div>
        <div class="${T.overdue ? 'bad' : ''}"><b>${T.overdue}</b><span>overdue</span></div>
        <div class="${T.notAccepted ? 'warn' : ''}"><b>${T.notAccepted}</b><span>not accepted</span></div>
        <div><b>${T.doneWeek}</b><span>done this week ${trend ? `<em class="${trend > 0 ? 'up' : 'down'}">${trend > 0 ? '▲' : '▼'} ${Math.abs(trend)} vs last</em>` : ''}</span></div>
        <div><b>${T.newLeads}</b><span>new leads${T.unclaimedSteps ? ` · ${T.unclaimedSteps} steps unclaimed` : ''}</span></div>
      </div>
      <section class="t-sec"><h3>👥 People <span>${d.people.length}</span></h3>${d.people.map(personCard).join('')}</section>
      ${d.handoffs.length ? `<section class="t-sec hot"><h3>🤝 Handoffs not accepted <span>${d.handoffs.length}</span></h3>${d.handoffs.map((h) => `<div class="tm-hand" data-ch="${h.channelId}" data-item="${h.itemId}">
          <div class="grow"><div class="tm-label" data-edit>${esc(h.label)}</div>
          <div class="sub">${esc(firstName(h.handoff.fromId))} → <b>${esc(firstName(h.assigneeId))}</b> · waiting ${ago(h.age)} · # ${esc(h.channelName)}</div></div>
          <button class="btn small-btn" data-nudge>👋 Nudge</button><button class="btn small-btn" data-edit>Reassign</button></div>`).join('')}</section>` : ''}
      ${d.blocked.length ? `<section class="t-sec"><h3>⛔ Decisions needed <span>${d.blocked.length}</span></h3>${d.blocked.map((v) => `<div class="tm-hand" data-ch="${v.channelId}" data-item="${v.itemId}"><div class="grow"><div class="tm-label" data-edit>${esc(v.label)}</div><div class="sub">⛔ ${esc(v.blocked.reason)} · # ${esc(v.channelName)}${v.assigneeId ? ` · ${esc(firstName(v.assigneeId))}` : ''}</div></div><button class="btn small-btn" data-edit>Open</button></div>`).join('')}</section>` : ''}
      <section class="t-sec"><h3>🏠 Listings <span>${d.listings.length}</span></h3>${d.listings.length ? `<div class="tm-listings">${d.listings.map(listingCard).join('')}</div>` : '<p class="muted">No listing channels yet. Create a sub-channel under #listings.</p>'}</section>
    </div>`;
    $('#team-refresh').onclick = () => { refreshToday(); toast('Refreshed'); };
  }

  $('#today-view').addEventListener('click', (e) => {
    if (S.view !== 'team' || e.target.closest('a')) return;
    const tp = e.target.closest('[data-toggle-person]');
    if (tp) { const id = tp.closest('[data-person]').dataset.person; openPeople.has(id) ? openPeople.delete(id) : openPeople.add(id); return renderTeam(); }
    const row = e.target.closest('[data-item]');
    if (row && e.target.closest('[data-nudge]')) {
      const b = e.target.closest('[data-nudge]'); b.disabled = true;
      return S.socket.emit('task:nudge', { channelId: row.dataset.ch, itemId: row.dataset.item }, (r) => { if (r.error) { toast(r.error); b.disabled = false; } else { b.textContent = '✓ Nudged'; toast('Nudge sent'); } });
    }
    if (row && e.target.closest('[data-edit]')) return openTaskEditor({ channelId: row.dataset.ch, itemId: row.dataset.item });
    const l = e.target.closest('[data-listing]');
    if (l) { openChannel(l.dataset.listing); clOpen = true; renderChecklist(); renderHeader(); }
  }, true);

  function todayRow(v, kind) {
    const due = dueInfo(v.dueAt);
    const l = v.links || {};
    const recLinks = [l.fub && `<a href="${esc(l.fub)}" target="_blank" rel="noopener noreferrer" title="Follow Up Boss">👤</a>`, l.drive && `<a href="${esc(l.drive)}" target="_blank" rel="noopener noreferrer" title="Drive folder">📁</a>`, l.listing && `<a href="${esc(l.listing)}" target="_blank" rel="noopener noreferrer" title="Listing">🏠</a>`].filter(Boolean).join('');
    let extra = '';
    if (kind === 'accept') extra = `${v.handoff.note ? `<div class="t-note">"${esc(v.handoff.note)}"</div>` : ''}<div class="t-actions"><button class="btn-gold small-btn" data-accept>Accept</button><button class="btn small-btn" data-decline>Pass it back…</button></div>`;
    if (kind === 'returned') extra = `<div class="t-note">↩️ ${esc(firstName(v.handoff.declinedBy))}: "${esc(v.handoff.reason)}"</div>`;
    if (kind === 'blocked') extra = `<div class="t-note">⛔ ${esc(v.blocked.reason)}${v.blocked.by ? ` · flagged by ${esc(firstName(v.blocked.by))}` : ''}</div>`;
    const who = kind === 'accept' ? `From ${esc(firstName(v.handoff.fromId))}` : kind === 'waiting' ? `With ${esc(firstName(v.assigneeId))} · ⏳ not accepted yet` : kind === 'blocked' && v.assigneeId ? esc(firstName(v.assigneeId)) : '';
    return `<div class="t-row" data-ch="${v.channelId}" data-item="${v.itemId}">
      ${kind === 'accept' || kind === 'waiting' ? '<span class="t-dot">🤝</span>' : '<button class="cl-check" data-tdone aria-label="Mark done"></button>'}
      <div class="t-main"><div class="t-label" data-topen-row>${esc(v.label)}</div>
        <div class="t-meta"><button class="tchip chan" data-goto>${v.isDM ? '💬' : '#'} ${esc(v.channelName)}</button>${due ? `<span class="tchip due ${due.cls}">📅 ${esc(due.text)}</span>` : ''}${who ? `<span class="tchip">${who}</span>` : ''}${v.sourceMessageId ? '<button class="tchip src" data-src>💬 conversation</button>' : ''}${recLinks ? `<span class="rec-links">${recLinks}</span>` : ''}</div>
        ${extra}</div></div>`;
  }

  function renderToday() {
    const el = $('#today-view');
    const d = S.today;
    const now = new Date();
    const hello = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
    if (!d) { el.innerHTML = `<div class="today-head"><h1>☀️ Today</h1><p class="sub">Loading…</p></div>`; return; }
    const sec = (icon, title, items, render, opts = {}) => items.length ? `<section class="t-sec ${opts.cls || ''}"><h3>${icon} ${title} <span>${items.length}</span></h3>${items.map(render).join('')}</section>` : '';
    const leadRow = (s, own) => `<div class="t-row" data-leadmsg="${s.messageId}" data-ch="${s.channelId}"><span class="t-dot">🏡</span><div class="t-main"><div class="t-label">${esc(s.label)}</div>
      <div class="t-meta">${s.lead ? `<span class="tchip">${esc(s.lead)}</span>` : ''}${s.url ? `<a class="tchip" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">👤 Follow Up Boss ↗</a>` : ''}<span class="tchip">${own ? 'You claimed it' : 'Needs an owner'}</span></div></div></div>`;
    const mentionRow = (m) => `<div class="t-row" data-mention="${m.messageId}" data-ch="${m.channelId}"><span class="t-dot">${avatar(S.users[m.from], 'xs')}</span><div class="t-main">
      <div class="t-label">${esc(S.users[m.from]?.name || 'Someone')} <span class="muted">in ${esc(m.channelName)}</span></div><div class="t-quote">${esc(plainText(m.text))}</div></div></div>`;
    const body = [
      sec('🤝', 'Waiting for you to accept', d.toAccept, (v) => todayRow(v, 'accept'), { cls: 'hot' }),
      sec('↩️', 'Passed back to you', d.returned, (v) => todayRow(v, 'returned')),
      sec('⏰', 'Overdue', d.overdue, (v) => todayRow(v), { cls: 'hot' }),
      sec('📅', 'Due today', d.dueToday, (v) => todayRow(v)),
      sec('⛔', 'Blocked / decisions needed', d.blocked, (v) => todayRow(v, 'blocked')),
      sec('💬', 'Mentions', d.mentions, mentionRow),
      sec('🏡', 'Your lead steps', d.leadSteps, (s) => leadRow(s, true)),
      sec('🆕', 'Lead steps with no owner', d.needOwner, (s) => leadRow(s, false)),
      sec('🗓', 'Coming up this week', d.upcoming, (v) => todayRow(v)),
      sec('📤', 'Waiting on others to accept', d.waitingOn, (v) => todayRow(v, 'waiting')),
      d.noDate.length ? `<details class="t-sec"><summary><h3>📝 No due date <span>${d.noDate.length}</span></h3></summary>${d.noDate.map((v) => todayRow(v)).join('')}</details>` : '',
    ].join('');
    const nothing = !d.toAccept.length && !d.overdue.length && !d.dueToday.length && !d.blocked.length && !d.mentions.length && !d.leadSteps.length && !d.returned.length;
    el.innerHTML = `<div class="today-wrap">
      <div class="today-head"><button class="icon-btn menu-btn" data-menu aria-label="Open menu">☰</button><div class="grow"><h1>☀️ ${hello}, ${esc(S.me.name.split(' ')[0])}</h1>
        <p class="sub">${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · just your assignments, deadlines and mentions${d.doneToday ? ` · ✅ ${d.doneToday} done today` : ''}</p></div>
        <button class="btn" id="today-new">＋ Task</button></div>
      <div class="today-stats">
        <div class="${d.toAccept.length ? 'warn' : ''}"><b>${d.toAccept.length}</b><span>to accept</span></div>
        <div class="${d.overdue.length ? 'bad' : ''}"><b>${d.overdue.length}</b><span>overdue</span></div>
        <div><b>${d.dueToday.length}</b><span>due today</span></div>
        <div><b>${d.mentions.length}</b><span>mentions</span></div>
      </div>
      ${nothing ? `<div class="today-clear">✨ You're all caught up. ${d.upcoming.length ? `${d.upcoming.length} task${d.upcoming.length === 1 ? '' : 's'} coming up this week.` : ''}</div>` : ''}
      ${body}</div>`;
    $('#today-new').onclick = () => {
      const c = S.channels[S.current] || Object.values(S.channels).find((x) => x.name === 'general');
      openTaskEditor({ create: { channelId: c.id, label: '', sourceMessageId: null } });
    };
  }

  $('#today-view').addEventListener('click', (e) => {
    if (S.view !== 'today') return;
    const row = e.target.closest('[data-ch]');
    if (!row || e.target.closest('a')) return;
    const ch = row.dataset.ch, item = row.dataset.item;
    if (e.target.closest('[data-accept]')) return S.socket.emit('task:respond', { channelId: ch, itemId: item, accept: true }, (r) => { refreshToday(); r.error ? toast(r.error) : toast('Accepted. It\'s yours'); });
    if (e.target.closest('[data-decline]')) {
      const reason = prompt('Pass it back with a short reason (e.g. "I\'m away Sunday, can Sarah do it?")');
      if (reason === null) return;
      return S.socket.emit('task:respond', { channelId: ch, itemId: item, accept: false, reason }, (r) => { refreshToday(); r.error ? toast(r.error) : toast('Passed back'); });
    }
    if (e.target.closest('[data-tdone]')) {
      e.target.closest('[data-tdone]').classList.add('ticking');
      playSound('pop', 0.5);
      return S.socket.emit('task:edit', { channelId: ch, itemId: item, done: true }, (r) => { refreshToday(); if (r.error) toast(r.error); });
    }
    if (e.target.closest('[data-goto]')) { openChannel(ch); clOpen = true; renderChecklist(); renderHeader(); return; }
    if (e.target.closest('[data-src]')) { const v = (S.channels[ch]?.checklist || []).find((x) => x.id === item); return v && jumpTo(ch, v.sourceMessageId); }
    if (row.dataset.mention) return jumpTo(ch, row.dataset.mention);
    if (row.dataset.leadmsg) return jumpTo(ch, row.dataset.leadmsg);
    if (item) openTaskEditor({ channelId: ch, itemId: item });
  });

  // ---------- Dashboard: forecast, goals, urgent, hot leads ----------
  const money = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + n;
  };
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const bar = (p) => `<div class="dash-bar"><span style="width:${Math.min(100, p)}%"></span></div>`;
  let dashCollapsed = store.get('kaizenhq_dash') === 'collapsed';

  function renderDashboard() {
    const d = S.dash;
    if (!d || !S.me) return;
    $('#dash').classList.toggle('collapsed', dashCollapsed);
    $('#dash-toggle').textContent = dashCollapsed ? '▸' : '▾';
    const t = d.team;
    const teamPct = pct(t.forecastGci, t.goalGci);
    $('#dash-forecast').innerHTML = `
      <div class="dash-label">📈 ${d.year} Forecast</div>
      <div class="dash-value">${money(t.forecastGci)}<small> GCI</small></div>
      <div class="dash-sub">${t.goalGci ? `${teamPct}% of ${money(t.goalGci)} goal` : 'Set goals to track progress'} · ${t.forecastDeals} deal${t.forecastDeals === 1 ? '' : 's'}</div>
      ${bar(teamPct)}`;
    const mine = d.agents.find((a) => a.userId === S.me.id) || { goalGci: 0, forecastGci: 0, goalDeals: 0, forecastDeals: 0 };
    const myPct = pct(mine.forecastGci, mine.goalGci);
    $('#dash-goal').innerHTML = mine.goalGci || mine.goalDeals ? `
      <div class="dash-label">🎯 Your ${d.year} goal <span class="dash-edit">Edit</span></div>
      <div class="dash-value">${money(mine.goalGci)}<small> · ${mine.goalDeals} deals</small></div>
      <div class="dash-sub">${myPct}% forecast · ${money(mine.forecastGci)} · ${mine.forecastDeals} deal${mine.forecastDeals === 1 ? '' : 's'}</div>
      ${bar(myPct)}` : `
      <div class="dash-label">🎯 Your ${d.year} goal</div>
      <div class="dash-value small">Set your goal</div>
      <div class="dash-sub">Tap to add your GCI and deal targets</div>`;
    const u = d.urgent;
    $('#dash-urgent').classList.toggle('calm', !u.length);
    $('#dash-urgent').innerHTML = `
      <div class="dash-label">⚠️ Urgent</div>
      <div class="dash-value">${u.length}<small> item${u.length === 1 ? '' : 's'}</small></div>
      <div class="dash-sub">${u.length ? esc(u[0].label) : 'All clear. Nice work.'}</div>`;
    renderTicker(d.hot);
  }

  function renderTicker(hot) {
    const track = $('#ticker-track');
    const sig = JSON.stringify(hot.map((h) => [h.name, h.detail, h.url]));
    if (track.dataset.sig === sig) return; // don't restart the scroll if nothing changed
    track.dataset.sig = sig;
    if (!hot.length) {
      track.classList.add('static');
      track.innerHTML = '<span class="tick muted-tick">No hot leads right now. Tag a lead <b>Hot</b> in Follow Up Boss, or tap 🔥 on a lead in #leads.</span>';
      return;
    }
    const item = (h) => h.url
      ? `<a class="tick" href="${esc(h.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(h.name)}</b>${h.detail ? `<span>${esc(h.detail)}</span>` : ''}<i>↗</i></a>`
      : `<button class="tick" data-msg="${h.messageId}" data-chan="${h.channelId}"><b>${esc(h.name)}</b>${h.detail ? `<span>${esc(h.detail)}</span>` : ''}</button>`;
    const once = hot.map(item).join('<span class="tick-sep">•</span>');
    track.classList.remove('static');
    track.innerHTML = `<div class="tick-run">${once}<span class="tick-sep">•</span></div><div class="tick-run" aria-hidden="true">${once}<span class="tick-sep">•</span></div>`;
    track.style.setProperty('--ticker-duration', Math.max(18, hot.length * 7) + 's');
  }
  $('#ticker-track').addEventListener('click', (e) => {
    const b = e.target.closest('[data-msg]');
    if (b) jumpTo(b.dataset.chan, b.dataset.msg);
  });
  // Pause the scroll while a finger is on it, so a lead can be tapped.
  $('#ticker-viewport').addEventListener('touchstart', () => $('#ticker-track').classList.add('paused'), { passive: true });
  $('#ticker-viewport').addEventListener('touchend', () => setTimeout(() => $('#ticker-track').classList.remove('paused'), 2500), { passive: true });
  $('#dash-toggle').addEventListener('click', () => {
    dashCollapsed = !dashCollapsed;
    store.set('kaizenhq_dash', dashCollapsed ? 'collapsed' : 'open');
    renderDashboard();
  });

  function forecastModal() {
    const d = S.dash;
    const t = d.team;
    const rows = [...d.agents].sort((a, b) => b.forecastGci - a.forecastGci).map((a) => {
      const p = pct(a.forecastGci, a.goalGci);
      const canEdit = a.userId === S.me.id || S.me.isAdmin;
      return `<div class="agent-row">
        <div class="agent-top"><strong>${esc(a.name)}${a.userId === S.me.id ? ' <span class="muted">(you)</span>' : ''}</strong>
          ${canEdit ? `<button class="btn small-btn" data-edit="${a.userId}">Edit</button>` : ''}</div>
        <div class="agent-nums"><span>Goal <b>${money(a.goalGci)}</b> · ${a.goalDeals} deals</span><span>Closed <b>${money(a.closedGci)}</b> · ${a.closedDeals}</span><span>Pending <b>${money(a.pendingGci)}</b> · ${a.pendingDeals}</span></div>
        <div class="agent-bar">${bar(p)}<span>${a.goalGci ? p + '%' : '·'}</span></div>
      </div>`;
    }).join('');
    modal(`${d.year} Team Forecast`, `
      <div class="fc-grid">
        <div><div class="dash-label">Closed</div><div class="fc-num">${money(t.closedGci)}</div><div class="sub">${t.closedDeals} deals</div></div>
        <div><div class="dash-label">Pending</div><div class="fc-num">${money(t.pendingGci)}</div><div class="sub">${t.pendingDeals} deals</div></div>
        <div><div class="dash-label">Forecast</div><div class="fc-num gold">${money(t.forecastGci)}</div><div class="sub">${t.forecastDeals} deals</div></div>
        <div><div class="dash-label">Goal</div><div class="fc-num">${money(t.goalGci)}</div><div class="sub">${t.goalDeals} deals</div></div>
      </div>
      ${bar(pct(t.forecastGci, t.goalGci))}
      <p class="sub">Forecast = closed + pending (firm or conditional) GCI. Each agent keeps their own numbers up to date.</p>
      <h4 class="modal-sub">Agents</h4>${rows || '<p class="muted">No agents yet.</p>'}`);
    $('#modal-body').onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) goalModal(b.dataset.edit); };
  }

  function goalModal(userId = S.me.id) {
    const a = S.dash.agents.find((x) => x.userId === userId) || {};
    const own = userId === S.me.id;
    const f = (key, label, prefix) => `<div class="field">${label}<div class="money-input">${prefix ? `<span>${prefix}</span>` : ''}<input data-g="${key}" inputmode="numeric" autocomplete="off" value="${a[key] ? Number(a[key]).toLocaleString('en-CA') : ''}" placeholder="0"></div></div>`;
    modal(own ? `Your ${S.dash.year} goal` : `${S.users[userId]?.name || 'Agent'}: ${S.dash.year} goal`, `
      <div class="goal-grid">
        ${f('goalGci', '🎯 Goal: GCI', '$')}${f('goalDeals', '🎯 Goal: deals')}
        ${f('closedGci', '✅ Closed so far: GCI', '$')}${f('closedDeals', '✅ Closed so far: deals')}
        ${f('pendingGci', '⏳ Pending: GCI', '$')}${f('pendingDeals', '⏳ Pending: deals')}
      </div>
      <p class="sub">Pending = firm or conditional deals that haven't closed yet. Your forecast is closed + pending.</p>
      <p class="error" id="goal-err"></p>
      <div class="modal-actions"><button class="btn" id="goal-back">Team forecast</button><button class="btn-gold" id="goal-save">Save</button></div>`);
    $('#modal-body').querySelectorAll('[data-g]').forEach((inp) => inp.addEventListener('input', () => {
      const digits = inp.value.replace(/[^\d]/g, '');
      inp.value = digits ? Number(digits).toLocaleString('en-CA') : '';
    }));
    $('#goal-back').onclick = forecastModal;
    $('#goal-save').onclick = () => {
      const values = {};
      $('#modal-body').querySelectorAll('[data-g]').forEach((inp) => { values[inp.dataset.g] = inp.value.replace(/[^\d]/g, '') || 0; });
      S.socket.emit('goal:update', { userId, values }, (r) => {
        if (r.error) return ($('#goal-err').textContent = r.error);
        closeModal(); toast('Goal saved');
      });
    };
  }

  function urgentModal() {
    const list = S.dash.urgent;
    const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
    modal('Urgent', `
      ${list.length ? list.map((u) => `<div class="urgent-row" ${u.kind === 'task' ? `data-jump="${u.messageId}" data-chan="${u.channelId}"` : u.kind === 'ctask' ? `data-ctask="${u.id}" data-chan="${u.channelId}"` : ''}>
        <div class="grow"><div><strong>${esc(u.label)}</strong></div>
          <div class="sub">${u.lead ? esc(u.lead) + ' · ' : ''}${esc(u.status)} · ${ago(u.since)} ago</div></div>
        ${u.kind === 'task' || u.kind === 'ctask' ? '<span class="go">Open ›</span>' : `${u.link ? `<a class="btn" href="${esc(u.link)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}<button class="btn" data-done="${u.id}">Done</button>`}
      </div>`).join('') : '<p class="muted">Nothing urgent. 🎉</p>'}
      <h4 class="modal-sub">Add an urgent item</h4>
      <div class="field"><input id="urg-text" type="text" autocomplete="off" maxlength="140" placeholder="e.g. Offer deadline for 24 Juniper at 5pm"></div>
      <div class="field"><input id="urg-link" type="url" autocomplete="off" placeholder="Link (optional), e.g. a Follow Up Boss or document link"></div>
      <div class="modal-actions"><button class="btn-gold" id="urg-add">Add</button></div>`);
    $('#urg-add').onclick = () => S.socket.emit('urgent:add', { text: $('#urg-text').value, link: $('#urg-link').value }, (r) => { if (r.error) toast(r.error); else { toast('Added to urgent'); setTimeout(urgentModal, 300); } });
    $('#urg-text').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#urg-add').click(); } };
    $('#modal-body').onclick = (e) => {
      const d = e.target.closest('[data-done]');
      if (d) return S.socket.emit('urgent:done', { id: d.dataset.done }, () => setTimeout(urgentModal, 300));
      const j = e.target.closest('[data-jump]');
      if (j && !e.target.closest('a, button')) { closeModal(); jumpTo(j.dataset.chan, j.dataset.jump); }
      const ct = e.target.closest('[data-ctask]');
      if (ct) { closeModal(); openTaskEditor({ channelId: ct.dataset.chan, itemId: ct.dataset.ctask }); }
    };
  }
  $('#dash-forecast').addEventListener('click', forecastModal);
  $('#dash-goal').addEventListener('click', () => goalModal());
  $('#dash-urgent').addEventListener('click', urgentModal);

  // ---------- Search ----------
  function resultRow(m) {
    const c = S.channels[m.channelId];
    const u = S.users[m.userId];
    return `<div class="result" data-goto="${m.parentId || m.id}" data-chan="${m.channelId}"><div class="meta">${c ? (c.isDM ? esc(channelLabel(c)) : '#' + esc(fullLabel(c))) : ''} · ${esc(u?.name || '')} · ${fmtDay(m.ts)} ${fmtTime(m.ts)}</div><div class="msg-text">${format(m.text)}</div>${m.tasks ? `<div class="meta" style="margin-top:4px">First steps: ${m.tasks.filter((t) => t.doneBy).length}/${m.tasks.length} done${m.tasks.some((t) => !t.claimedBy && !t.doneBy) ? ' · <strong>needs an owner</strong>' : ''}</div>` : ''}</div>`;
  }
  function bindResults() {
    $('#modal-body').onclick = (e) => {
      const r = e.target.closest('[data-goto]');
      if (!r) return;
      closeModal();
      jumpTo(r.dataset.chan, r.dataset.goto);
    };
  }
  function jumpTo(channelId, messageId) {
    openChannel(channelId);
    const tryFlash = (n = 0) => {
      const el = document.querySelector(`#messages [data-mid="${messageId}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
      else if (n < 10) setTimeout(() => tryFlash(n + 1), 150);
    };
    tryFlash();
  }
  function openSearch() {
    modal('Search', `<input class="search-input" id="search-q" type="search" autocomplete="off" enterkeyhint="search" placeholder="Search messages, e.g. offer, 24 Juniper, showing"><div id="search-res" style="margin-top:10px"></div>`);
    const q = $('#search-q');
    q.focus();
    let t;
    q.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => S.socket.emit('search', { q: q.value }, (r) => {
        const term = q.value.trim();
        $('#search-res').innerHTML = r.results.length
          ? r.results.map(resultRow).join('').replace(new RegExp(`(?![^<]*>)(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>')
          : term.length >= 2 ? '<p class="muted">No messages found.</p>' : '';
      }), 200);
    };
    bindResults();
  }
  $('#search-open').addEventListener('click', openSearch);

  // ---------- Mobile app: install, notifications, offline ----------
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = isIOS || /android/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installEvent = null;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open-channel' && S.channels[e.data.channelId]) openChannel(e.data.channelId);
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (S.me) setupAppBanners(); });
  window.addEventListener('appinstalled', () => $('#install-banner').classList.add('hidden'));
  document.addEventListener('visibilitychange', () => {
    S.socket?.emit('visible', { visible: !document.hidden });
    if (!document.hidden && viewing(S.current)) S.socket?.emit('read', { channelId: S.current });
  });

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const dismissed = (k) => +(store.get('kaizenhq_dismiss_' + k) || 0) > Date.now();

  function setupAppBanners() {
    // Install prompt
    const ib = $('#install-banner');
    if (!isStandalone && !dismissed('install') && isIOS) {
      $('#install-text').innerHTML = '📱 Add Kaizen HQ to your Home Screen: tap <svg class="share-icon" width="15" height="15" viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> <b>Share</b>, then <b>Add to Home Screen</b>. Notifications on iPhone work once it\'s added.';
      $('#install-btn').classList.add('hidden');
      ib.classList.remove('hidden');
    } else if (!isStandalone && !dismissed('install') && installEvent) {
      $('#install-text').textContent = '📱 Install Kaizen HQ as an app on this device. It opens full-screen from your home screen.';
      $('#install-btn').classList.remove('hidden');
      ib.classList.remove('hidden');
    } else ib.classList.add('hidden');

    // Notifications prompt (iPhone only allows this inside the installed app)
    const nb = $('#notify-banner');
    const canAsk = pushSupported() && Notification.permission === 'default' && (!isIOS || isStandalone);
    nb.classList.toggle('hidden', !canAsk || !!dismissed('notify'));
    if (pushSupported() && Notification.permission === 'granted') subscribePush();
    // First time on this device: ask right away instead of waiting for someone to find the banner.
    if (canAsk && !store.get('kaizenhq_asked_notify')) {
      store.set('kaizenhq_asked_notify', '1');
      modal('Stay in the loop', `<div class="notify-hero"><div class="bell-big">🔔</div>
        <p>Get notified the moment a teammate messages you, @mentions you, or posts in your channels, even when Kaizen HQ is closed.</p>
        <p class="sub">You choose which channels notify you and which sound plays in <strong>Settings → Notifications</strong>.</p></div>
        <div class="modal-actions"><button class="btn" data-close>Later</button><button class="btn-gold" id="hero-enable">Turn on notifications</button></div>`);
      $('#hero-enable').onclick = async () => { closeModal(); await enableNotifications(); };
    }
  }
  $('#install-btn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
    $('#install-banner').classList.add('hidden');
  });
  async function enableNotifications() {
    unlockAudio();
    const result = await Notification.requestPermission();
    $('#notify-banner').classList.add('hidden');
    if (result === 'granted') { await subscribePush(); playSound(S.prefs.sound); toast('Notifications are on'); }
    else toast('Notifications are off. You can turn them on later in Settings.');
  }
  $('#notify-btn').addEventListener('click', enableNotifications);
  document.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => {
    store.set('kaizenhq_dismiss_' + b.dataset.dismiss, String(Date.now() + 3 * 864e5));
    b.closest('.app-banner').classList.add('hidden');
  }));

  async function subscribePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { key } = await fetch('/api/push-key').then((r) => r.json());
        const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4));
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (ch) => ch.charCodeAt(0)) });
      }
      S.socket.emit('push:subscribe', { subscription: sub.toJSON() });
      S.pushOn = true;
    } catch (err) { console.warn('Push setup failed', err); }
  }

  // Feel like an app, not a web page: block pinch-zoom. (Double-tap zoom is turned off in CSS with
  // touch-action, which never interferes with typing the way blocking touch events can on iPhone.)
  ['gesturestart', 'gesturechange'].forEach((ev) => document.addEventListener(ev, (e) => { if (!e.target.closest?.('input, textarea, select')) e.preventDefault(); }, { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  initAuth();
})();
