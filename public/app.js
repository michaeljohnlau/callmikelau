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
  };
  const EMOJI = ['👍', '🎉', '🔥', '🙌', '❤️', '😂', '👀', '✅', '🏡', '🔑', '💯', '🙏', '😮', '💪', '📈', '⭐'];

  // ---------- Auth ----------
  let mode = 'login';
  async function initAuth() {
    const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
    document.title = cfg.workspace || 'Kaizen HQ';
    $('#auth-title').textContent = cfg.workspace || 'Kaizen HQ';
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
      S.users = Object.fromEntries(d.users.map((u) => [u.id, u]));
      S.online = new Set(d.online);
      S.channels = Object.fromEntries(d.channels.map((c) => [c.id, c]));
      S.browse = Object.fromEntries(d.browse.map((c) => [c.id, c]));
      $('#ws-name').textContent = d.workspace;
      $('#auth').classList.add('hidden');
      $('#app').classList.remove('hidden');
      renderMe();
      renderSidebar();
      const fromLink = new URLSearchParams(location.search).get('c');
      if (fromLink) history.replaceState(null, '', '/');
      const last = store.get('kaizenhq_last');
      const start = [fromLink, last].find((id) => id && S.channels[id]) || (Object.values(S.channels).find((c) => c.name === 'general') || Object.values(S.channels)[0])?.id;
      S.messages = {};
      if (start) openChannel(start);
      socket.emit('visible', { visible: !document.hidden });
      setupAppBanners();
    });
    socket.on('presence', ({ userId, online }) => { online ? S.online.add(userId) : S.online.delete(userId); renderSidebar(); });
    socket.on('user:new', (u) => { S.users[u.id] = u; renderSidebar(); });
    socket.on('user:update', (u) => { S.users[u.id] = u; if (u.id === S.me.id) { S.me = u; renderMe(); } renderSidebar(); renderMessages(); renderThread(); });
    socket.on('message:new', onNewMessage);
    socket.on('message:update', onUpdateMessage);
    socket.on('typing', onTyping);
    socket.on('channel:joined', (c) => { S.channels[c.id] = c; delete S.browse[c.id]; renderSidebar(); });
    socket.on('channel:left', (c) => { delete S.channels[c.channelId]; S.browse[c.channelId] = { id: c.channelId, name: c.name, topic: c.topic, memberCount: c.memberCount }; if (S.current === c.channelId) openChannel(Object.keys(S.channels)[0]); renderSidebar(); });
    socket.on('channel:available', (c) => { if (!S.channels[c.id]) S.browse[c.id] = c; });
    socket.on('channel:members', ({ channelId, members }) => { if (S.channels[channelId]) { S.channels[channelId].members = members; if (channelId === S.current) renderHeader(); } });
    socket.on('channel:topic', ({ channelId, topic }) => { if (S.channels[channelId]) { S.channels[channelId].topic = topic; if (channelId === S.current) renderHeader(); } });
  }

  // ---------- Helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  function avatar(u, cls = '') {
    if (!u) return `<div class="avatar ${cls}" style="background:#ccc">?</div>`;
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
  function channelLabel(c) {
    if (!c.isDM) return c.name;
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
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1<em>$2</em>');
    s = s.replace(/~([^~\n]+)~/g, '<del>$1</del>');
    s = s.replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>');
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
    const chans = Object.values(S.channels).filter((c) => !c.isDM).sort((a, b) => a.name.localeCompare(b.name));
    const dms = Object.values(S.channels).filter((c) => c.isDM).sort((a, b) => channelLabel(a).localeCompare(channelLabel(b)));
    const item = (c) => {
      const active = c.id === S.current ? ' active' : '';
      const unread = c.unread && c.id !== S.current ? ' unread' : '';
      let icon = '<span class="hash">#</span>';
      if (c.isDM) {
        const other = c.members.find((id) => id !== S.me.id) || S.me.id;
        icon = `<span class="dot${S.online.has(other) ? ' on' : ''}"></span>`;
      }
      const badgeCount = c.isDM ? c.unread : c.mentions;
      const badge = badgeCount && c.id !== S.current ? `<span class="badge">${badgeCount}</span>` : '';
      return `<li class="side-item${active}${unread}" data-id="${c.id}">${icon}<span class="label">${esc(channelLabel(c))}</span>${badge}</li>`;
    };
    $('#channel-list').innerHTML = chans.map(item).join('');
    $('#dm-list').innerHTML = dms.map(item).join('') || '<li class="side-item muted" id="dm-empty"><span class="label">Start a conversation</span></li>';
    const total = Object.values(S.channels).reduce((n, c) => n + (c.id !== S.current ? (c.isDM ? c.unread : c.mentions) || 0 : 0), 0);
    document.title = (total ? `(${total}) ` : '') + ($('#ws-name').textContent || 'Kaizen HQ');
  }
  $('#channel-list').addEventListener('click', (e) => { const li = e.target.closest('[data-id]'); if (li) openChannel(li.dataset.id); });
  $('#dm-list').addEventListener('click', (e) => { const li = e.target.closest('[data-id]'); if (li) openChannel(li.dataset.id); else if (e.target.closest('#dm-empty')) newDM(); });
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // ---------- Channel ----------
  function openChannel(id) {
    if (!id || !S.channels[id]) return;
    S.current = id;
    store.set('kaizenhq_last', id);
    S.channels[id].unread = 0;
    S.channels[id].mentions = 0;
    S.socket.emit('read', { channelId: id });
    $('#sidebar').classList.remove('open');
    renderSidebar();
    renderHeader();
    renderTyping();
    const c = S.channels[id];
    $('#composer-input').placeholder = c.isDM ? `Message ${channelLabel(c)}` : `Message #${c.name}`;
    if (!S.messages[id]) {
      $('#messages').innerHTML = '';
      S.socket.emit('history', { channelId: id }, (r) => {
        if (r.error) return;
        S.messages[id] = r.messages;
        S.hasMore[id] = r.hasMore;
        if (S.current === id) { renderMessages(); scrollBottom(); }
      });
    } else { renderMessages(); scrollBottom(); }
    if (window.innerWidth > 760) $('#composer-input').focus();
  }
  function renderHeader() {
    const c = S.channels[S.current];
    if (!c) return;
    $('#chan-title').textContent = c.isDM ? channelLabel(c) : '# ' + c.name;
    const other = c.isDM && S.users[c.members.find((x) => x !== S.me.id)];
    $('#chan-topic').textContent = c.isDM ? (other ? [other.title, other.status].filter(Boolean).join(' · ') : '') : (c.topic || 'Add a topic');
    $('#members-btn').textContent = `👥 ${c.members.length}`;
  }
  $('#chan-topic').addEventListener('click', () => {
    const c = S.channels[S.current];
    if (!c || c.isDM) return;
    modal('Edit topic', `<div class="field"><input id="topic-input" value="${esc(c.topic || '')}" maxlength="200" placeholder="What is this channel for?"></div><div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn-gold" id="topic-save">Save</button></div>`);
    const inp = $('#topic-input'); inp.focus();
    const go = () => { S.socket.emit('channel:topic', { channelId: c.id, topic: inp.value }); closeModal(); };
    $('#topic-save').onclick = go; inp.onkeydown = (e) => e.key === 'Enter' && go();
  });
  $('#members-btn').addEventListener('click', () => {
    const c = S.channels[S.current];
    const rows = c.members.map((id) => S.users[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map((u) =>
      `<div class="list-row" data-user="${u.id}">${avatar(u)}<div class="grow"><div><strong>${esc(u.name)}</strong>${u.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</div><div class="sub">${esc(u.title || '')}${S.online.has(u.id) ? ' · <span style="color:var(--online)">Active</span>' : ''}</div></div></div>`).join('');
    const leave = !c.isDM && c.name !== 'general' ? `<div class="modal-actions"><button class="btn" id="leave-chan">Leave #${esc(c.name)}</button></div>` : '';
    modal(c.isDM ? 'Conversation' : `#${c.name}`, rows + leave);
    $('#modal-body').onclick = (e) => {
      const r = e.target.closest('[data-user]');
      if (r && r.dataset.user !== S.me.id) { closeModal(); openDM(r.dataset.user); }
      if (e.target.id === 'leave-chan') { S.socket.emit('channel:leave', { channelId: c.id }); closeModal(); }
    };
  });
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
    else html += `<div class="empty"><h3>${c.isDM ? esc(channelLabel(c)) : '#' + esc(c.name)}</h3><div>${c.isDM ? 'This is the start of your conversation.' : esc(c.topic || 'This is the very beginning of the channel.')}</div></div>`;
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
        <button data-act="pin" title="${m.pinned ? 'Unpin' : 'Pin'}">📌</button>
        ${mine ? '<button data-act="edit" title="Edit">✏️</button>' : ''}
        ${mine || S.me.isAdmin ? '<button data-act="delete" title="Delete">🗑️</button>' : ''}
      </div>`;
    const body = m.deleted ? '<div class="msg-deleted">This message was deleted.</div>' : `<div class="msg-text">${format(m.text)}${m.edited ? ' <span class="edited">(edited)</span>' : ''}</div>`;
    return `<div class="msg${cont ? ' cont' : ''}${!m.deleted && mentionsMe(m) && m.userId !== S.me.id ? ' mentioned' : ''}" data-mid="${m.id}">
      <div class="msg-gutter">${avatar(u, 'lg')}<div class="time-hover">${fmtTime(m.ts).replace(/\s?[AP]M/i, '')}</div></div>
      <div class="msg-body">
        ${m.pinned && !m.deleted ? '<div class="pin-flag">📌 Pinned</div>' : ''}
        <div class="msg-head"><span class="msg-author" data-user="${m.userId}">${esc(u?.name || 'Unknown')}</span>${u?.title ? `<span class="msg-role">${esc(u.title)}</span>` : ''}<span class="msg-time" title="${new Date(m.ts).toLocaleString()}">${fmtTime(m.ts)}</span></div>
        ${body}
        ${reactions || thread ? `<div class="reactions">${reactions}${reactions ? '<button class="reaction add" data-act="react" title="Add reaction">＋</button>' : ''}</div>${thread}` : ''}
      </div>
      ${actions}
    </div>`;
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
    const c = S.channels[m.channelId];
    if (!c) return;
    if (m.parentId) {
      if (S.thread?.id === m.parentId) { S.threadReplies.push(m); renderThread(true); }
    } else {
      if (S.messages[m.channelId]) S.messages[m.channelId].push(m);
      if (m.channelId === S.current) {
        renderMessages();
        scrollBottom(m.userId === S.me.id ? true : false);
        if (document.hasFocus()) S.socket.emit('read', { channelId: m.channelId });
      } else if (m.userId !== S.me.id) {
        c.unread = (c.unread || 0) + 1;
        if (mentionsMe(m)) c.mentions = (c.mentions || 0) + 1;
        renderSidebar();
      }
    }
    if (m.userId !== S.me.id && (c.isDM || mentionsMe(m)) && (!document.hasFocus() || m.channelId !== S.current)) notify(m, c);
    clearTypingFor(m.channelId, m.userId);
  }
  function onUpdateMessage(m) {
    const list = S.messages[m.channelId];
    if (list) { const i = list.findIndex((x) => x.id === m.id); if (i >= 0) list[i] = { ...list[i], ...m }; }
    if (S.thread?.id === m.id) S.thread = { ...S.thread, ...m };
    const ti = S.threadReplies.findIndex((x) => x.id === m.id);
    if (ti >= 0) S.threadReplies[ti] = { ...S.threadReplies[ti], ...m };
    if (m.channelId === S.current) { const box = $('#messages'); const top = box.scrollTop; renderMessages(); box.scrollTop = top; }
    renderThread();
  }
  function notify(m, c) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.hidden && S.pushOn) return; // the server's push notification covers this
    if (navigator.serviceWorker?.controller && isMobile) return; // phones only show notifications via push
    const u = S.users[m.userId];
    const n = new Notification(c.isDM ? u?.name : `${u?.name} in #${c.name}`, { body: m.text.slice(0, 140), tag: m.channelId });
    n.onclick = () => { window.focus(); openChannel(m.channelId); n.close(); };
  }
  window.addEventListener('focus', () => S.current && S.socket?.emit('read', { channelId: S.current }));

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
      $('#thread-composer').classList.remove('hidden');
      const c = S.channels[r.parent.channelId];
      $('#panel-title').innerHTML = `Thread <span class="muted">${c.isDM ? esc(channelLabel(c)) : '#' + esc(c.name)}</span>`;
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
  $('#panel-close').addEventListener('click', () => { $('#panel').classList.add('hidden'); S.thread = null; });

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

  $('#channel-add').addEventListener('click', () => {
    const browse = Object.values(S.browse).sort((a, b) => a.name.localeCompare(b.name));
    modal('Channels', `
      <div class="field">Create a new channel<input id="new-chan" placeholder="e.g. open-houses" maxlength="40"></div>
      <div class="field"><input id="new-topic" placeholder="What's it for? (optional)" maxlength="200"></div>
      <p class="error" id="chan-err"></p>
      <div class="modal-actions"><button class="btn-gold" id="create-chan">Create channel</button></div>
      ${browse.length ? `<h4 style="margin:18px 0 6px">Browse channels</h4>${browse.map((c) => `<div class="list-row" data-join="${c.id}"><div class="grow"><strong># ${esc(c.name)}</strong><div class="sub">${esc(c.topic || '')}${c.topic ? ' · ' : ''}${c.memberCount} member${c.memberCount === 1 ? '' : 's'}</div></div><button class="btn">Join</button></div>`).join('')}` : ''}`);
    $('#new-chan').focus();
    const create = () => S.socket.emit('channel:create', { name: $('#new-chan').value, topic: $('#new-topic').value }, (r) => {
      if (r.error) return ($('#chan-err').textContent = r.error);
      closeModal();
      setTimeout(() => openChannel(r.id), 50);
    });
    $('#create-chan').onclick = create;
    $('#new-chan').onkeydown = (e) => e.key === 'Enter' && create();
    $('#modal-body').onclick = (e) => {
      const row = e.target.closest('[data-join]');
      if (row) S.socket.emit('channel:join', { channelId: row.dataset.join }, (r) => { if (r.id) { closeModal(); setTimeout(() => openChannel(r.id), 50); } });
    };
  });

  function openDM(userId) {
    S.socket.emit('dm:open', { userId }, (r) => { if (r.id) setTimeout(() => openChannel(r.id), 50); });
  }
  function newDM() {
    const people = Object.values(S.users).sort((a, b) => a.name.localeCompare(b.name));
    modal('New message', `<input class="search-input" id="dm-filter" placeholder="Find a teammate"><div id="dm-people" style="margin-top:10px"></div>`);
    const draw = (q = '') => {
      $('#dm-people').innerHTML = people.filter((u) => u.name.toLowerCase().includes(q.toLowerCase())).map((u) =>
        `<div class="list-row" data-user="${u.id}">${avatar(u)}<div class="grow"><strong>${esc(u.name)}</strong>${u.id === S.me.id ? ' <span class="muted">(you · notes to self)</span>' : ''}<div class="sub">${esc(u.title || '')}</div></div><span class="dot${S.online.has(u.id) ? ' on' : ''}"></span></div>`).join('') || '<p class="muted">No one found. Invite your teammates to create an account.</p>';
    };
    draw();
    $('#dm-filter').focus();
    $('#dm-filter').oninput = (e) => draw(e.target.value);
    $('#modal-body').onclick = (e) => { const r = e.target.closest('[data-user]'); if (r) { closeModal(); openDM(r.dataset.user); } };
  }
  $('#dm-add').addEventListener('click', newDM);

  $('#me-bar').addEventListener('click', () => {
    modal('Your profile', `
      <div class="field">Full name<input id="p-name" value="${esc(S.me.name)}" maxlength="60"></div>
      <div class="field">Role<input id="p-title" value="${esc(S.me.title || '')}" maxlength="60" placeholder="e.g. REALTOR®, Team Lead"></div>
      <div class="field">Status<input id="p-status" value="${esc(S.me.status || '')}" maxlength="80" placeholder="e.g. 🏡 At a listing appointment"></div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn-gold" id="p-save">Save</button></div>`);
    $('#p-save').onclick = () => { S.socket.emit('profile:update', { name: $('#p-name').value, title: $('#p-title').value, status: $('#p-status').value }); closeModal(); toast('Profile updated'); };
  });

  // ---------- Search ----------
  function resultRow(m) {
    const c = S.channels[m.channelId];
    const u = S.users[m.userId];
    return `<div class="result" data-goto="${m.parentId || m.id}" data-chan="${m.channelId}"><div class="meta">${c ? (c.isDM ? esc(channelLabel(c)) : '#' + esc(c.name)) : ''} · ${esc(u?.name || '')} · ${fmtDay(m.ts)} ${fmtTime(m.ts)}</div><div class="msg-text">${format(m.text)}</div></div>`;
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
    modal('Search', `<input class="search-input" id="search-q" placeholder="Search messages, e.g. offer, 24 Juniper, showing"><div id="search-res" style="margin-top:10px"></div>`);
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
    if (!document.hidden && S.current) S.socket?.emit('read', { channelId: S.current });
  });

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const dismissed = (k) => store.get('kaizenhq_dismiss_' + k);

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
  }
  $('#install-btn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
    $('#install-banner').classList.add('hidden');
  });
  $('#notify-btn').addEventListener('click', async () => {
    const result = await Notification.requestPermission();
    $('#notify-banner').classList.add('hidden');
    if (result === 'granted') { await subscribePush(); toast('Notifications are on'); }
    else toast('Notifications are off. You can turn them on later in your device settings.');
  });
  document.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => {
    store.set('kaizenhq_dismiss_' + b.dataset.dismiss, '1');
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

  initAuth();
})();
