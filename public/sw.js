// Kaizen HQ service worker: offline app shell + push notifications.
const CACHE = 'kaizenhq-v4';
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first (always fresh when online), cached shell when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Kaizen HQ', body: e.data?.text() || '' }; }
  // Unread count on the app icon (iPhone home-screen app, and desktop/Android where supported).
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
    (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {});
  }
  e.waitUntil(self.registration.showNotification(data.title || 'Kaizen HQ', {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { channelId: data.channelId },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const channelId = e.notification.data?.channelId;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'open-channel', channelId });
        return;
      }
    }
    await self.clients.openWindow('/' + (channelId ? '?c=' + encodeURIComponent(channelId) : ''));
  })());
});
