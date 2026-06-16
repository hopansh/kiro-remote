const CACHE = 'kiro-remote-v1';
const SHELL = ['/', '/manifest.json', '/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Clean up old caches
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Don't intercept WebSocket upgrades or hook calls
  if (e.request.url.includes('/mobile') || e.request.url.includes('/hook')) return;

  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Push notification for approval requests (when app is in background)
self.addEventListener('push', e => {
  const data = e.data?.json() ?? {};
  e.waitUntil(
    self.registration.showNotification('⚠️ Kiro needs approval', {
      body: data.command ?? 'A command needs your approval',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      requireInteraction: true,
      data: { url: self.location.origin }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url));
});
