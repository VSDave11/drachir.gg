const CACHE = 'drachir-v2';

self.addEventListener('install', e => {
  self.skipWaiting();
});

// ===== Web Push =====
self.addEventListener('push', e => {
  let d = { title: 'Drachir.gg', body: '', url: '/dashboard' };
  try { d = Object.assign(d, e.data.json()); } catch (_) { if (e.data) { try { d.body = e.data.text(); } catch (__) {} } }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: '/images/oddin-logo.png', badge: '/images/oddin-logo.png',
    data: { url: d.url || '/dashboard' }, tag: 'drachir-shift'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/dashboard';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cl => {
    for (const c of cl) { if (c.url.includes('/dashboard') && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
